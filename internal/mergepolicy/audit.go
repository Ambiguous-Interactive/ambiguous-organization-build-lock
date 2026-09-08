package mergepolicy

import (
	"fmt"
	"sort"
	"strings"
)

// Reason codes reported by the merge-policy audit. Each code maps to its
// reviewed fix in docs/consumer-enrollment.md.
const (
	CodeMissingRequiredContext = "missing-required-context"
	CodeRenamedRequiredContext = "renamed-required-context"
	CodeDisabledRuleset        = "disabled-ruleset"
	CodeUnexpectedBypassActor  = "unexpected-bypass-actor"
)

// Observed reason codes are emitted by the command that reads live evidence.
const (
	CodeRetrievalIncomplete = "merge-policy-retrieval-incomplete"
)

const (
	enforcementActive            = "active"
	enforcementActiveAdminBypass = "active-admin-bypass"
	modeDefault                  = "always"
)

// RequiredCheck is one status check requirement observed on a default branch.
type RequiredCheck struct {
	Context string
}

// RuleBypassActor is one bypass identity observed on a ruleset.
type RuleBypassActor struct {
	ActorType string
	ActorID   int64
	Mode      string
}

// Ruleset is the observed state of one repository ruleset.
type Ruleset struct {
	ID                   int64
	Name                 string
	Enforcement          string
	TargetsDefaultBranch bool
	RequiredChecks       []RequiredCheck
	BypassActors         []RuleBypassActor
}

// Protection is the observed classic branch protection of a default branch.
type Protection struct {
	Present        bool
	AdminEnforced  bool
	RequiredChecks []RequiredCheck
}

// Observed is the live merge-policy evidence for one repository.
type Observed struct {
	Rulesets   []Ruleset
	Protection Protection
}

// Finding is one sanitized, source-free merge-policy result.
type Finding struct {
	Repository string `json:"repository"`
	Code       string `json:"code"`
	Context    string `json:"context,omitempty"`
	Detail     string `json:"detail,omitempty"`
}

// InventoryEntry is one observed required check on a default branch. It is
// operator-visible evidence; it never contains secret values.
type InventoryEntry struct {
	Repository  string `json:"repository"`
	Kind        string `json:"kind"`
	Carrier     string `json:"carrier"`
	Context     string `json:"context"`
	Enforcement string `json:"enforcement"`
}

const (
	kindRuleset          = "ruleset"
	kindBranchProtection = "branch-protection"
)

// Analyze compares one reviewed expectation with live evidence. It reports
// every divergence; it never assumes a missing read is a pass.
func Analyze(expectation RepositoryExpectation, observed Observed) ([]Finding, []InventoryEntry) {
	findings := make([]Finding, 0)
	inventory := make([]InventoryEntry, 0)

	active := make([]Ruleset, 0, len(observed.Rulesets))
	for _, ruleset := range observed.Rulesets {
		if ruleset.Enforcement == enforcementActive && ruleset.TargetsDefaultBranch {
			active = append(active, ruleset)
		}
	}

	requires := func(checks []RequiredCheck, context string) bool {
		for _, check := range checks {
			if check.Context == context {
				return true
			}
		}
		return false
	}
	protectionRequires := func(context string) bool {
		return observed.Protection.Present && requires(observed.Protection.RequiredChecks, context)
	}

	classic := observed.Protection.RequiredChecks
	if observed.Protection.Present {
		for _, check := range classic {
			inventory = append(inventory, InventoryEntry{
				Repository:  expectation.Repository,
				Kind:        kindBranchProtection,
				Carrier:     "default branch protection",
				Context:     check.Context,
				Enforcement: protectionEnforcement(observed.Protection),
			})
		}
	}
	for _, ruleset := range active {
		for _, check := range ruleset.RequiredChecks {
			inventory = append(inventory, InventoryEntry{
				Repository:  expectation.Repository,
				Kind:        kindRuleset,
				Carrier:     rulesetDisplayName(ruleset),
				Context:     check.Context,
				Enforcement: ruleset.Enforcement,
			})
		}
	}

	for _, context := range expectation.RequiredContexts {
		if protectionRequires(context) {
			continue
		}
		carried := false
		for _, ruleset := range active {
			if requires(ruleset.RequiredChecks, context) {
				carried = true
				break
			}
		}
		if carried {
			continue
		}
		if renamed, carrier := caseRenamed(context, classic, active); renamed != "" {
			findings = append(findings, Finding{
				Repository: expectation.Repository,
				Code:       CodeRenamedRequiredContext,
				Context:    context,
				Detail: fmt.Sprintf(
					"required context is spelled %q in %s; restore the reviewed spelling %q",
					renamed, carrier, context,
				),
			})
			continue
		}
		if disabled := disabledCarrier(context, observed.Rulesets); disabled != "" {
			findings = append(findings, Finding{
				Repository: expectation.Repository,
				Code:       CodeDisabledRuleset,
				Context:    context,
				Detail:     disabled,
			})
			continue
		}
		findings = append(findings, Finding{
			Repository: expectation.Repository,
			Code:       CodeMissingRequiredContext,
			Context:    context,
		})
	}

	findings = append(findings, bypassFindings(expectation, observed, requires, active)...)

	sortFindings(findings)
	sortInventory(inventory)
	return findings, inventory
}

func protectionEnforcement(protection Protection) string {
	if protection.AdminEnforced {
		return enforcementActive
	}
	return enforcementActiveAdminBypass
}

func rulesetDisplayName(ruleset Ruleset) string {
	return fmt.Sprintf("ruleset %s (id %d)", ruleset.Name, ruleset.ID)
}

// caseRenamed reports an active requirement that differs from the reviewed
// context only by letter case, plus the carrier that requires it.
func caseRenamed(context string, classic []RequiredCheck, active []Ruleset) (string, string) {
	for _, check := range classic {
		if strings.EqualFold(check.Context, context) {
			return check.Context, "default branch protection"
		}
	}
	for _, ruleset := range active {
		for _, check := range ruleset.RequiredChecks {
			if strings.EqualFold(check.Context, context) {
				return check.Context, rulesetDisplayName(ruleset)
			}
		}
	}
	return "", ""
}

// disabledCarrier names an inactive ruleset that still declares the reviewed
// context, so the drift reads as a disabled gate, not a missing one.
func disabledCarrier(context string, rulesets []Ruleset) string {
	for _, ruleset := range rulesets {
		if !ruleset.TargetsDefaultBranch || ruleset.Enforcement == "active" {
			continue
		}
		for _, check := range ruleset.RequiredChecks {
			if check.Context == context {
				return fmt.Sprintf(
					"%s is %s; set the ruleset enforcement to active",
					rulesetDisplayName(ruleset), ruleset.Enforcement,
				)
			}
		}
	}
	return ""
}

func bypassFindings(
	expectation RepositoryExpectation,
	observed Observed,
	requires func([]RequiredCheck, string) bool,
	active []Ruleset,
) []Finding {
	requiresExpected := func(checks []RequiredCheck) bool {
		for _, context := range expectation.RequiredContexts {
			if requires(checks, context) {
				return true
			}
		}
		return false
	}
	findings := make([]Finding, 0)
	seen := make(map[string]bool)
	add := func(code, context, detail string) {
		key := code + "\x00" + context + "\x00" + detail
		if seen[key] {
			return
		}
		seen[key] = true
		findings = append(findings, Finding{
			Repository: expectation.Repository,
			Code:       code,
			Context:    context,
			Detail:     detail,
		})
	}
	for _, ruleset := range active {
		if !requiresExpected(ruleset.RequiredChecks) {
			continue
		}
		for _, actor := range ruleset.BypassActors {
			if allowedBypass(expectation.AllowedBypassActors, actor) {
				continue
			}
			add(
				CodeUnexpectedBypassActor,
				"",
				fmt.Sprintf(
					"%s grants actor type %s id %d bypass mode %s",
					rulesetDisplayName(ruleset), actor.ActorType, actor.ActorID, bypassMode(actor.Mode),
				),
			)
		}
	}
	if expectation.RequireAdminEnforcement &&
		observed.Protection.Present &&
		requiresExpected(observed.Protection.RequiredChecks) &&
		!observed.Protection.AdminEnforced {
		add(
			CodeUnexpectedBypassActor,
			"",
			"default branch protection lets repository administrators bypass required checks",
		)
	}
	return findings
}

func allowedBypass(allowed []BypassActor, actor RuleBypassActor) bool {
	for _, candidate := range allowed {
		if candidate.ActorType == actor.ActorType && candidate.ActorID == actor.ActorID {
			return true
		}
	}
	return false
}

func bypassMode(mode string) string {
	if mode == "" {
		return modeDefault
	}
	return mode
}

func sortFindings(findings []Finding) {
	sort.Slice(findings, func(i, j int) bool {
		left, right := findings[i], findings[j]
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

func sortInventory(inventory []InventoryEntry) {
	sort.Slice(inventory, func(i, j int) bool {
		left, right := inventory[i], inventory[j]
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
}
