package githubissue

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const (
	testAuthor = "github-actions[bot]"
	testMarker = "<!-- test-monitor -->"
	testTitle  = "ops: test monitor"
)

func TestNewClientAppliesSafetyDefaults(t *testing.T) {
	t.Parallel()
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		requests.Add(1)
	}))
	defer server.Close()

	client, err := New(Options{
		APIURL:     server.URL,
		Repository: "owner/repo",
		Token:      "token",
		HTTPClient: &http.Client{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if client.http.Timeout != DefaultTimeout {
		t.Fatalf("timeout = %s, want %s", client.http.Timeout, DefaultTimeout)
	}
	if client.RepositoryPath("/issues") != "/repos/owner/repo/issues" {
		t.Fatalf("repository path was not escaped correctly: %q", client.RepositoryPath("/issues"))
	}
	redirect := &http.Request{URL: mustParseURL(t, server.URL+"/redirected")}
	if err := client.http.CheckRedirect(redirect, nil); err == nil {
		t.Fatal("redirect was not fenced")
	}
	if _, _, err := client.Request(
		t.Context(),
		http.MethodGet,
		"https://example.invalid/issues",
		nil,
		"application/vnd.github+json",
		DefaultResponseLimit,
	); err == nil {
		t.Fatal("cross-origin request was not rejected")
	}
	for _, endpoint := range []string{
		server.URL + "/repos/other/repository/issues",
		client.RepositoryPath("/../../other/repository/issues"),
		server.URL + "/repos/owner/repo/%2e%2e/%2e%2e/other/repository/issues",
		server.URL + "/repos/owner/repo%2F..%2Fother/repository/issues",
	} {
		if _, _, err := client.Request(
			t.Context(),
			http.MethodGet,
			endpoint,
			nil,
			"application/vnd.github+json",
			DefaultResponseLimit,
		); err == nil {
			t.Fatalf("cross-repository endpoint was not rejected: %q", endpoint)
		}
	}
	if requests.Load() != 0 {
		t.Fatalf("rejected endpoints reached the server %d times", requests.Load())
	}
}

func TestRequestReportsStatusBeforeBodyBound(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusInternalServerError)
		_, _ = writer.Write([]byte(strings.Repeat("x", 1024)))
	}))
	defer server.Close()

	client := testClient(t, server, 2, 2)
	_, _, err := client.Request(
		t.Context(),
		http.MethodGet,
		client.RepositoryPath("/issues"),
		nil,
		"application/vnd.github+json",
		16,
	)
	if err == nil || !strings.Contains(err.Error(), "status 500") {
		t.Fatalf("error = %v, want status diagnostic before body bound", err)
	}
}

func TestRequestRejectsResponseOverflow(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(strings.Repeat("x", 17)))
	}))
	defer server.Close()

	client := testClient(t, server, 2, 2)
	_, _, err := client.Request(
		t.Context(),
		http.MethodGet,
		client.RepositoryPath("/issues"),
		nil,
		"application/vnd.github+json",
		16,
	)
	if err == nil || !strings.Contains(err.Error(), "exceeded") {
		t.Fatalf("error = %v, want response overflow", err)
	}
}

func TestFindWalksStableBoundedPagesAndIgnoresLookalikes(t *testing.T) {
	t.Parallel()
	var queries []url.Values
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		queries = append(queries, request.URL.Query())
		switch request.URL.Query().Get("page") {
		case "1":
			writeNextLink(writer, server.URL, 2, 2, "cursor-one")
			issues := []Issue{
				issueFixture(1, "closed", "unrelated", strings.Repeat("x", 64*1024), testAuthor),
				issueFixture(2, "open", testTitle, testMarker, "outsider"),
			}
			_ = json.NewEncoder(writer).Encode(issues)
		case "2":
			writeNextLink(writer, server.URL, 3, 2, "cursor-two")
			pullRequest := issueFixture(3, "open", testTitle, testMarker, testAuthor)
			pullRequest.PullRequest = json.RawMessage(`{"url":"https://example.test/pulls/3"}`)
			_ = json.NewEncoder(writer).Encode([]Issue{
				pullRequest,
				issueFixture(4, "open", "[renamed] "+testTitle, testMarker+"\nbody", testAuthor),
			})
		case "3":
			_ = json.NewEncoder(writer).Encode([]Issue{})
		default:
			t.Fatalf("unexpected page %q", request.URL.Query().Get("page"))
		}
	}))
	defer server.Close()

	client := testClient(t, server, 2, 3)
	found, err := client.Find(t.Context(), Identity{Marker: testMarker, Author: testAuthor})
	if err != nil {
		t.Fatal(err)
	}
	if found == nil || found.Number != 4 {
		t.Fatalf("found = %#v, want issue 4", found)
	}
	if len(queries) != 3 {
		t.Fatalf("queries = %d, want 3", len(queries))
	}
	for index, query := range queries {
		if query.Get("creator") != testAuthor ||
			query.Get("sort") != "created" ||
			query.Get("direction") != "asc" ||
			query.Get("per_page") != "2" ||
			query.Get("page") != fmt.Sprint(index+1) {
			t.Fatalf("unstable or unbounded query: %v", query)
		}
	}
}

func TestFindFailsClosedOnInvalidDuplicateOrExhaustedEvidence(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		response []Issue
	}{
		{
			name: "invalid matching issue",
			response: []Issue{
				issueFixture(0, "open", testTitle, testMarker, testAuthor),
			},
		},
		{
			name: "duplicate matching issues",
			response: []Issue{
				issueFixture(1, "open", testTitle, testMarker, testAuthor),
				issueFixture(2, "closed", testTitle, testMarker, testAuthor),
			},
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				_ = json.NewEncoder(writer).Encode(test.response)
			}))
			defer server.Close()
			if _, err := testClient(t, server, 30, 2).Find(
				t.Context(),
				Identity{Marker: testMarker, Author: testAuthor},
			); err == nil {
				t.Fatal("ambiguous issue evidence passed")
			}
		})
	}

	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		page, _ := strconv.Atoi(request.URL.Query().Get("page"))
		writeNextLink(writer, server.URL, page+1, 1, "cursor")
		_ = json.NewEncoder(writer).Encode([]Issue{
			issueFixture(1, "closed", "unrelated", "body", testAuthor),
		})
	}))
	defer server.Close()
	if _, err := testClient(t, server, 1, 2).Find(
		t.Context(),
		Identity{Marker: testMarker, Author: testAuthor},
	); err == nil {
		t.Fatal("pagination exhaustion passed")
	}
}

func TestFindRejectsCrossOriginCursor(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set(
			"Link",
			`<https://example.invalid/issues?after=stolen>; rel="next"`,
		)
		_ = json.NewEncoder(writer).Encode([]Issue{})
	}))
	defer server.Close()

	_, err := testClient(t, server, 2, 2).Find(
		t.Context(),
		Identity{Marker: testMarker, Author: testAuthor},
	)
	if err == nil {
		t.Fatal("cross-origin pagination cursor passed")
	}
}

func TestFindRejectsSameOriginForeignRepositoryCursor(t *testing.T) {
	t.Parallel()
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		query := url.Values{
			"state":     {"all"},
			"creator":   {testAuthor},
			"sort":      {"created"},
			"direction": {"asc"},
			"per_page":  {"2"},
			"page":      {"2"},
			"after":     {"foreign-cursor"},
		}
		writer.Header().Set(
			"Link",
			"<"+server.URL+"/repos/other/repository/issues?"+query.Encode()+`>; rel="next"`,
		)
		_ = json.NewEncoder(writer).Encode([]Issue{})
	}))
	defer server.Close()

	_, err := testClient(t, server, 2, 2).Find(
		t.Context(),
		Identity{Marker: testMarker, Author: testAuthor},
	)
	if err == nil {
		t.Fatal("same-origin foreign-repository cursor passed")
	}
}

func TestFindRebasesCanonicalCursorOntoConfiguredRepository(t *testing.T) {
	t.Parallel()
	var requests int
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests++
		if request.URL.Path != "/repos/owner/repo/issues" {
			t.Errorf("cursor request escaped configured repository: %q", request.URL.Path)
		}
		if requests == 1 {
			query := request.URL.Query()
			query.Set("page", "2")
			query.Set("after", "opaque-cursor")
			writer.Header().Set(
				"Link",
				"<"+server.URL+"/repositories/123456/issues?"+query.Encode()+`>; rel="next"`,
			)
			_ = json.NewEncoder(writer).Encode([]Issue{})
			return
		}
		_ = json.NewEncoder(writer).Encode([]Issue{
			issueFixture(9, "open", testTitle, testMarker, testAuthor),
		})
	}))
	defer server.Close()

	found, err := testClient(t, server, 2, 2).Find(
		t.Context(),
		Identity{Marker: testMarker, Author: testAuthor},
	)
	if err != nil {
		t.Fatal(err)
	}
	if found == nil || found.Number != 9 || requests != 2 {
		t.Fatalf("canonical cursor result = %#v after %d requests", found, requests)
	}
}

func TestSyncIsIdempotentAndPreservesRetainedCloseEvidence(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name         string
		existing     *Issue
		desired      Desired
		wantMethod   string
		wantState    string
		wantBody     string
		wantAction   Action
		verifyCreate bool
	}{
		{
			name:       "absent closed alert is already synchronized",
			desired:    Desired{State: "closed", Title: testTitle, Body: testMarker + "\nhealthy"},
			wantAction: ActionNone,
		},
		{
			name:       "identical open alert is not rewritten",
			existing:   issuePointer(issueFixture(7, "open", testTitle, testMarker+"\nactive", testAuthor)),
			desired:    Desired{State: "open", Title: testTitle, Body: testMarker + "\nactive"},
			wantAction: ActionNone,
		},
		{
			name:       "presentation title rename is not rewritten",
			existing:   issuePointer(issueFixture(7, "open", "[P0] "+testTitle, testMarker+"\nactive", testAuthor)),
			desired:    Desired{State: "open", Title: testTitle, Body: testMarker + "\nactive", AllowRenamedTitle: true},
			wantAction: ActionNone,
		},
		{
			name:       "changed alert is updated and reopened",
			existing:   issuePointer(issueFixture(7, "closed", testTitle, testMarker+"\nold", testAuthor)),
			desired:    Desired{State: "open", Title: testTitle, Body: testMarker + "\nnew"},
			wantMethod: http.MethodPatch,
			wantState:  "open",
			wantBody:   testMarker + "\nnew",
			wantAction: ActionUpdated,
		},
		{
			name:       "retained close patches state only",
			existing:   issuePointer(issueFixture(7, "open", testTitle, testMarker+"\nactive", testAuthor)),
			desired:    Desired{State: "closed", PreserveBodyOnClose: true},
			wantMethod: http.MethodPatch,
			wantState:  "closed",
			wantAction: ActionClosed,
		},
		{
			name:         "create can prove rediscovery",
			desired:      Desired{State: "open", Title: testTitle, Body: testMarker + "\nactive", VerifyCreate: true},
			wantMethod:   http.MethodPost,
			wantBody:     testMarker + "\nactive",
			wantAction:   ActionCreated,
			verifyCreate: true,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var method, state, body string
			var gets int
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				if request.Method == http.MethodGet {
					gets++
					var issues []Issue
					if test.existing != nil {
						issues = append(issues, *test.existing)
					} else if test.verifyCreate && gets > 1 {
						issues = append(issues, issueFixture(42, "open", testTitle, testMarker+"\nactive", testAuthor))
					}
					_ = json.NewEncoder(writer).Encode(issues)
					return
				}
				method = request.Method
				var payload map[string]any
				if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
					t.Fatal(err)
				}
				state, _ = payload["state"].(string)
				body, _ = payload["body"].(string)
				if request.Method == http.MethodPost {
					writer.WriteHeader(http.StatusCreated)
					_, _ = writer.Write([]byte(`{"number":42}`))
					return
				}
				_, _ = writer.Write([]byte(`{}`))
			}))
			defer server.Close()

			action, err := testClient(t, server, 30, 2).Sync(
				context.Background(),
				Identity{Marker: testMarker, Author: testAuthor},
				test.desired,
			)
			if err != nil {
				t.Fatal(err)
			}
			if action != test.wantAction || method != test.wantMethod ||
				state != test.wantState || body != test.wantBody {
				t.Fatalf(
					"sync = action %q, %s state=%q body=%q; want action %q, %s state=%q body=%q",
					action, method, state, body,
					test.wantAction, test.wantMethod, test.wantState, test.wantBody,
				)
			}
		})
	}
}

func TestMaximumEscapedIssuePageFitsResponseBound(t *testing.T) {
	t.Parallel()
	issues := make([]map[string]any, DefaultPageSize)
	for index := range issues {
		issues[index] = map[string]any{
			"number":             index + 1,
			"state":              "closed",
			"title":              strings.Repeat("t", 256),
			"body":               strings.Repeat("<", 64*1024),
			"user":               map[string]any{"login": testAuthor},
			"pull_request":       nil,
			"labels":             []any{},
			"assignees":          []any{},
			"milestone":          nil,
			"reactions":          map[string]any{"total_count": 0},
			"repository_url":     "https://api.github.test/repos/owner/repo",
			"html_url":           "https://github.test/owner/repo/issues/1",
			"url":                "https://api.github.test/repos/owner/repo/issues/1",
			"comments_url":       "https://api.github.test/repos/owner/repo/issues/1/comments",
			"events_url":         "https://api.github.test/repos/owner/repo/issues/1/events",
			"labels_url":         "https://api.github.test/repos/owner/repo/issues/1/labels{/name}",
			"node_id":            strings.Repeat("n", 128),
			"locked":             false,
			"comments":           0,
			"author_association": "NONE",
			"state_reason":       "completed",
			// Reserve 400 KiB per issue for omitted and future envelope fields.
			"_reserved_envelope": strings.Repeat("e", 400*1024),
		}
	}
	encoded, err := json.Marshal(issues)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) > DefaultResponseLimit {
		t.Fatalf(
			"maximum escaped issue page is %d bytes, over the %d-byte bound",
			len(encoded),
			DefaultResponseLimit,
		)
	}
}

func testClient(t *testing.T, server *httptest.Server, pageSize, maxPages int) *Client {
	t.Helper()
	client, err := New(Options{
		APIURL:        server.URL,
		Repository:    "owner/repo",
		Token:         "token",
		HTTPClient:    server.Client(),
		PageSize:      pageSize,
		MaxPages:      maxPages,
		ResponseLimit: DefaultResponseLimit,
		Timeout:       time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func issueFixture(number int, state, title, body, author string) Issue {
	result := Issue{Number: number, State: state, Title: title, Body: body}
	result.User.Login = author
	return result
}

func issuePointer(issue Issue) *Issue {
	return &issue
}

func mustParseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func writeNextLink(
	writer http.ResponseWriter,
	baseURL string,
	page, perPage int,
	after string,
) {
	query := url.Values{
		"state":     {"all"},
		"creator":   {testAuthor},
		"sort":      {"created"},
		"direction": {"asc"},
		"per_page":  {strconv.Itoa(perPage)},
		"page":      {strconv.Itoa(page)},
		"after":     {after},
	}
	writer.Header().Set(
		"Link",
		"<"+baseURL+"/repos/owner/repo/issues?"+query.Encode()+`>; rel="next"`,
	)
}
