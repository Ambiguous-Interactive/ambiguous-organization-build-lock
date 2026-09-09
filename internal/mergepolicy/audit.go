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
	CodeAttestationMissing  = "merge-policy-attestation-missing"
	CodeAttestationStale    = "merge-policy-attestation-stale"
)

const (
	enforcementActive            = "active"
	enforcementActiveAdminBypass = "active-admin-bypass"
	modeDefault                  = "always"
)

// ActiveCheck is one required status check that GitHub itself reports as
// active on the audited default branch. The per-branch rules endpoint is the
// authority for targeting, so no condition matching happens here.
type ActiveCheck struct {
	Context   string
	RulesetID int64
}

// RuleBypassActor is one bypass identity observed on a ruleset. Attested
// marks actors whose evidence came from the consumer attestation file
// instead of the live API response.
type RuleBypassActor struct {
	ActorType string
	ActorID   int64
	Mode      string
	Attested  bool
}

// Ruleset is the observed state of one repository ruleset. BypassKnown
// records whether the API response carried the bypass_actors key at all:
// GitHub omits the key for callers without write access to the ruleset,
// and an omitted key must never be read as an empty list.
type Ruleset struct {
	ID             int64
	Name           string
	Enforcement    string
	RequiredChecks []RequiredCheck
	BypassActors   []RuleBypassActor
	BypassKnown    bool
}

// RequiredCheck is one declared check requirement inside a ruleset.
type RequiredCheck struct {
	Context string
}

// Protection is the observed classic branch protection of a default branch.
type Protection struct {
	Present        bool
	AdminEnforced  bool
	RequiredChecks []RequiredCheck
}

// Observed is the live merge-policy evidence for one repository.
type Observed struct {
	// ActiveChecks is the per-branch endpoint's authoritative list of active
	// required checks, which already resolves ruleset conditions.
	ActiveChecks []ActiveCheck
	Rulesets     []Ruleset
	Protection   Protection
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

	rulesetNames := make(map[int64]string, len(observed.Rulesets))
	for _, ruleset := range observed.Rulesets {
		rulesetNames[ruleset.ID] = ruleset.Name
	}

	requiresActive := func(context string) bool {
		for _, check := range observed.ActiveChecks {
			if check.Context == context {
				return true
			}
		}
		return false
	}
	protectionRequires := func(context string) bool {
		return observed.Protection.Present && containsContext(observed.Protection.RequiredChecks, context)
	}

	if observed.Protection.Present {
		for _, check := range observed.Protection.RequiredChecks {
			inventory = append(inventory, InventoryEntry{
				Repository:  expectation.Repository,
				Kind:        kindBranchProtection,
				Carrier:     "default branch protection",
				Context:     check.Context,
				Enforcement: protectionEnforcement(observed.Protection),
			})
		}
	}
	for _, check := range observed.ActiveChecks {
		inventory = append(inventory, InventoryEntry{
			Repository:  expectation.Repository,
			Kind:        kindRuleset,
			Carrier:     rulesetCarrier(rulesetNames[check.RulesetID], check.RulesetID),
			Context:     check.Context,
			Enforcement: enforcementActive,
		})
	}

	for _, context := range expectation.RequiredContexts {
		if protectionRequires(context) || requiresActive(context) {
			continue
		}
		if renamed, carrier := caseRenamed(context, observed); renamed != "" {
			findings = append(findings, Finding{
				Repository: expectation.Repository,
				Code:       CodeRenamedRequiredContext,
				Context:    context,
				Detail: BoundDetail(fmt.Sprintf(
					"required context is spelled %q in %s; restore the reviewed spelling %q",
					renamed, carrier, context,
				)),
			})
			continue
		}
		if disabled := disabledCarrier(context, observed.Rulesets); disabled != "" {
			findings = append(findings, Finding{
				Repository: expectation.Repository,
				Code:       CodeDisabledRuleset,
				Context:    context,
				Detail:     BoundDetail(disabled),
			})
			continue
		}
		findings = append(findings, Finding{
			Repository: expectation.Repository,
			Code:       CodeMissingRequiredContext,
			Context:    context,
		})
	}

	findings = append(findings, bypassFindings(expectation, observed)...)

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

func rulesetCarrier(name string, id int64) string {
	if name == "" {
		name = "unknown"
	}
	// Rule names come from live API evidence, so they are sanitized here at
	// the only place they reach a published detail. The audit compares the
	// raw name and required contexts against the consumer attestation.
	return fmt.Sprintf("ruleset %s (id %d)", SanitizeText(name, MaxContextBytes), id)
}

func containsContext(checks []RequiredCheck, context string) bool {
	for _, check := range checks {
		if check.Context == context {
			return true
		}
	}
	return false
}

// CarryingRulesetIDs returns the active rulesets that require a reviewed
// context, keyed by id. The per-branch rules endpoint is the carriage
// authority, so a ruleset's own declared checks never make it a carrier.
func CarryingRulesetIDs(expectation RepositoryExpectation, observed Observed) map[int64]bool {
	carriers := make(map[int64]bool)
	for _, check := range observed.ActiveChecks {
		for _, expected := range expectation.RequiredContexts {
			if check.Context == expected {
				carriers[check.RulesetID] = true
			}
		}
	}
	return carriers
}

// caseRenamed reports an active requirement that differs from the reviewed
// context only by letter case, plus the carrier that requires it.
func caseRenamed(context string, observed Observed) (string, string) {
	for _, check := range observed.ActiveChecks {
		if strings.EqualFold(check.Context, context) {
			return check.Context, "the active rules on the default branch"
		}
	}
	if observed.Protection.Present {
		for _, check := range observed.Protection.RequiredChecks {
			if strings.EqualFold(check.Context, context) {
				return check.Context, "default branch protection"
			}
		}
	}
	return "", ""
}

// disabledCarrier names an inactive ruleset that still declares the reviewed
// context, so the drift reads as a disabled gate, not a missing one.
func disabledCarrier(context string, rulesets []Ruleset) string {
	for _, ruleset := range rulesets {
		if ruleset.Enforcement == enforcementActive {
			continue
		}
		if containsContext(ruleset.RequiredChecks, context) {
			return fmt.Sprintf(
				"%s is %s; set the ruleset enforcement to active",
				rulesetCarrier(ruleset.Name, ruleset.ID), ruleset.Enforcement,
			)
		}
	}
	return ""
}

func bypassFindings(expectation RepositoryExpectation, observed Observed) []Finding {
	requiresExpected := func(contexts []string) bool {
		for _, expected := range expectation.RequiredContexts {
			for _, context := range contexts {
				if context == expected {
					return true
				}
			}
		}
		return false
	}
	carriers := CarryingRulesetIDs(expectation, observed)
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
			Detail:     BoundDetail(detail),
		})
	}
	for _, ruleset := range observed.Rulesets {
		if !carriers[ruleset.ID] || ruleset.Enforcement != enforcementActive {
			continue
		}
		for _, actor := range ruleset.BypassActors {
			if allowedBypass(expectation.AllowedBypassActors, actor) {
				continue
			}
			detail := fmt.Sprintf(
				"%s grants actor type %s id %d bypass mode %s",
				rulesetCarrier(ruleset.Name, ruleset.ID), actor.ActorType, actor.ActorID, bypassMode(actor.Mode),
			)
			if actor.Attested {
				detail += " (attested)"
			}
			add(CodeUnexpectedBypassActor, "", detail)
		}
	}
	if expectation.RequireAdminEnforcement &&
		observed.Protection.Present &&
		requiresExpected(contextsOf(observed.Protection.RequiredChecks)) &&
		!observed.Protection.AdminEnforced {
		add(
			CodeUnexpectedBypassActor,
			"",
			"default branch protection lets repository administrators bypass required checks",
		)
	}
	return findings
}

func contextsOf(checks []RequiredCheck) []string {
	contexts := make([]string, 0, len(checks))
	for _, check := range checks {
		contexts = append(contexts, check.Context)
	}
	return contexts
}

func allowedBypass(allowed []BypassActor, actor RuleBypassActor) bool {
	for _, candidate := range allowed {
		if candidate.ActorType == actor.ActorType && candidate.ActorID == actor.ActorID {
			// Acceptance is scoped to the reviewed bypass mode; an omitted
			// reviewed mode records the default always mode.
			return bypassMode(candidate.Mode) == bypassMode(actor.Mode)
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
