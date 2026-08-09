// Package githubissue provides the bounded GitHub issue synchronization
// mechanics shared by the repository's fail-closed monitors.
package githubissue

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	DefaultResponseLimit = 4 << 20
	// GitHub permits 64 KiB issue bodies. JSON escaping can expand one input
	// byte to six response bytes. Five such bodies leave over 2 MiB for the
	// issue-list envelope while remaining below the 4 MiB response bound.
	DefaultPageSize = 5
	// Preserve the previous 1,200 automation-authored-issue discovery window.
	DefaultMaxPages = 240
	DefaultTimeout  = 20 * time.Second
)

var (
	repositoryPattern         = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
	canonicalIssuePathPattern = regexp.MustCompile(`^/repositories/[1-9][0-9]*/issues$`)
)

// Options configures a client for exactly one repository.
type Options struct {
	APIURL        string
	Repository    string
	Token         string
	UserAgent     string
	HTTPClient    *http.Client
	ResponseLimit int
	PageSize      int
	MaxPages      int
	Timeout       time.Duration
}

// Client is a same-origin, bounded GitHub API client.
type Client struct {
	base          *url.URL
	repository    string
	token         string
	userAgent     string
	http          *http.Client
	responseLimit int
	pageSize      int
	maxPages      int
}

// Issue is the bounded subset of issue evidence needed for synchronization.
type Issue struct {
	Number      int             `json:"number"`
	State       string          `json:"state"`
	Title       string          `json:"title"`
	Body        string          `json:"body"`
	PullRequest json.RawMessage `json:"pull_request"`
	User        struct {
		Login string `json:"login"`
	} `json:"user"`
}

// Identity identifies an automation-owned issue. Title matching is optional
// because some monitors intentionally allow operators to rename an alert.
type Identity struct {
	Marker       string
	Author       string
	Title        string
	RequireTitle bool
}

// Desired describes the issue state a monitor has independently decided on.
type Desired struct {
	State               string
	Title               string
	Body                string
	PreserveBodyOnClose bool
	ClosedIsTerminal    bool
	AllowRenamedTitle   bool
	VerifyCreate        bool
}

// Action records the write, if any, needed to reach the desired state.
type Action string

const (
	ActionNone    Action = "none"
	ActionCreated Action = "created"
	ActionUpdated Action = "updated"
	ActionClosed  Action = "closed"
)

// New creates a client with explicit request, response, and pagination bounds.
func New(options Options) (*Client, error) {
	base, err := url.Parse(strings.TrimSpace(options.APIURL))
	if err != nil || !base.IsAbs() || base.Host == "" || base.User != nil ||
		base.RawQuery != "" || base.Fragment != "" || base.RawPath != "" ||
		base.Path != "" && base.Path != "/" {
		return nil, errors.New("invalid GitHub API URL")
	}
	if !repositoryPattern.MatchString(options.Repository) ||
		strings.TrimSpace(options.Token) == "" ||
		options.HTTPClient == nil {
		return nil, errors.New("invalid GitHub issue client configuration")
	}
	responseLimit := options.ResponseLimit
	if responseLimit == 0 {
		responseLimit = DefaultResponseLimit
	}
	pageSize := options.PageSize
	if pageSize == 0 {
		pageSize = DefaultPageSize
	}
	maxPages := options.MaxPages
	if maxPages == 0 {
		maxPages = DefaultMaxPages
	}
	timeout := options.Timeout
	if timeout == 0 {
		timeout = DefaultTimeout
	}
	if responseLimit <= 0 || pageSize <= 0 || pageSize > 100 ||
		maxPages <= 0 || timeout <= 0 {
		return nil, errors.New("invalid GitHub issue client bounds")
	}

	safeClient := *options.HTTPClient
	if safeClient.Timeout == 0 || safeClient.Timeout > timeout {
		safeClient.Timeout = timeout
	}
	safeClient.CheckRedirect = func(*http.Request, []*http.Request) error {
		return errors.New("GitHub API redirects are not allowed")
	}
	return &Client{
		base:          base,
		repository:    options.Repository,
		token:         options.Token,
		userAgent:     strings.TrimSpace(options.UserAgent),
		http:          &safeClient,
		responseLimit: responseLimit,
		pageSize:      pageSize,
		maxPages:      maxPages,
	}, nil
}

// RepositoryPath returns an escaped API path inside the configured repository.
func (client *Client) RepositoryPath(suffix string) string {
	parts := strings.Split(client.repository, "/")
	return "/repos/" + url.PathEscape(parts[0]) + "/" + url.PathEscape(parts[1]) + suffix
}

// Repository returns the repository this client is fenced to.
func (client *Client) Repository() string {
	return client.repository
}

// Request performs one bounded same-origin API request.
func (client *Client) Request(
	ctx context.Context,
	method, endpoint string,
	payload any,
	accept string,
	limit int,
) ([]byte, http.Header, error) {
	target, err := client.resolve(endpoint)
	if err != nil {
		return nil, nil, err
	}
	if limit <= 0 || limit > client.responseLimit {
		return nil, nil, errors.New("invalid GitHub API response bound")
	}
	var body io.Reader
	if payload != nil {
		encoded, encodeErr := json.Marshal(payload)
		if encodeErr != nil {
			return nil, nil, errors.New("encode GitHub API request failed")
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, target.String(), body)
	if err != nil {
		return nil, nil, errors.New("create GitHub API request failed")
	}
	if strings.TrimSpace(accept) == "" {
		accept = "application/vnd.github+json"
	}
	request.Header.Set("Accept", accept)
	request.Header.Set("Authorization", "Bearer "+client.token)
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if client.userAgent != "" {
		request.Header.Set("User-Agent", client.userAgent)
	}
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}

	response, err := client.http.Do(request)
	if err != nil {
		return nil, nil, errors.New("GitHub API request failed")
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, nil, fmt.Errorf("GitHub API status %d", response.StatusCode)
	}
	content, err := io.ReadAll(io.LimitReader(response.Body, int64(limit)+1))
	if err != nil {
		return nil, nil, errors.New("read GitHub API response failed")
	}
	if len(content) > limit {
		return nil, nil, errors.New("GitHub API response exceeded limit")
	}
	return content, response.Header.Clone(), nil
}

// RequestJSON performs a request and strictly decodes one JSON response value.
func (client *Client) RequestJSON(
	ctx context.Context,
	method, endpoint string,
	payload, result any,
) (http.Header, error) {
	content, header, err := client.Request(
		ctx,
		method,
		endpoint,
		payload,
		"application/vnd.github+json",
		client.responseLimit,
	)
	if err != nil {
		return nil, err
	}
	if result == nil {
		return header, nil
	}
	if len(content) == 0 {
		return nil, errors.New("GitHub API response missing")
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	if err := decoder.Decode(result); err != nil {
		return nil, errors.New("decode GitHub API response failed")
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return nil, errors.New("GitHub API response contained trailing data")
	}
	return header, nil
}

// Find resolves exactly zero or one automation-owned marker issue.
func (client *Client) Find(ctx context.Context, identity Identity) (*Issue, error) {
	if err := validateIdentity(identity); err != nil {
		return nil, err
	}
	query := url.Values{
		"state":     {"all"},
		"creator":   {identity.Author},
		"sort":      {"created"},
		"direction": {"asc"},
		"per_page":  {strconv.Itoa(client.pageSize)},
		"page":      {"1"},
	}
	next := client.RepositoryPath("/issues?" + query.Encode())
	cursorUsed := false
	var found *Issue
	for page := 0; page < client.maxPages; page++ {
		var issues []Issue
		header, err := client.RequestJSON(
			ctx,
			http.MethodGet,
			next,
			nil,
			&issues,
		)
		if err != nil {
			return nil, err
		}
		for index := range issues {
			candidate := &issues[index]
			pullRequest := strings.TrimSpace(string(candidate.PullRequest))
			if (pullRequest != "" && pullRequest != "null") ||
				candidate.User.Login != identity.Author ||
				!strings.Contains(candidate.Body, identity.Marker) ||
				identity.RequireTitle && candidate.Title != identity.Title {
				continue
			}
			if candidate.Number <= 0 ||
				candidate.State != "open" && candidate.State != "closed" {
				return nil, errors.New("invalid automation issue evidence")
			}
			if found != nil && found.Number != candidate.Number {
				return nil, errors.New("duplicate automation issue evidence")
			}
			copy := *candidate
			found = &copy
		}
		next, err = client.nextLink(header.Get("Link"), identity)
		if err != nil {
			return nil, err
		}
		if next != "" {
			cursorUsed = true
		} else if !cursorUsed && len(issues) == client.pageSize {
			// GitHub.com supplies an opaque cursor. Preserve the legacy bounded
			// numbered-page behavior for compatible API servers that omit Link.
			query.Set("page", strconv.Itoa(page+2))
			next = client.RepositoryPath("/issues?" + query.Encode())
		}
		if next == "" {
			return found, nil
		}
		if page == client.maxPages-1 {
			return nil, errors.New("automation issue pagination exceeded")
		}
	}
	return nil, errors.New("automation issue pagination exceeded")
}

// Sync creates, updates, reopens, or closes an issue without rewriting an
// already identical record.
func (client *Client) Sync(
	ctx context.Context,
	identity Identity,
	desired Desired,
) (Action, error) {
	if err := validateIdentity(identity); err != nil {
		return ActionNone, err
	}
	if desired.State != "open" && desired.State != "closed" {
		return ActionNone, errors.New("invalid desired issue state")
	}
	if desired.State == "open" || !desired.PreserveBodyOnClose {
		if strings.TrimSpace(desired.Title) == "" ||
			!strings.Contains(desired.Body, identity.Marker) {
			return ActionNone, errors.New("desired issue is missing its identity")
		}
	}
	existing, err := client.Find(ctx, identity)
	if err != nil {
		return ActionNone, err
	}
	if desired.State == "closed" && existing == nil {
		return ActionNone, nil
	}
	if desired.State == "closed" && desired.ClosedIsTerminal &&
		existing.State == "closed" {
		return ActionNone, nil
	}
	if desired.State == "closed" && desired.PreserveBodyOnClose {
		if existing.State == "closed" {
			return ActionNone, nil
		}
		if err := client.patch(ctx, existing.Number, map[string]any{"state": "closed"}); err != nil {
			return ActionNone, err
		}
		return ActionClosed, nil
	}
	if existing == nil {
		payload := map[string]any{"title": desired.Title, "body": desired.Body}
		if !desired.VerifyCreate {
			if _, _, err := client.Request(
				ctx,
				http.MethodPost,
				client.RepositoryPath("/issues"),
				payload,
				"application/vnd.github+json",
				client.responseLimit,
			); err != nil {
				return ActionNone, err
			}
			return ActionCreated, nil
		}
		var created struct {
			Number int `json:"number"`
		}
		if _, err := client.RequestJSON(
			ctx,
			http.MethodPost,
			client.RepositoryPath("/issues"),
			payload,
			&created,
		); err != nil {
			return ActionNone, err
		}
		if created.Number <= 0 {
			return ActionNone, errors.New("published automation issue identity is unreadable")
		}
		if desired.VerifyCreate {
			published, err := client.Find(ctx, identity)
			if err != nil {
				return ActionNone, err
			}
			if published == nil || published.Number != created.Number {
				return ActionNone, errors.New("published automation issue is not discoverable")
			}
		}
		return ActionCreated, nil
	}
	if existing.State == desired.State &&
		(existing.Title == desired.Title || desired.AllowRenamedTitle) &&
		existing.Body == desired.Body {
		return ActionNone, nil
	}
	if err := client.patch(ctx, existing.Number, map[string]any{
		"title": desired.Title,
		"body":  desired.Body,
		"state": desired.State,
	}); err != nil {
		return ActionNone, err
	}
	if desired.State == "closed" {
		return ActionClosed, nil
	}
	return ActionUpdated, nil
}

func (client *Client) patch(ctx context.Context, number int, payload map[string]any) error {
	_, _, err := client.Request(
		ctx,
		http.MethodPatch,
		client.RepositoryPath("/issues/"+strconv.Itoa(number)),
		payload,
		"application/vnd.github+json",
		client.responseLimit,
	)
	return err
}

func (client *Client) resolve(endpoint string) (*url.URL, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return nil, errors.New("invalid GitHub API endpoint")
	}
	if !parsed.IsAbs() {
		parsed = client.base.ResolveReference(parsed)
	}
	if !sameOrigin(client.base, parsed) {
		return nil, errors.New("cross-origin GitHub API endpoint rejected")
	}
	if parsed.User != nil || parsed.Fragment != "" || parsed.RawPath != "" {
		return nil, errors.New("encoded or decorated GitHub API endpoint rejected")
	}
	repositoryRoot := client.base.ResolveReference(&url.URL{
		Path: client.RepositoryPath(""),
	}).Path
	if parsed.Path != repositoryRoot &&
		!strings.HasPrefix(parsed.Path, repositoryRoot+"/") {
		return nil, errors.New("cross-repository GitHub API endpoint rejected")
	}
	return parsed, nil
}

func (client *Client) nextLink(header string, identity Identity) (string, error) {
	var found string
	for _, part := range strings.Split(header, ",") {
		fields := strings.Split(strings.TrimSpace(part), ";")
		if len(fields) < 2 ||
			!strings.Contains(strings.Join(fields[1:], ";"), `rel="next"`) {
			continue
		}
		target := strings.TrimSpace(fields[0])
		if len(target) < 3 || target[0] != '<' ||
			target[len(target)-1] != '>' {
			return "", errors.New("invalid GitHub API pagination link")
		}
		parsed, err := url.Parse(target[1 : len(target)-1])
		if err != nil || !client.validIssueCursor(parsed, identity) {
			return "", errors.New("untrusted GitHub API pagination rejected")
		}
		// GitHub canonicalizes this Link to /repositories/{numeric-id}/issues.
		// Rebase its validated opaque query onto the configured repository path
		// so no Link path can redirect discovery into another repository.
		normalized := client.RepositoryPath("/issues?" + parsed.RawQuery)
		if found != "" && found != normalized {
			return "", errors.New("duplicate GitHub API pagination links")
		}
		found = normalized
	}
	return found, nil
}

func (client *Client) validIssueCursor(target *url.URL, identity Identity) bool {
	if !sameOrigin(client.base, target) ||
		target.User != nil ||
		target.Fragment != "" ||
		target.RawPath != "" {
		return false
	}
	expected, err := client.resolve(client.RepositoryPath("/issues"))
	if err != nil ||
		target.Path != expected.Path && !canonicalIssuePathPattern.MatchString(target.Path) {
		return false
	}
	query := target.Query()
	expectedValues := map[string]string{
		"state":     "all",
		"creator":   identity.Author,
		"sort":      "created",
		"direction": "asc",
		"per_page":  strconv.Itoa(client.pageSize),
	}
	for key, value := range expectedValues {
		if len(query[key]) != 1 || query.Get(key) != value {
			return false
		}
		delete(query, key)
	}
	for key, values := range query {
		if key != "page" && key != "after" ||
			len(values) != 1 ||
			strings.TrimSpace(values[0]) == "" {
			return false
		}
	}
	return strings.TrimSpace(query.Get("after")) != ""
}

func validateIdentity(identity Identity) error {
	if strings.TrimSpace(identity.Marker) == "" ||
		strings.TrimSpace(identity.Author) == "" ||
		identity.RequireTitle && strings.TrimSpace(identity.Title) == "" {
		return errors.New("invalid automation issue identity")
	}
	return nil
}

func sameOrigin(left, right *url.URL) bool {
	return left != nil && right != nil &&
		strings.EqualFold(left.Scheme, right.Scheme) &&
		strings.EqualFold(left.Host, right.Host)
}
