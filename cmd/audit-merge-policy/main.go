package main

import (
	"bytes"
	"context"
	"encoding/base64"
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
	defaultTimeout   = 20 * time.Second
	maxResponseBytes = 4 << 20
	// GitHub caps ruleset lists at 100 per page; anything beyond that is
	// paginated and therefore rejected as unbounded evidence.
	maxRulesetsPerRun = 100
)

// errNoProtection marks the documented "Branch not protected" response that
// proves classic branch protection is absent. Any other 404 stays an error.
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
	if *outputPath == "" && !*validateOnly {
		_, _ = fmt.Fprintln(stderr, "output is required unless --validate-only is set")
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
	if err := writeAudit(*outputPath, audit); err != nil {
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

// apiResponse is one bounded GitHub API response.
type apiResponse struct {
	status  int
	content []byte
	headers http.Header
}

func (client *apiClient) fetch(ctx context.Context, endpoint string) (apiResponse, error) {
	target, err := client.base.Parse(endpoint)
	if err != nil {
		return apiResponse{}, fmt.Errorf("invalid GitHub API endpoint")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return apiResponse{}, fmt.Errorf("create GitHub API request failed")
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("Authorization", "Bearer "+client.token)
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	response, err := client.http.Do(request)
	if err != nil {
		return apiResponse{}, fmt.Errorf("GitHub API request failed")
	}
	defer func() { _ = response.Body.Close() }()
	content, readErr := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if readErr != nil || len(content) > maxResponseBytes {
		return apiResponse{}, fmt.Errorf("GitHub API response exceeded bound")
	}
	return apiResponse{
		status:  response.StatusCode,
		content: content,
		headers: response.Header.Clone(),
	}, nil
}

func (client *apiClient) get(ctx context.Context, endpoint string) ([]byte, http.Header, error) {
	response, err := client.fetch(ctx, endpoint)
	if err != nil {
		return nil, nil, err
	}
	if response.status == http.StatusNotFound &&
		strings.HasSuffix(endpoint, "/protection") &&
		strings.Contains(string(response.content), "Branch not protected") {
		return nil, response.headers, errNoProtection
	}
	if response.status < 200 || response.status >= 300 {
		return nil, nil, fmt.Errorf("GitHub API status %d", response.status)
	}
	return response.content, response.headers, nil
}

// contentsPayload is the bounded metadata envelope of the contents API.
type contentsPayload struct {
	Content  *string `json:"content"`
	Encoding string  `json:"encoding"`
	Size     int     `json:"size"`
}

// getContents reads one bounded file from a repository. A documented 404
// means the file is absent, which is valid evidence; every other failure
// is a retrieval error.
func (client *apiClient) getContents(ctx context.Context, repository, ref, path string) ([]byte, bool, error) {
	endpoint := fmt.Sprintf(
		"repos/%s/contents/%s?ref=%s",
		repository, path, url.QueryEscape(ref),
	)
	response, err := client.fetch(ctx, endpoint)
	if err != nil {
		return nil, false, err
	}
	if response.status == http.StatusNotFound {
		return nil, false, nil
	}
	if response.status < 200 || response.status >= 300 {
		return nil, false, fmt.Errorf("GitHub API status %d", response.status)
	}
	var payload contentsPayload
	if err := strictDecode(response.content, &payload); err != nil {
		return nil, false, fmt.Errorf("decode contents metadata failed")
	}
	if payload.Content == nil || payload.Encoding != "base64" {
		return nil, false, fmt.Errorf("unsupported contents encoding")
	}
	if payload.Size > mergepolicy.MaxAttestationBytes || len(*payload.Content) > mergepolicy.MaxAttestationBytes {
		return nil, false, fmt.Errorf("attestation file exceeds bound")
	}
	decoded, err := base64.StdEncoding.DecodeString(strings.ReplaceAll(*payload.Content, "\n", ""))
	if err != nil {
		return nil, false, fmt.Errorf("decode attestation content failed")
	}
	return decoded, true, nil
}

type rulesetSummary struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Enforcement string `json:"enforcement"`
}

type rulesetDetailPayload struct {
	ID           int64  `json:"id"`
	Name         string `json:"name"`
	Enforcement  string `json:"enforcement"`
	BypassActors *[]struct {
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

type activeRulesPayload []struct {
	RulesetID  int64  `json:"ruleset_id"`
	Type       string `json:"type"`
	Parameters struct {
		RequiredStatusChecks []struct {
			Context string `json:"context"`
		} `json:"required_status_checks"`
	} `json:"parameters"`
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
		record := &audit.Repositories[len(audit.Repositories)-1]
		if retrievalErr != nil {
			audit.Complete = false
			audit.Findings = append(audit.Findings, mergepolicy.Finding{
				Repository: expectation.Repository,
				Code:       mergepolicy.CodeRetrievalIncomplete,
			})
			continue
		}
		attestation, finding := loadAttestation(ctx, client, expectation)
		if finding != nil {
			audit.Complete = false
			audit.Findings = append(audit.Findings, *finding)
			continue
		}
		resolved, attestedIDs, health, complete := mergepolicy.ResolveBypassEvidence(
			expectation, observed, attestation,
		)
		if !complete {
			audit.Complete = false
			audit.Findings = append(audit.Findings, health...)
			continue
		}
		audit.Findings = append(audit.Findings, health...)
		record.AttestedRulesetIDs = attestedIDs
		findings, inventory := mergepolicy.Analyze(expectation, resolved)
		audit.Findings = append(audit.Findings, findings...)
		audit.Inventory = append(audit.Inventory, inventory...)
	}
	sortAudit(audit)
	return audit
}

// loadAttestation reads the consumer-published attestation file. A missing
// file is valid empty evidence. An unreadable response or an unparseable
// published file becomes one fail-closed finding for the repository.
func loadAttestation(
	ctx context.Context,
	client *apiClient,
	expectation mergepolicy.RepositoryExpectation,
) (mergepolicy.Attestation, *mergepolicy.Finding) {
	raw, found, err := client.getContents(
		ctx, expectation.Repository, expectation.DefaultBranch, mergepolicy.AttestationPath,
	)
	if err != nil {
		return mergepolicy.Attestation{}, &mergepolicy.Finding{
			Repository: expectation.Repository,
			Code:       mergepolicy.CodeRetrievalIncomplete,
		}
	}
	if !found {
		return mergepolicy.Attestation{}, nil
	}
	attestation, err := mergepolicy.ParseAttestation(raw, expectation.Repository)
	if err != nil {
		return mergepolicy.Attestation{}, &mergepolicy.Finding{
			Repository: expectation.Repository,
			Code:       mergepolicy.CodeAttestationStale,
			Detail: mergepolicy.BoundDetail(
				"the published merge policy attestation is not valid; republish it from the reviewed schema",
			),
		}
	}
	return attestation, nil
}

func observeRepository(
	ctx context.Context,
	client *apiClient,
	expectation mergepolicy.RepositoryExpectation,
) (mergepolicy.Observed, error) {
	observed := mergepolicy.Observed{}
	// GitHub defaults this endpoint to 30 items per page. A later page could
	// hide a carrying ruleset, so a paginated read is unbounded evidence and
	// fails closed rather than silently truncating the authoritative list.
	activeContent, activeHeaders, err := client.get(
		ctx,
		fmt.Sprintf(
			"repos/%s/rules/branches/%s?per_page=%d",
			expectation.Repository, expectation.DefaultBranch, maxRulesetsPerRun,
		),
	)
	if err != nil {
		return observed, fmt.Errorf("read active rules failed")
	}
	if hasPagination(activeHeaders) {
		return observed, fmt.Errorf("active rule pagination is not supported by the bounded audit")
	}
	var active activeRulesPayload
	if err := strictDecode(activeContent, &active); err != nil {
		return observed, fmt.Errorf("decode active rules failed")
	}
	for _, rule := range active {
		if rule.Type != "required_status_checks" {
			continue
		}
		for _, check := range rule.Parameters.RequiredStatusChecks {
			observed.ActiveChecks = append(observed.ActiveChecks, mergepolicy.ActiveCheck{
				Context:   mergepolicy.SanitizeText(check.Context, mergepolicy.MaxContextBytes),
				RulesetID: rule.RulesetID,
			})
		}
	}

	listContent, listHeaders, err := client.get(
		ctx,
		fmt.Sprintf("repos/%s/rulesets?per_page=%d", expectation.Repository, maxRulesetsPerRun),
	)
	if err != nil {
		return observed, fmt.Errorf("list rulesets failed")
	}
	if hasPagination(listHeaders) {
		return observed, fmt.Errorf("ruleset pagination is not supported by the bounded audit")
	}
	var list []rulesetSummary
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
		if detail.ID != summary.ID {
			return observed, fmt.Errorf("ruleset %d evidence does not match its identity", summary.ID)
		}
		if detail.Enforcement != summary.Enforcement {
			return observed, fmt.Errorf("ruleset %d changed between reads", summary.ID)
		}
		observed.Rulesets = append(observed.Rulesets, rulesetFromDetail(detail))
	}
	// Carrying rulesets are those the per-branch authority reported as active
	// requirements. Every carrier must have full evidence in the ruleset
	// reads; a carrier without a detail read is a retrieval failure.
	carrying := mergepolicy.CarryingRulesetIDs(expectation, observed)
	for _, check := range observed.ActiveChecks {
		if !carrying[check.RulesetID] {
			continue
		}
		if _, known := findRuleset(observed.Rulesets, check.RulesetID); !known {
			return observed, fmt.Errorf("carrying ruleset id %d is missing from the ruleset evidence", check.RulesetID)
		}
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

func findRuleset(rulesets []mergepolicy.Ruleset, id int64) (mergepolicy.Ruleset, bool) {
	for _, ruleset := range rulesets {
		if ruleset.ID == id {
			return ruleset, true
		}
	}
	return mergepolicy.Ruleset{}, false
}

func rulesetFromDetail(detail rulesetDetailPayload) mergepolicy.Ruleset {
	// The raw name and required contexts are kept for exact comparison with
	// the consumer attestation; rulesetCarrier sanitizes them at render time.
	ruleset := mergepolicy.Ruleset{
		ID:          detail.ID,
		Name:        detail.Name,
		Enforcement: detail.Enforcement,
	}
	for _, rule := range detail.Rules {
		if rule.Type != "required_status_checks" {
			continue
		}
		for _, check := range rule.Parameters.RequiredStatusChecks {
			ruleset.RequiredChecks = append(ruleset.RequiredChecks, mergepolicy.RequiredCheck{
				Context: check.Context,
			})
		}
	}
	if detail.BypassActors != nil {
		ruleset.BypassKnown = true
		for _, actor := range *detail.BypassActors {
			ruleset.BypassActors = append(ruleset.BypassActors, mergepolicy.RuleBypassActor{
				ActorType: mergepolicy.SanitizeText(actor.ActorType, 32),
				ActorID:   actor.ActorID,
				Mode:      mergepolicy.SanitizeText(actor.BypassMode, 32),
			})
		}
	}
	return ruleset
}

func protectionChecks(payload protectionPayload) []mergepolicy.RequiredCheck {
	checks := make([]mergepolicy.RequiredCheck, 0, len(payload.RequiredStatusChecks.Checks)+len(payload.RequiredStatusChecks.Contexts))
	for _, check := range payload.RequiredStatusChecks.Checks {
		checks = append(checks, mergepolicy.RequiredCheck{Context: mergepolicy.SanitizeText(check.Context, mergepolicy.MaxContextBytes)})
	}
	for _, context := range payload.RequiredStatusChecks.Contexts {
		sanitized := mergepolicy.SanitizeText(context, mergepolicy.MaxContextBytes)
		duplicate := false
		for _, check := range checks {
			if check.Context == sanitized {
				duplicate = true
				break
			}
		}
		if !duplicate {
			checks = append(checks, mergepolicy.RequiredCheck{Context: sanitized})
		}
	}
	return checks
}

func hasPagination(headers http.Header) bool {
	// A ruleset list that names a next page is unbounded evidence for this
	// audit, because the bounded single read could miss carrying rulesets.
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

func sortAudit(audit mergepolicy.Audit) {
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
