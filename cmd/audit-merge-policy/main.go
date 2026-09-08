package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/enrollment"
	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/mergepolicy"
)

const (
	defaultTimeout    = 20 * time.Second
	maxResponseBytes  = 4 << 20
	maxRulesetsPerRun = 128
)

// errNoProtection marks the documented "Branch not protected" response that
// proves classic branch protection is absent.
var errNoProtection = errors.New("branch protection is absent")

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr, os.Getenv, http.DefaultClient))
}

type apiClient struct {
	base  *url.URL
	token string
	http  *http.Client
}

func run(
	arguments []string,
	stdout, stderr io.Writer,
	getenv func(string) string,
	httpClient *http.Client,
) int {
	flags := flag.NewFlagSet("audit-merge-policy", flag.ContinueOnError)
	flags.SetOutput(stderr)
	policyPath := flags.String("policy", "unity-enrollment-policy.json", "reviewed enrollment policy JSON")
	expectationsPath := flags.String("expectations", "merge-policy-expectations.json", "reviewed merge policy expectations JSON")
	outputPath := flags.String("output", "", "bounded JSON audit artifact")
	validateOnly := flags.Bool(
		"validate-only",
		false,
		"validate the reviewed expectations without reading live repositories",
	)
	if err := flags.Parse(arguments); err != nil || flags.NArg() != 0 {
		return 2
	}
	if !*validateOnly && *outputPath == "" {
		_, _ = fmt.Fprintln(stderr, "expectations and output are required")
		return 2
	}
	policyContent, err := os.ReadFile(*policyPath)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "cannot read Unity enrollment policy")
		return 2
	}
	registry, err := enrollment.ParseUnityEnrollmentRegistry(policyContent)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "invalid Unity enrollment policy: %v\n", err)
		return 2
	}
	expectationsContent, err := os.ReadFile(*expectationsPath)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "cannot read merge policy expectations")
		return 2
	}
	expectations, err := mergepolicy.ParseExpectations(expectationsContent)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "invalid merge policy expectations: %v\n", err)
		return 2
	}
	if err := crossValidate(registry, expectations); err != nil {
		_, _ = fmt.Fprintf(stderr, "merge policy expectations drift from the enrollment registry: %v\n", err)
		return 2
	}
	if *validateOnly {
		_, _ = fmt.Fprintln(stdout, "Merge policy expectations are valid.")
		return 0
	}
	client, err := newAPIClient(getenv("GITHUB_API_URL"), getenv("READER_AUTHORIZATION"), httpClient)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "merge policy audit reader credentials are not configured")
		return 2
	}
	audit := auditRepositories(context.Background(), client, expectations)
	writeErr := writeAudit(*outputPath, audit)
	if writeErr != nil {
		_, _ = fmt.Fprintln(stderr, "cannot write merge policy audit artifact")
		return 2
	}
	_, _ = fmt.Fprintf(
		stdout,
		"Audited %d/%d enrolled repositories; active-contexts=%d findings=%d complete=%t\n",
		len(audit.Repositories),
		len(expectations.Repositories),
		len(audit.Inventory),
		len(audit.Findings),
		audit.Complete,
	)
	if !audit.Clean() {
		return 1
	}
	return 0
}

// crossValidate keeps the expectation set and the enrollment registry from
// drifting apart: one repository set, one default branch per repository.
func crossValidate(registry enrollment.UnityEnrollmentRegistry, expectations mergepolicy.Expectations) error {
	if len(registry.Repositories) != len(expectations.Repositories) {
		return fmt.Errorf("repository count differs")
	}
	enrolled := make(map[string]enrollment.UnityEnrollmentRepository, len(registry.Repositories))
	for _, repository := range registry.Repositories {
		enrolled[strings.ToLower(repository.Repository)] = repository
	}
	for _, expectation := range expectations.Repositories {
		enrollmentRepository, ok := enrolled[strings.ToLower(expectation.Repository)]
		if !ok {
			return fmt.Errorf("repository %s is not enrolled", expectation.Repository)
		}
		if enrollmentRepository.Repository != expectation.Repository {
			return fmt.Errorf("repository %s spelling is not canonical", expectation.Repository)
		}
		if enrollmentRepository.DefaultBranch != expectation.DefaultBranch {
			return fmt.Errorf("repository %s default branch differs from the registry", expectation.Repository)
		}
	}
	return nil
}

func newAPIClient(apiURL, token string, httpClient *http.Client) (*apiClient, error) {
	base, err := url.Parse(strings.TrimSpace(apiURL))
	if err != nil || base.Scheme != "https" || base.Host == "" ||
		base.User != nil || base.RawQuery != "" || base.Fragment != "" || base.RawPath != "" ||
		base.Path != "" && base.Path != "/" {
		return nil, fmt.Errorf("invalid GitHub API URL")
	}
	if strings.TrimSpace(token) == "" || httpClient == nil {
		return nil, fmt.Errorf("reader credentials are missing")
	}
	safeClient := *httpClient
	if safeClient.Timeout == 0 || safeClient.Timeout > defaultTimeout {
		safeClient.Timeout = defaultTimeout
	}
	safeClient.CheckRedirect = func(*http.Request, []*http.Request) error {
		return errors.New("GitHub API redirects are not allowed")
	}
	return &apiClient{base: base, token: strings.TrimSpace(token), http: &safeClient}, nil
}

func (client *apiClient) get(ctx context.Context, endpoint string) ([]byte, http.Header, error) {
	target, err := client.base.Parse(endpoint)
	if err != nil {
		return nil, nil, fmt.Errorf("invalid GitHub API endpoint")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, nil, fmt.Errorf("create GitHub API request failed")
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("Authorization", "Bearer "+client.token)
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	response, err := client.http.Do(request)
	if err != nil {
		return nil, nil, fmt.Errorf("GitHub API request failed")
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == http.StatusNotFound && strings.HasSuffix(endpoint, "/protection") {
		return nil, response.Header.Clone(), errNoProtection
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, nil, fmt.Errorf("GitHub API status %d", response.StatusCode)
	}
	content, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(content) > maxResponseBytes {
		return nil, nil, fmt.Errorf("GitHub API response exceeded bound")
	}
	return content, response.Header.Clone(), nil
}

type rulesetSummary struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Enforcement string `json:"enforcement"`
}

type rulesetListPayload []rulesetSummary

type rulesetDetailPayload struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Enforcement string `json:"enforcement"`
	Conditions  struct {
		RefName struct {
			Include []string `json:"include"`
			Exclude []string `json:"exclude"`
		} `json:"ref_name"`
	} `json:"conditions"`
	BypassActors []struct {
		ActorID    int64  `json:"actor_id"`
		ActorType  string `json:"actor_type"`
		BypassMode string `json:"bypass_mode"`
	} `json:"bypass_actors"`
	Rules []struct {
		Type       string `json:"type"`
		Parameters struct {
			RequiredStatusChecks []struct {
				Context string `json:"context"`
			} `json:"required_status_checks"`
		} `json:"parameters"`
	} `json:"rules"`
}

type protectionPayload struct {
	EnforceAdmins struct {
		Enabled bool `json:"enabled"`
	} `json:"enforce_admins"`
	RequiredStatusChecks struct {
		Checks []struct {
			Context string `json:"context"`
		} `json:"checks"`
		Contexts []string `json:"contexts"`
	} `json:"required_status_checks"`
}

func auditRepositories(
	ctx context.Context,
	client *apiClient,
	expectations mergepolicy.Expectations,
) mergepolicy.Audit {
	audit := mergepolicy.Audit{
		Complete:     true,
		Repositories: make([]mergepolicy.AuditedRepository, 0, len(expectations.Repositories)),
		Inventory:    make([]mergepolicy.InventoryEntry, 0),
		Findings:     make([]mergepolicy.Finding, 0),
	}
	for _, expectation := range expectations.Repositories {
		observed, retrievalErr := observeRepository(ctx, client, expectation)
		audit.Repositories = append(audit.Repositories, mergepolicy.AuditedRepository{
			Repository:    expectation.Repository,
			DefaultBranch: expectation.DefaultBranch,
		})
		if retrievalErr != nil {
			audit.Complete = false
			audit.Findings = append(audit.Findings, mergepolicy.Finding{
				Repository: expectation.Repository,
				Code:       mergepolicy.CodeRetrievalIncomplete,
			})
			continue
		}
		findings, inventory := mergepolicy.Analyze(expectation, observed)
		audit.Findings = append(audit.Findings, findings...)
		audit.Inventory = append(audit.Inventory, inventory...)
	}
	sort.Slice(audit.Repositories, func(i, j int) bool {
		return audit.Repositories[i].Repository < audit.Repositories[j].Repository
	})
	sort.Slice(audit.Inventory, func(i, j int) bool {
		left, right := audit.Inventory[i], audit.Inventory[j]
		if left.Repository != right.Repository {
			return left.Repository < right.Repository
		}
		if left.Kind != right.Kind {
			return left.Kind < right.Kind
		}
		if left.Carrier != right.Carrier {
			return left.Carrier < right.Carrier
		}
		return left.Context < right.Context
	})
	sort.Slice(audit.Findings, func(i, j int) bool {
		left, right := audit.Findings[i], audit.Findings[j]
		if left.Repository != right.Repository {
			return left.Repository < right.Repository
		}
		if left.Code != right.Code {
			return left.Code < right.Code
		}
		if left.Context != right.Context {
			return left.Context < right.Context
		}
		return left.Detail < right.Detail
	})
	return audit
}

func observeRepository(
	ctx context.Context,
	client *apiClient,
	expectation mergepolicy.RepositoryExpectation,
) (mergepolicy.Observed, error) {
	observed := mergepolicy.Observed{}
	listEndpoint := fmt.Sprintf(
		"repos/%s/rulesets?per_page=%d",
		expectation.Repository,
		maxRulesetsPerRun,
	)
	listContent, headers, err := client.get(ctx, listEndpoint)
	if err != nil {
		return observed, fmt.Errorf("list rulesets failed")
	}
	if hasPagination(headers) {
		return observed, fmt.Errorf("ruleset pagination is not supported by the bounded audit")
	}
	var list rulesetListPayload
	if err := strictDecode(listContent, &list); err != nil {
		return observed, fmt.Errorf("decode ruleset list failed")
	}
	if len(list) > maxRulesetsPerRun {
		return observed, fmt.Errorf("ruleset count exceeded bound")
	}
	for _, summary := range list {
		detailEndpoint := fmt.Sprintf("repos/%s/rulesets/%d", expectation.Repository, summary.ID)
		detailContent, _, err := client.get(ctx, detailEndpoint)
		if err != nil {
			return observed, fmt.Errorf("read ruleset %d failed", summary.ID)
		}
		var detail rulesetDetailPayload
		if err := strictDecode(detailContent, &detail); err != nil {
			return observed, fmt.Errorf("decode ruleset %d failed", summary.ID)
		}
		observed.Rulesets = append(observed.Rulesets, rulesetFromDetail(detail, expectation.DefaultBranch))
	}
	protectionContent, _, err := client.get(
		ctx,
		fmt.Sprintf("repos/%s/branches/%s/protection", expectation.Repository, expectation.DefaultBranch),
	)
	switch {
	case err == nil:
		var payload protectionPayload
		if err := strictDecode(protectionContent, &payload); err != nil {
			return observed, fmt.Errorf("decode branch protection failed")
		}
		observed.Protection = mergepolicy.Protection{
			Present:        true,
			AdminEnforced:  payload.EnforceAdmins.Enabled,
			RequiredChecks: protectionChecks(payload),
		}
	case errors.Is(err, errNoProtection):
		observed.Protection = mergepolicy.Protection{Present: false}
	default:
		return observed, fmt.Errorf("read branch protection failed")
	}
	return observed, nil
}

func rulesetFromDetail(detail rulesetDetailPayload, branch string) mergepolicy.Ruleset {
	ruleset := mergepolicy.Ruleset{
		ID:                   detail.ID,
		Name:                 sanitizeText(detail.Name),
		Enforcement:          detail.Enforcement,
		TargetsDefaultBranch: targetsDefaultBranch(branch, detail.Conditions.RefName.Include, detail.Conditions.RefName.Exclude),
	}
	for _, rule := range detail.Rules {
		if rule.Type != "required_status_checks" {
			continue
		}
		for _, check := range rule.Parameters.RequiredStatusChecks {
			ruleset.RequiredChecks = append(ruleset.RequiredChecks, mergepolicy.RequiredCheck{
				Context: sanitizeText(check.Context),
			})
		}
	}
	for _, actor := range detail.BypassActors {
		ruleset.BypassActors = append(ruleset.BypassActors, mergepolicy.RuleBypassActor{
			ActorType: sanitizeText(actor.ActorType),
			ActorID:   actor.ActorID,
			Mode:      sanitizeText(actor.BypassMode),
		})
	}
	return ruleset
}

func protectionChecks(payload protectionPayload) []mergepolicy.RequiredCheck {
	checks := make([]mergepolicy.RequiredCheck, 0, len(payload.RequiredStatusChecks.Checks)+len(payload.RequiredStatusChecks.Contexts))
	for _, check := range payload.RequiredStatusChecks.Checks {
		checks = append(checks, mergepolicy.RequiredCheck{Context: sanitizeText(check.Context)})
	}
	for _, context := range payload.RequiredStatusChecks.Contexts {
		duplicate := false
		for _, check := range checks {
			if check.Context == sanitizeText(context) {
				duplicate = true
				break
			}
		}
		if !duplicate {
			checks = append(checks, mergepolicy.RequiredCheck{Context: sanitizeText(context)})
		}
	}
	return checks
}

// targetsDefaultBranch applies the ruleset ref-name conditions. A ruleset
// without ref-name conditions targets every branch. A ruleset is targeted
// when an include pattern selects the branch and no exclude pattern removes
// it.
func targetsDefaultBranch(branch string, include, exclude []string) bool {
	selects := func(pattern string) bool {
		return pattern == "~ALL" || pattern == "~DEFAULT_BRANCH" || pattern == branchRef(branch)
	}
	included := len(include) == 0
	for _, pattern := range include {
		if selects(pattern) {
			included = true
			break
		}
	}
	if !included {
		return false
	}
	for _, pattern := range exclude {
		if pattern == "~ALL" || selects(pattern) {
			return false
		}
	}
	return true
}

func branchRef(branch string) string {
	return "refs/heads/" + branch
}

// sanitizeText bounds free-form API text and strips characters the artifact
// and issue contract cannot carry.
func sanitizeText(value string) string {
	if len(value) > 128 {
		value = value[:128]
	}
	var sanitized strings.Builder
	for _, char := range value {
		if strings.ContainsRune("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _.+()/:-", char) {
			sanitized.WriteRune(char)
			continue
		}
		sanitized.WriteByte('?')
	}
	return sanitized.String()
}

func hasPagination(headers http.Header) bool {
	for _, part := range strings.Split(headers.Get("Link"), ",") {
		if strings.Contains(part, `rel="next"`) {
			return true
		}
	}
	return false
}

func strictDecode(content []byte, result any) error {
	decoder := json.NewDecoder(bytes.NewReader(content))
	if err := decoder.Decode(result); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return fmt.Errorf("response must contain one JSON value")
	}
	return nil
}

func writeAudit(path string, audit mergepolicy.Audit) error {
	var content bytes.Buffer
	encoder := json.NewEncoder(&content)
	encoder.SetEscapeHTML(true)
	if err := encoder.Encode(audit); err != nil {
		return err
	}
	return os.WriteFile(path, content.Bytes(), 0o600)
}
