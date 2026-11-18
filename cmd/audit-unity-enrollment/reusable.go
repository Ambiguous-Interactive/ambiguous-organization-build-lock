package main

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// defaultReusableWorkflowBaseURL serves the raw bytes of a file at one commit
// from a public repository. The audit reads anonymous content only, so a
// callee a reader cannot see stays unresolved.
const defaultReusableWorkflowBaseURL = "https://raw.githubusercontent.com"

// maxReusableWorkflowBytes bounds one callee workflow. The largest reviewed
// consumer workflow is far smaller, so a larger response is not a workflow the
// audit could analyze.
const maxReusableWorkflowBytes = 256 * 1024

const reusableWorkflowTimeout = 15 * time.Second

type reusableWorkflowRead struct {
	content []byte
	err     error
}

// reusableWorkflowFetcher reads remote reusable workflows from their immutable
// raw content. A read that fails is remembered, so one unreachable callee is
// read once per audit instead of once per caller.
type reusableWorkflowFetcher struct {
	baseURL string
	client  *http.Client
	cache   map[string]reusableWorkflowRead
}

func newReusableWorkflowFetcher(baseURL string) *reusableWorkflowFetcher {
	return &reusableWorkflowFetcher{
		baseURL: strings.TrimSuffix(baseURL, "/"),
		client:  &http.Client{Timeout: reusableWorkflowTimeout},
		cache:   make(map[string]reusableWorkflowRead),
	}
}

func (f *reusableWorkflowFetcher) resolve(repository, workflowPath, sha string) ([]byte, error) {
	key := repository + "@" + sha + "/" + workflowPath
	if read, cached := f.cache[key]; cached {
		return read.content, read.err
	}
	content, err := f.fetch(repository, workflowPath, sha)
	f.cache[key] = reusableWorkflowRead{content: content, err: err}
	return content, err
}

func (f *reusableWorkflowFetcher) fetch(repository, workflowPath, sha string) ([]byte, error) {
	address, err := url.JoinPath(f.baseURL, repository, sha, workflowPath)
	if err != nil {
		return nil, fmt.Errorf("cannot build the reusable workflow request")
	}
	request, err := http.NewRequest(http.MethodGet, address, nil)
	if err != nil {
		return nil, fmt.Errorf("cannot build the reusable workflow request")
	}
	response, err := f.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("cannot read the reusable workflow")
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("reusable workflow content is not readable")
	}
	content, err := io.ReadAll(io.LimitReader(response.Body, maxReusableWorkflowBytes+1))
	if err != nil {
		return nil, fmt.Errorf("cannot read the reusable workflow")
	}
	if len(content) > maxReusableWorkflowBytes {
		return nil, fmt.Errorf("reusable workflow content is too large")
	}
	return content, nil
}
