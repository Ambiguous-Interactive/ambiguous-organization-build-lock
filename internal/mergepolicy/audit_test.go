package mergepolicy

import (
	"strings"
	"testing"
)

func expectation() RepositoryExpectation {
	return RepositoryExpectation{
		Repository:              "Ambiguous-Interactive/example",
		DefaultBranch:           "main",
		RequiredContexts:        []string{"Unity CI Success"},
		RequireAdminEnforcement: true,
	}
}

func ruleset(id int64, name, enforcement string, checks ...string) Ruleset {
	ruleset := Ruleset{ID: id, Name: name, Enforcement: enforcement}
	for _, check := range checks {
		ruleset.RequiredChecks = append(ruleset.RequiredChecks, RequiredCheck{Context: check})
	}
	return ruleset
}

func activeCheck(context string, rulesetID int64) ActiveCheck {
	return ActiveCheck{Context: context, RulesetID: rulesetID}
}

func codes(findings []Finding) []string {
	result := make([]string, 0, len(findings))
	for _, finding := range findings {
		result = append(result, finding.Code)
	}
	return result
}

func TestAnalyzeAcceptsActiveRulesetAndClassicProtectionCarriers(t *testing.T) {
	observed := Observed{
		ActiveChecks: []ActiveCheck{activeCheck("Unity CI Success", 4545251)},
		Rulesets:     []Ruleset{ruleset(4545251, "protect main", "active", "Unity CI Success")},
		Protection: Protection{
			Present:       true,
			AdminEnforced: true,
			RequiredChecks: []RequiredCheck{
				{Context: "Engine-free (Qora.Core + Qora.Gen)"},
			},
		},
	}
	findings, inventory := Analyze(expectation(), observed)
	if len(findings) != 0 {
		t.Fatalf("expected no findings, got %+v", findings)
	}
	if !hasInventory(inventory, kindRuleset, "Unity CI Success") ||
		!hasInventory(inventory, kindBranchProtection, "Engine-free (Qora.Core + Qora.Gen)") {
		t.Fatalf("inventory does not record the observed carriers: %+v", inventory)
	}
}

func TestAnalyzeOnlyTrustsThePerBranchAuthorityForCarriage(t *testing.T) {
	// A ruleset whose own details declare the context contributes nothing
	// unless the per-branch rules endpoint reports it as active.
	observed := Observed{
		Rulesets: []Ruleset{ruleset(2, "declared elsewhere", "active", "Unity CI Success")},
	}
	findings, _ := Analyze(expectation(), observed)
	if want := []string{CodeMissingRequiredContext}; !equalCodes(codes(findings), want) {
		t.Fatalf("codes = %v, want %v", codes(findings), want)
	}
}

func TestAnalyzeReportsMissingRequiredContext(t *testing.T) {
	findings, _ := Analyze(expectation(), Observed{})
	if want := []string{CodeMissingRequiredContext}; !equalCodes(codes(findings), want) {
		t.Fatalf("codes = %v, want %v", codes(findings), want)
	}
	if findings[0].Context != "Unity CI Success" {
		t.Fatalf("finding context = %q", findings[0].Context)
	}
}

func TestAnalyzeReportsCaseRenameInsteadOfMissing(t *testing.T) {
	observed := Observed{ActiveChecks: []ActiveCheck{activeCheck("unity ci success", 3)}}
	findings, _ := Analyze(expectation(), observed)
	if want := []string{CodeRenamedRequiredContext}; !equalCodes(codes(findings), want) {
		t.Fatalf("codes = %v, want %v", codes(findings), want)
	}
	if findings[0].Detail == "" {
		t.Fatalf("rename finding must name the observed spelling")
	}
	if len(findings[0].Detail) > MaxDetailBytes {
		t.Fatalf("rename detail exceeds the publishable bound: %d", len(findings[0].Detail))
	}
}

func TestAnalyzeRenameDetailStaysPublishableAtMaximumLength(t *testing.T) {
	longContext := strings.Repeat("a", MaxContextBytes)
	expectation := expectation()
	expectation.RequiredContexts = []string{longContext}
	observed := Observed{
		ActiveChecks: []ActiveCheck{{Context: strings.Repeat("A", MaxContextBytes), RulesetID: 4}},
		Rulesets:     []Ruleset{{ID: 4, Name: strings.Repeat("n", 128), Enforcement: "active"}},
	}
	findings, _ := Analyze(expectation, observed)
	if len(findings) != 1 || findings[0].Code != CodeRenamedRequiredContext {
		t.Fatalf("codes = %v, want the rename finding", codes(findings))
	}
	if len(findings[0].Detail) > MaxDetailBytes {
		t.Fatalf("clamped detail is %d bytes, want at most %d", len(findings[0].Detail), MaxDetailBytes)
	}
}

func TestAnalyzeReportsDisabledRuleset(t *testing.T) {
	disabled := ruleset(17663217, "Required CI", "disabled", "Unity CI Success")
	findings, _ := Analyze(expectation(), Observed{Rulesets: []Ruleset{disabled}})
	if want := []string{CodeDisabledRuleset}; !equalCodes(codes(findings), want) {
		t.Fatalf("codes = %v, want %v", codes(findings), want)
	}
	if findings[0].Detail == "" {
		t.Fatalf("disabled finding must name the ruleset and enforcement")
	}
}

func TestAnalyzeReportsUnexpectedRulesetBypassActors(t *testing.T) {
	ruleset := ruleset(17663217, "Required CI", "active", "Unity CI Success", "other")
	ruleset.BypassActors = []RuleBypassActor{
		{ActorType: "OrganizationAdmin", ActorID: 5, Mode: "pull_request"},
		{ActorType: "Team", ActorID: 9, Mode: "always"},
	}
	expectation := expectation()
	expectation.AllowedBypassActors = []BypassActor{{ActorType: "Team", ActorID: 9}}
	observed := Observed{
		ActiveChecks: []ActiveCheck{activeCheck("Unity CI Success", 17663217)},
		Rulesets:     []Ruleset{ruleset},
	}
	findings, _ := Analyze(expectation, observed)
	if len(findings) != 1 || findings[0].Code != CodeUnexpectedBypassActor {
		t.Fatalf("codes = %v, want only the unallowed actor", codes(findings))
	}
	if !strings.Contains(findings[0].Detail, "OrganizationAdmin") ||
		!strings.Contains(findings[0].Detail, "pull_request") {
		t.Fatalf("bypass detail must name the actor and mode: %q", findings[0].Detail)
	}
}

func TestAnalyzeBypassEvidenceIgnoresInactiveAndUnrelatedRulesets(t *testing.T) {
	first := ruleset(2, "inactive carrier", "disabled", "Unity CI Success")
	first.BypassActors = []RuleBypassActor{{ActorType: "OrganizationAdmin", ActorID: 5, Mode: "always"}}
	second := ruleset(3, "unrelated", "active", "other")
	second.BypassActors = []RuleBypassActor{{ActorType: "OrganizationAdmin", ActorID: 5, Mode: "always"}}
	findings, _ := Analyze(expectation(), Observed{Rulesets: []Ruleset{first, second}})
	// The disabled carrier is diagnosed as a disabled gate, not as bypassed;
	// the unrelated active ruleset produces no evidence at all.
	if want := []string{CodeDisabledRuleset}; !equalCodes(codes(findings), want) {
		t.Fatalf("codes = %v, want %v", codes(findings), want)
	}
}

func TestAnalyzeReportsClassicAdminBypass(t *testing.T) {
	protection := Protection{
		Present:        true,
		AdminEnforced:  false,
		RequiredChecks: []RequiredCheck{{Context: "Unity CI Success"}},
	}
	findings, _ := Analyze(expectation(), Observed{Protection: protection})
	if want := []string{CodeUnexpectedBypassActor}; !equalCodes(codes(findings), want) {
		t.Fatalf("codes = %v, want %v", codes(findings), want)
	}
	if findings[0].Context != "" {
		t.Fatalf("bypass finding is repository-scoped, got context %q", findings[0].Context)
	}

	relaxed := expectation()
	relaxed.RequireAdminEnforcement = false
	findings, _ = Analyze(relaxed, Observed{Protection: protection})
	if len(findings) != 0 {
		t.Fatalf("relaxed expectation must accept the observed protection, got %+v", findings)
	}
}

func TestAnalyzeExemptRepositoryProducesNoFindings(t *testing.T) {
	exempt := expectation()
	exempt.RequiredContexts = nil
	findings, _ := Analyze(exempt, Observed{})
	if len(findings) != 0 {
		t.Fatalf("exempt repository must stay silent, got %+v", findings)
	}
}

func TestAnalyzeReportsBypassEvidencePerCarrier(t *testing.T) {
	first := ruleset(2, "First", "active", "Unity CI Success")
	second := ruleset(3, "Second", "active", "Unity CI Success")
	for _, ruleset := range []*Ruleset{&first, &second} {
		ruleset.BypassActors = []RuleBypassActor{{ActorType: "OrganizationAdmin", ActorID: 5, Mode: "always"}}
	}
	observed := Observed{
		ActiveChecks: []ActiveCheck{
			activeCheck("Unity CI Success", 2),
			activeCheck("Unity CI Success", 3),
		},
		Rulesets: []Ruleset{first, second},
	}
	findings, _ := Analyze(expectation(), observed)
	if len(findings) != 2 || findings[0].Code != CodeUnexpectedBypassActor {
		t.Fatalf("codes = %v, want one bypass finding per carrying ruleset", codes(findings))
	}
	if !strings.Contains(findings[0].Detail, "First") || !strings.Contains(findings[1].Detail, "Second") {
		t.Fatalf("each finding must name its own carrier: %q, %q", findings[0].Detail, findings[1].Detail)
	}
}

func TestSanitizeTextMapsHostileInputIntoThePublishableAlphabet(t *testing.T) {
	cases := map[string]string{
		"Validate YAML & Workflows": "Validate YAML ? Workflows",
		"build (Linux, Release)":    "build (Linux? Release)",
		"naïve":                     "na?ve",
		"pipe|injection":            "pipe?injection",
	}
	for input, want := range cases {
		if got := SanitizeText(input, 128); got != want {
			t.Fatalf("SanitizeText(%q) = %q, want %q", input, got, want)
		}
	}
	sanitized := SanitizeText(strings.Repeat("é", 200), MaxContextBytes)
	if len(sanitized) > MaxContextBytes {
		t.Fatalf("sanitized context exceeds bound: %d", len(sanitized))
	}
	for _, char := range sanitized {
		if !isSanitary(char) {
			t.Fatalf("sanitized output contains unpublishable rune %q", char)
		}
	}
}

func TestBoundDetailClampsToThePublishableBound(t *testing.T) {
	detail := strings.Repeat("a", MaxDetailBytes+50)
	if got := BoundDetail(detail); len(got) != MaxDetailBytes {
		t.Fatalf("BoundDetail length = %d, want %d", len(got), MaxDetailBytes)
	}
	if got := BoundDetail("short"); got != "short" {
		t.Fatalf("BoundDetail changed a short detail: %q", got)
	}
}

func equalCodes(actual, want []string) bool {
	if len(actual) != len(want) {
		return false
	}
	for index := range actual {
		if actual[index] != want[index] {
			return false
		}
	}
	return true
}

func hasInventory(inventory []InventoryEntry, kind, context string) bool {
	for _, entry := range inventory {
		if entry.Kind == kind && entry.Context == context {
			return true
		}
	}
	return false
}
