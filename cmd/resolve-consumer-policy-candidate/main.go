package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
)

const maxPullRequestPages = 100

var (
	repositoryPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
	shaPattern        = regexp.MustCompile(`^[0-9a-f]{40}$`)
)

type candidate struct {
	event            string
	repository       string
	repositoryID     int64
	headRepository   string
	headRepositoryID int64
	headSHA          string
	headBranch       string
}

type pullRequest struct {
	Number int    `json:"number"`
	State  string `json:"state"`
	Head   struct {
		SHA  string `json:"sha"`
		Repo struct {
			ID int64 `json:"id"`
		} `json:"repo"`
	} `json:"head"`
	Base struct {
		Ref  string `json:"ref"`
		Repo struct {
			ID int64 `json:"id"`
		} `json:"repo"`
	} `json:"base"`
}

func main() {
	os.Exit(run(os.Args[1:], os.Getenv("GH_TOKEN"), os.Stdout, os.Stderr, http.DefaultClient))
}

func run(arguments []string, token string, stdout, stderr io.Writer, client *http.Client) int {
	flags := flag.NewFlagSet("resolve-consumer-policy-candidate", flag.ContinueOnError)
	flags.SetOutput(stderr)
	event := flags.String("event", "", "source workflow event")
	repository := flags.String("repository", "", "base repository")
	repositoryID := flags.String("repository-id", "", "base repository ID")
	headRepository := flags.String("head-repository", "", "source head repository")
	headRepositoryID := flags.String("head-repository-id", "", "source head repository ID")
	headSHA := flags.String("head-sha", "", "source head SHA")
	headBranch := flags.String("head-branch", "", "source head branch")
	githubOutput := flags.String("github-output", "", "GitHub Actions output file")
	apiURL := flags.String("api-url", "https://api.github.com", "GitHub API URL")
	if err := flags.Parse(arguments); err != nil || flags.NArg() != 0 {
		return 2
	}
	baseID, baseErr := positiveID(*repositoryID)
	headID, headErr := positiveID(*headRepositoryID)
	value := candidate{
		event:            *event,
		repository:       *repository,
		repositoryID:     baseID,
		headRepository:   *headRepository,
		headRepositoryID: headID,
		headSHA:          *headSHA,
		headBranch:       *headBranch,
	}
	if baseErr != nil || headErr != nil || !repositoryPattern.MatchString(value.repository) ||
		!repositoryPattern.MatchString(value.headRepository) || !shaPattern.MatchString(value.headSHA) ||
		*githubOutput == "" {
		fmt.Fprintln(stderr, "source workflow candidate identity is invalid")
		return 2
	}

	prNumber := ""
	switch value.event {
	case "push":
		if value.headBranch != "main" || value.headRepository != value.repository || value.headRepositoryID != value.repositoryID {
			fmt.Fprintln(stderr, "source push must be the exact central main branch")
			return 2
		}
	case "pull_request":
		if token == "" {
			fmt.Fprintln(stderr, "GitHub token is required to resolve a pull request")
			return 2
		}
		matches, err := matchingPullRequests(context.Background(), client, strings.TrimRight(*apiURL, "/"), token, value)
		if err != nil {
			fmt.Fprintln(stderr, "cannot resolve the exact source pull request")
			return 2
		}
		if len(matches) != 1 {
			fmt.Fprintf(stderr, "expected one open main-target pull request for the exact source head; found %d\n", len(matches))
			return 2
		}
		prNumber = strconv.Itoa(matches[0].Number)
	default:
		fmt.Fprintln(stderr, "source workflow event must be pull_request or push")
		return 2
	}

	file, err := os.OpenFile(*githubOutput, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		fmt.Fprintln(stderr, "cannot open GitHub output file")
		return 2
	}
	if _, err := fmt.Fprintf(file, "pr-number=%s\nshould-audit=true\n", prNumber); err != nil {
		_ = file.Close()
		fmt.Fprintln(stderr, "cannot write GitHub output file")
		return 2
	}
	if err := file.Close(); err != nil {
		fmt.Fprintln(stderr, "cannot close GitHub output file")
		return 2
	}
	fmt.Fprintln(stdout, "Resolved exact current consumer policy candidate.")
	return 0
}

func positiveID(value string) (int64, error) {
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("invalid ID")
	}
	return parsed, nil
}

func matchingPullRequests(ctx context.Context, client *http.Client, apiURL, token string, value candidate) ([]pullRequest, error) {
	result := make([]pullRequest, 0, 1)
	for page := 1; page <= maxPullRequestPages; page++ {
		endpoint, err := url.Parse(apiURL + "/repos/" + value.repository + "/pulls")
		if err != nil {
			return nil, err
		}
		query := endpoint.Query()
		query.Set("state", "open")
		query.Set("base", "main")
		query.Set("per_page", "100")
		query.Set("page", strconv.Itoa(page))
		endpoint.RawQuery = query.Encode()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
		if err != nil {
			return nil, err
		}
		request.Header.Set("Accept", "application/vnd.github+json")
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		response, err := client.Do(request)
		if err != nil {
			return nil, err
		}
		var pageValues []pullRequest
		decodeErr := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&pageValues)
		closeErr := response.Body.Close()
		if response.StatusCode != http.StatusOK || decodeErr != nil || closeErr != nil {
			return nil, fmt.Errorf("GitHub pull request lookup failed")
		}
		for _, pull := range pageValues {
			if pull.State == "open" && pull.Head.SHA == value.headSHA && pull.Head.Repo.ID == value.headRepositoryID &&
				pull.Base.Ref == "main" && pull.Base.Repo.ID == value.repositoryID {
				result = append(result, pull)
			}
		}
		if len(pageValues) < 100 {
			return result, nil
		}
	}
	return nil, fmt.Errorf("GitHub pull request pagination exceeds policy limit")
}
