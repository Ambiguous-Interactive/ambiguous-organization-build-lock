package mergepolicy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"sort"
)

const (
	// AttestationPath is the only attestation location the audit reads.
	AttestationPath = ".github/merge-policy-attestation.json"
	// MaxAttestationBytes bounds the published attestation file.
	MaxAttestationBytes = 64 * 1024
	// MaxAttestedRulesets bounds one repository's attested ruleset list.
	MaxAttestedRulesets = 32
	// MaxAttestedBypassActors bounds one attested ruleset's actor list.
	MaxAttestedBypassActors = 32

	attestationEnforcementActive = "active"
	attestationSchemaVersion     = 1
)

// AttestedBypassActor is one bypass identity the consumer attests for a
// ruleset. The fields mirror the API response; an empty BypassMode means
// the default mode, which is always.
type AttestedBypassActor struct {
	ActorType  string `json:"actorType"`
	ActorID    int64  `json:"actorId"`
	BypassMode string `json:"bypassMode,omitempty"`
}

// AttestedRuleset is the consumer's attested state of one carrying ruleset.
// The visible fields exist so the audit can prove the attestation is fresh:
// any divergence from the live ruleset is a finding.
type AttestedRuleset struct {
	RulesetID        int64                 `json:"rulesetId"`
	RulesetName      string                `json:"rulesetName"`
	Enforcement      string                `json:"enforcement"`
	RequiredContexts []string              `json:"requiredContexts"`
	BypassActors     []AttestedBypassActor `json:"bypassActors"`
}

// Attestation is the consumer-published evidence file that fills the one
// bypass blind spot of a read-only caller.
type Attestation struct {
	SchemaVersion int               `json:"schemaVersion"`
	Repository    string            `json:"repository"`
	Rulesets      []AttestedRuleset `json:"rulesets"`
}

// ParseAttestation strictly validates one published attestation file
// without accepting unknown JSON fields or trailing values.
func ParseAttestation(content []byte, repository string) (Attestation, error) {
	if len(content) == 0 || len(content) > MaxAttestationBytes {
		return Attestation{}, fmt.Errorf("merge policy attestation size is invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	var attestation Attestation
	if err := decoder.Decode(&attestation); err != nil {
		return Attestation{}, fmt.Errorf("decode merge policy attestation: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return Attestation{}, fmt.Errorf("merge policy attestation must contain one JSON value")
	}
	if attestation.SchemaVersion != attestationSchemaVersion {
		return Attestation{}, fmt.Errorf("merge policy attestation schemaVersion must be 1")
	}
	if attestation.Repository != repository {
		return Attestation{}, fmt.Errorf("merge policy attestation names another repository")
	}
	if len(attestation.Rulesets) > MaxAttestedRulesets {
		return Attestation{}, fmt.Errorf("merge policy attestation exceeds the ruleset bound")
	}
	seenRulesets := make(map[int64]bool, len(attestation.Rulesets))
	for index := range attestation.Rulesets {
		entry := &attestation.Rulesets[index]
		if entry.RulesetID <= 0 {
			return Attestation{}, fmt.Errorf("merge policy attestation contains an invalid ruleset id")
		}
		if seenRulesets[entry.RulesetID] {
			return Attestation{}, fmt.Errorf("merge policy attestation contains a duplicate ruleset id")
		}
		seenRulesets[entry.RulesetID] = true
		if !validAttestedText(entry.RulesetName) {
			return Attestation{}, fmt.Errorf("merge policy attestation contains an invalid ruleset name")
		}
		if entry.Enforcement != attestationEnforcementActive {
			return Attestation{}, fmt.Errorf("merge policy attestation contains a non-active enforcement")
		}
		if len(entry.RequiredContexts) == 0 || len(entry.RequiredContexts) > MaxContextsPerRepository {
			return Attestation{}, fmt.Errorf("merge policy attestation contains an invalid required context count")
		}
		seenContexts := make(map[string]bool, len(entry.RequiredContexts))
		for _, context := range entry.RequiredContexts {
			if !validAttestedText(context) {
				return Attestation{}, fmt.Errorf("merge policy attestation contains an invalid required context")
			}
			if seenContexts[context] {
				return Attestation{}, fmt.Errorf("merge policy attestation contains a duplicate required context")
			}
			seenContexts[context] = true
		}
		if len(entry.BypassActors) > MaxAttestedBypassActors {
			return Attestation{}, fmt.Errorf("merge policy attestation exceeds the bypass actor bound")
		}
		seenActors := make(map[string]bool, len(entry.BypassActors))
		for _, actor := range entry.BypassActors {
			if !validActorType(actor.ActorType) || actor.ActorID <= 0 {
				return Attestation{}, fmt.Errorf("merge policy attestation contains an invalid bypass actor")
			}
			if !validBypassMode(actor.BypassMode) {
				return Attestation{}, fmt.Errorf("merge policy attestation contains an invalid bypass mode")
			}
			actorKey := actor.ActorType + "\x00" + fmt.Sprint(actor.ActorID)
			if seenActors[actorKey] {
				return Attestation{}, fmt.Errorf("merge policy attestation contains a duplicate bypass actor")
			}
			seenActors[actorKey] = true
		}
	}
	sortAttestedRulesets(attestation.Rulesets)
	return attestation, nil
}

// ResolveBypassEvidence fills the one bypass blind spot of a read-only
// caller. GitHub returns ruleset bypass actors only to callers with write
// access to the ruleset, so for that one field the consumer-published
// attestation is the remaining evidence. The resolver never turns missing
// evidence into a pass: a carrying ruleset without live bypass evidence
// and without a fresh attestation fails the audit closed.
//
// It returns the observed state with attested actors filled in, the ruleset
// ids whose actors were attested, fail-closed health findings, and whether
// the repository evidence is complete. Health findings that do not hide
// live evidence keep the audit complete; the finding itself still fails
// the run.
func ResolveBypassEvidence(
	expectation RepositoryExpectation,
	observed Observed,
	attestation Attestation,
) (Observed, []int64, []Finding, bool) {
	carriers := CarryingRulesetIDs(expectation, observed)
	entries := make(map[int64]AttestedRuleset, len(attestation.Rulesets))
	for _, entry := range attestation.Rulesets {
		entries[entry.RulesetID] = entry
	}
	resolved := observed
	attestedIDs := make([]int64, 0)
	health := make([]Finding, 0)
	complete := true
	for index := range resolved.Rulesets {
		ruleset := resolved.Rulesets[index]
		if !carriers[ruleset.ID] || ruleset.Enforcement != enforcementActive {
			continue
		}
		entry, hasEntry := entries[ruleset.ID]
		if ruleset.BypassKnown {
			if hasEntry && !attestationMatchesRuleset(entry, ruleset) {
				health = append(health, Finding{
					Repository: expectation.Repository,
					Code:       CodeAttestationStale,
					Detail: BoundDetail(fmt.Sprintf(
						"attestation for %s is not fresh; update %s to the live ruleset",
						rulesetCarrier(ruleset.Name, ruleset.ID), AttestationPath,
					)),
				})
			}
			continue
		}
		if !hasEntry {
			health = append(health, Finding{
				Repository: expectation.Repository,
				Code:       CodeAttestationMissing,
				Detail: BoundDetail(fmt.Sprintf(
					"bypass actor evidence for %s is unavailable and no attestation is published; publish %s",
					rulesetCarrier(ruleset.Name, ruleset.ID), AttestationPath,
				)),
			})
			complete = false
			continue
		}
		if !attestationMatchesRuleset(entry, ruleset) {
			health = append(health, Finding{
				Repository: expectation.Repository,
				Code:       CodeAttestationStale,
				Detail: BoundDetail(fmt.Sprintf(
					"attestation for %s is not fresh; update %s to the live ruleset",
					rulesetCarrier(ruleset.Name, ruleset.ID), AttestationPath,
				)),
			})
			complete = false
			continue
		}
		actors := make([]RuleBypassActor, 0, len(entry.BypassActors))
		for _, actor := range entry.BypassActors {
			actors = append(actors, RuleBypassActor{
				ActorType: actor.ActorType,
				ActorID:   actor.ActorID,
				Mode:      bypassMode(actor.BypassMode),
				Attested:  true,
			})
		}
		resolved.Rulesets[index].BypassActors = actors
		resolved.Rulesets[index].BypassKnown = true
		attestedIDs = append(attestedIDs, ruleset.ID)
	}
	for _, entry := range attestation.Rulesets {
		if carriers[entry.RulesetID] {
			continue
		}
		health = append(health, Finding{
			Repository: expectation.Repository,
			Code:       CodeAttestationStale,
			Detail: BoundDetail(fmt.Sprintf(
				"attestation names %s which does not carry a reviewed context; update or remove the entry",
				rulesetCarrier(entry.RulesetName, entry.RulesetID),
			)),
		})
	}
	sortFindings(health)
	sort.Slice(attestedIDs, func(i, j int) bool { return attestedIDs[i] < attestedIDs[j] })
	return resolved, attestedIDs, health, complete
}

// attestationMatchesRuleset proves the attestation is fresh: every field
// the audit can read live must equal the live ruleset, and the attested
// bypass actors must equal the live actors when those are visible.
func attestationMatchesRuleset(entry AttestedRuleset, ruleset Ruleset) bool {
	if entry.RulesetName != ruleset.Name || entry.Enforcement != ruleset.Enforcement {
		return false
	}
	contexts := make([]string, 0, len(ruleset.RequiredChecks))
	for _, check := range ruleset.RequiredChecks {
		contexts = append(contexts, check.Context)
	}
	if !equalStrings(entry.RequiredContexts, contexts) {
		return false
	}
	if !ruleset.BypassKnown {
		return true
	}
	if len(ruleset.BypassActors) != len(entry.BypassActors) {
		return false
	}
	live := make(map[string]int, len(ruleset.BypassActors))
	for _, actor := range ruleset.BypassActors {
		live[actorKey(actor.ActorType, actor.ActorID, actor.Mode)]++
	}
	for _, actor := range entry.BypassActors {
		key := actorKey(actor.ActorType, actor.ActorID, actor.BypassMode)
		count, ok := live[key]
		if !ok || count == 0 {
			return false
		}
		live[key] = count - 1
	}
	for _, count := range live {
		if count != 0 {
			return false
		}
	}
	return true
}

func actorKey(actorType string, actorID int64, mode string) string {
	return actorType + "\x00" + fmt.Sprint(actorID) + "\x00" + bypassMode(mode)
}

func validBypassMode(mode string) bool {
	switch mode {
	case "", "always", "pull_request":
		return true
	default:
		return false
	}
}

// validAttestedText bounds attested ruleset names and required contexts.
// GitHub check contexts and ruleset names can contain characters outside
// the publishable alphabet, so the attestation compares raw values; only
// length and control characters are restricted here. Everything the audit
// publishes is sanitized at render time.
func validAttestedText(value string) bool {
	if value == "" || len(value) > MaxContextBytes {
		return false
	}
	for _, char := range value {
		if char < 0x20 || char == 0x7f {
			return false
		}
	}
	return true
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	sortedLeft := append([]string(nil), left...)
	sortedRight := append([]string(nil), right...)
	sort.Strings(sortedLeft)
	sort.Strings(sortedRight)
	for index := range sortedLeft {
		if sortedLeft[index] != sortedRight[index] {
			return false
		}
	}
	return true
}

func sortAttestedRulesets(rulesets []AttestedRuleset) {
	sort.Slice(rulesets, func(i, j int) bool {
		return rulesets[i].RulesetID < rulesets[j].RulesetID
	})
}
