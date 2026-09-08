package mergepolicy

import (
	"reflect"
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

func activeRuleset(checks ...string) Ruleset {
	ruleset := Ruleset{
		ID:                   17663217,
		Name:                 "Required CI",
		Enforcement:          "active",
		TargetsDefaultBranch: true,
	}
	for _, check := range checks {
		ruleset.RequiredChecks = append(ruleset.RequiredChecks, RequiredCheck{Context: check})
	}
	return ruleset
}

func codes(findings []Finding) []string {
	result := make([]string, 0, len(findings))
	for _, finding := range findings {
		result = append(result, finding.Code)
	}
	return result
}

func TestAnalyzeAcceptsClassicProtectionAndActiveRulesetCarriers(t *testing.T) {
	observed := Observed{
		Rulesets:   []Ruleset{activeRuleset("Unity CI Success")},
		Protection: Protection{Present: true, AdminEnforced: true, RequiredChecks: []RequiredCheck{{Context: "other"}}},
	}
	findings, inventory := Analyze(expectation(), observed)
	if len(findings) != 0 {
		t.Fatalf("expected no findings, got %+v", findings)
	}
	if !hasInventory(inventory, kindRuleset, "Unity CI Success") ||
		!hasInventory(inventory, kindBranchProtection, "other") {
		t.Fatalf("inventory does not record the observed carriers: %+v", inventory)
	}
}

func TestAnalyzeReportsMissingRequiredContext(t *testing.T) {
	findings, _ := Analyze(expectation(), Observed{})
	if want := []string{CodeMissingRequiredContext}; !reflect.DeepEqual(codes(findings), want) {
		t.Fatalf("codes = %v, want %v", codes(findings), want)
	}
	if findings[0].Context != "Unity CI Success" {
		t.Fatalf("finding context = %q", findings[0].Context)
	}
}

func TestAnalyzeReportsCaseRenameInsteadOfMissing(t *testing.T) {
	observed := Observed{Rulesets: []Ruleset{activeRuleset("unity ci success")}}
	findings, _ := Analyze(expectation(), observed)
	if want := []string{CodeRenamedRequiredContext}; !reflect.DeepEqual(codes(findings), want) {
		t.Fatalf("codes = %v, want %v", codes(findings), want)
	}
	if findings[0].Detail == "" {
		t.Fatalf("rename finding must name the observed spelling")
	}
}

func TestAnalyzeReportsDisabledRuleset(t *testing.T) {
	disabled := activeRuleset("Unity CI Success")
	disabled.Enforcement = "disabled"
	findings, _ := Analyze(expectation(), Observed{Rulesets: []Ruleset{disabled}})
	if want := []string{CodeDisabledRuleset}; !reflect.DeepEqual(codes(findings), want) {
		t.Fatalf("codes = %v, want %v", codes(findings), want)
	}
	if findings[0].Detail == "" {
		t.Fatalf("disabled finding must name the ruleset and enforcement")
	}
}

func TestAnalyzeIgnoresRulesetsThatTargetOtherBranches(t *testing.T) {
	elsewhere := activeRuleset("Unity CI Success")
	elsewhere.TargetsDefaultBranch = false
	findings, _ := Analyze(expectation(), Observed{Rulesets: []Ruleset{elsewhere}})
	if want := []string{CodeMissingRequiredContext}; !reflect.DeepEqual(codes(findings), want) {
		t.Fatalf("codes = %v, want %v", codes(findings), want)
	}
}

func TestAnalyzeReportsUnexpectedRulesetBypassActors(t *testing.T) {
	ruleset := activeRuleset("Unity CI Success")
	ruleset.BypassActors = []RuleBypassActor{
		{ActorType: "OrganizationAdmin", ActorID: 5, Mode: "pull_request"},
		{ActorType: "Team", ActorID: 9, Mode: "always"},
	}
	expectation := expectation()
	expectation.AllowedBypassActors = []BypassActor{{ActorType: "Team", ActorID: 9}}
	findings, _ := Analyze(expectation, Observed{Rulesets: []Ruleset{ruleset}})
	if len(findings) != 1 || findings[0].Code != CodeUnexpectedBypassActor {
		t.Fatalf("codes = %v, want only the unallowed actor", codes(findings))
	}
	if !strings.Contains(findings[0].Detail, "OrganizationAdmin") ||
		!strings.Contains(findings[0].Detail, "pull_request") {
		t.Fatalf("bypass detail must name the actor and mode: %q", findings[0].Detail)
	}
}

func TestAnalyzeDeduplicatesRepeatedBypassActors(t *testing.T) {
	first := activeRuleset("Unity CI Success")
	second := activeRuleset("other")
	first.BypassActors = []RuleBypassActor{{ActorType: "OrganizationAdmin", ActorID: 5, Mode: "always"}}
	second.ID = 2
	second.Name = "Second"
	second.BypassActors = []RuleBypassActor{{ActorType: "OrganizationAdmin", ActorID: 5, Mode: "always"}}
	findings, _ := Analyze(expectation(), Observed{Rulesets: []Ruleset{first, second}})
	if len(findings) != 1 {
		t.Fatalf("codes = %v, want one deduplicated bypass finding", codes(findings))
	}
}

func TestAnalyzeReportsClassicAdminBypass(t *testing.T) {
	protection := Protection{
		Present:        true,
		AdminEnforced:  false,
		RequiredChecks: []RequiredCheck{{Context: "Unity CI Success"}},
	}
	findings, _ := Analyze(expectation(), Observed{Protection: protection})
	if want := []string{CodeUnexpectedBypassActor}; !reflect.DeepEqual(codes(findings), want) {
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

func TestAnalyzeBypassEvidenceIgnoresCarriersWithoutExpectedContexts(t *testing.T) {
	ruleset := activeRuleset("unrelated")
	ruleset.BypassActors = []RuleBypassActor{{ActorType: "OrganizationAdmin", ActorID: 5, Mode: "always"}}
	findings, _ := Analyze(expectation(), Observed{Rulesets: []Ruleset{ruleset}})
	if want := []string{CodeMissingRequiredContext}; !reflect.DeepEqual(codes(findings), want) {
		t.Fatalf("codes = %v, want %v", codes(findings), want)
	}
}

func hasInventory(inventory []InventoryEntry, kind, context string) bool {
	for _, entry := range inventory {
		if entry.Kind == kind && entry.Context == context {
			return true
		}
	}
	return false
}
