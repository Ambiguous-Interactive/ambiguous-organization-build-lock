package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

const (
	baseRepository = "Ambiguous-Interactive/ambiguous-organization-build-lock"
	baseID         = int64(1244796436)
	headSHA        = "0123456789abcdef0123456789abcdef01234567"
)

func TestRunResolvesExactPullRequestWithoutEventAssociation(t *testing.T) {
	for _, testCase := range []struct {
		name           string
		headRepository string
		headID         int64
		pulls          []pullRequest
		want           int
	}{
		{name: "same repository", headRepository: baseRepository, headID: baseID, pulls: []pullRequest{fixturePull(11, headSHA, baseID, "main", baseID)}, want: 0},
		{name: "fork", headRepository: "contributor/build-lock", headID: 222, pulls: []pullRequest{fixturePull(12, headSHA, 222, "main", baseID)}, want: 0},
		{name: "Dependabot", headRepository: baseRepository, headID: baseID, pulls: []pullRequest{fixturePull(13, headSHA, baseID, "main", baseID)}, want: 0},
		{name: "empty association fallback", headRepository: "contributor/build-lock", headID: 222, pulls: nil, want: 2},
		{name: "ambiguous association", headRepository: baseRepository, headID: baseID, pulls: []pullRequest{fixturePull(14, headSHA, baseID, "main", baseID), fixturePull(15, headSHA, baseID, "main", baseID)}, want: 2},
		{name: "stale head", headRepository: baseRepository, headID: baseID, pulls: []pullRequest{fixturePull(16, strings.Repeat("a", 40), baseID, "main", baseID)}, want: 2},
		{name: "wrong base", headRepository: baseRepository, headID: baseID, pulls: []pullRequest{fixturePull(17, headSHA, baseID, "release", baseID)}, want: 2},
		{name: "wrong fork identity", headRepository: "contributor/build-lock", headID: 222, pulls: []pullRequest{fixturePull(18, headSHA, 333, "main", baseID)}, want: 2},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				if request.Header.Get("Authorization") != "Bearer test-token" || request.URL.Query().Get("base") != "main" {
					t.Fatalf("unexpected authenticated request: %s", request.URL.String())
				}
				response.Header().Set("Content-Type", "application/json")
				if err := json.NewEncoder(response).Encode(testCase.pulls); err != nil {
					t.Fatal(err)
				}
			}))
			defer server.Close()

			output := filepath.Join(t.TempDir(), "github-output")
			if err := os.WriteFile(output, nil, 0o600); err != nil {
				t.Fatal(err)
			}
			arguments := candidateArguments(testCase.headRepository, testCase.headID, output, server.URL)
			var stdout bytes.Buffer
			var stderr bytes.Buffer
			got := run(arguments, "test-token", &stdout, &stderr, server.Client())
			if got != testCase.want {
				t.Fatalf("exit = %d, want %d; stderr=%s", got, testCase.want, stderr.String())
			}
			written, err := os.ReadFile(output)
			if err != nil {
				t.Fatal(err)
			}
			if testCase.want == 0 && !strings.Contains(string(written), "should-audit=true") {
				t.Fatalf("missing success output: %q", written)
			}
		})
	}
}

func TestRunAcceptsOnlyExactCentralMainPush(t *testing.T) {
	for _, testCase := range []struct {
		name       string
		repository string
		id         int64
		branch     string
		want       int
	}{
		{name: "main", repository: baseRepository, id: baseID, branch: "main", want: 0},
		{name: "branch", repository: baseRepository, id: baseID, branch: "feature", want: 2},
		{name: "other repository", repository: "Ambiguous-Interactive/other", id: 999, branch: "main", want: 2},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			output := filepath.Join(t.TempDir(), "github-output")
			if err := os.WriteFile(output, nil, 0o600); err != nil {
				t.Fatal(err)
			}
			arguments := []string{
				"--event", "push", "--repository", baseRepository, "--repository-id", strconv.FormatInt(baseID, 10),
				"--head-repository", testCase.repository, "--head-repository-id", strconv.FormatInt(testCase.id, 10),
				"--head-sha", headSHA, "--head-branch", testCase.branch, "--github-output", output,
			}
			if got := run(arguments, "", ioDiscard{}, ioDiscard{}, http.DefaultClient); got != testCase.want {
				t.Fatalf("exit = %d, want %d", got, testCase.want)
			}
		})
	}
}

type ioDiscard struct{}

func (ioDiscard) Write(content []byte) (int, error) { return len(content), nil }

func candidateArguments(repository string, repositoryID int64, output, apiURL string) []string {
	return []string{
		"--event", "pull_request", "--repository", baseRepository, "--repository-id", strconv.FormatInt(baseID, 10),
		"--head-repository", repository, "--head-repository-id", strconv.FormatInt(repositoryID, 10),
		"--head-sha", headSHA, "--head-branch", "feature", "--github-output", output, "--api-url", apiURL,
	}
}

func fixturePull(number int, sha string, headRepositoryID int64, baseRef string, baseRepositoryID int64) pullRequest {
	value := pullRequest{Number: number, State: "open"}
	value.Head.SHA = sha
	value.Head.Repo.ID = headRepositoryID
	value.Base.Ref = baseRef
	value.Base.Repo.ID = baseRepositoryID
	return value
}
