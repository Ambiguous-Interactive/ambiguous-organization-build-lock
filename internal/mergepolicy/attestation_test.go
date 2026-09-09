package mergepolicy

import (
	"strings"
	"testing"
)

const carrierID = 7

func attestationExpectation() RepositoryExpectation {
	return RepositoryExpectation{
		Repository:       "Ambiguous-Interactive/example",
		DefaultBranch:    "main",
		RequiredContexts: []string{"Unity CI Success"},
	}
}

func liveCarrier(name string, bypassKnown bool, actors ...RuleBypassActor) Observed {
	carrier := Ruleset{
		ID:             carrierID,
		Name:           name,
		Enforcement:    "active",
		RequiredChecks: []RequiredCheck{{Context: "Unity CI Success"}},
		BypassKnown:    bypassKnown,
		BypassActors:   actors,
	}
	return Observed{
		ActiveChecks: []ActiveCheck{{Context: "Unity CI Success", RulesetID: carrierID}},
		Rulesets:     []Ruleset{carrier},
	}
}

func validAttestationContent() string {
	return `{
  "schemaVersion": 1,
  "repository": "Ambiguous-Interactive/example",
  "rulesets": [
    {
      "rulesetId": 7,
      "rulesetName": "Required CI (default branch)",
      "enforcement": "active",
      "requiredContexts": ["Unity CI Success"],
      "bypassActors": [
        {"actorType": "Integration", "actorId": 3977200, "bypassMode": "always"}
      ]
    }
  ]
}`
}

func TestParseAttestationAcceptsTheReviewedShape(t *testing.T) {
	attestation, err := ParseAttestation([]byte(validAttestationContent()), "Ambiguous-Interactive/example")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(attestation.Rulesets) != 1 {
		t.Fatalf("rulesets = %+v", attestation.Rulesets)
	}
	entry := attestation.Rulesets[0]
	if entry.RulesetID != 7 || entry.RulesetName != "Required CI (default branch)" ||
		entry.Enforcement != "active" || len(entry.RequiredContexts) != 1 ||
		len(entry.BypassActors) != 1 || entry.BypassActors[0].BypassMode != "always" {
		t.Fatalf("entry = %+v", entry)
	}
}

func TestParseAttestationRejectsContractViolations(t *testing.T) {
	base := validAttestationContent()
	cases := map[string]string{
		"unknown field":  `{"schemaVersion": 1, "repository": "Ambiguous-Interactive/example", "rulesets": [], "extra": 1}`,
		"trailing value": base + "\n{}",
		"wrong schema":   strings.Replace(base, `"schemaVersion": 1`, `"schemaVersion": 2`, 1),
		"wrong repository": strings.Replace(
			base, `"Ambiguous-Interactive/example"`, `"Ambiguous-Interactive/other"`, 1,
		),
		"duplicate ruleset": strings.Replace(
			base, `"rulesetName": "Required CI (default branch)",`,
			`"rulesetName": "Required CI (default branch)", "bypassActors": [{"actorType": "Team", "actorId": 2, "bypassMode": "always"}]}, {"rulesetId": 7, "rulesetName": "Second", "enforcement": "active", "requiredContexts": ["Unity CI Success"], "bypassActors": [],`,
			1,
		),
		"inactive enforcement": strings.Replace(base, `"enforcement": "active"`, `"enforcement": "disabled"`, 1),
		"empty contexts":       strings.Replace(base, `"requiredContexts": ["Unity CI Success"]`, `"requiredContexts": []`, 1),
		"bad context":          strings.Replace(base, `"Unity CI Success"`, `"Unity CI\u0007Release"`, 1),
		"bad actor type":       strings.Replace(base, `"Integration"`, "DeployKey", 1),
		"bad actor mode":       strings.Replace(base, `"bypassMode": "always"`, `"bypassMode": "never"`, 1),
		"bad actor id":         strings.Replace(base, `"actorId": 3977200`, `"actorId": 0`, 1),
	}
	for name, content := range cases {
		if _, err := ParseAttestation([]byte(content), "Ambiguous-Interactive/example"); err == nil {
			t.Fatalf("%s must be rejected", name)
		}
	}
}

func TestResolveBypassEvidenceKeepsLiveEvidenceAuthoritative(t *testing.T) {
	live := liveCarrier("Required CI (default branch)", true)
	resolved, attested, health, complete := ResolveBypassEvidence(
		attestationExpectation(), live, Attestation{},
	)
	if !complete || len(attested) != 0 || len(health) != 0 {
		t.Fatalf("live evidence needs no attestation: %+v %+v", health, attested)
	}
	if len(resolved.Rulesets[0].BypassActors) != 0 {
		t.Fatalf("live actors must survive unchanged: %+v", resolved.Rulesets[0])
	}
}

func TestResolveBypassEvidenceFlagsStaleAttestationNextToLiveEvidence(t *testing.T) {
	live := liveCarrier("Required CI (default branch)", true,
		RuleBypassActor{ActorType: "Team", ActorID: 2, Mode: "always"})
	attestation, err := ParseAttestation([]byte(validAttestationContent()), "Ambiguous-Interactive/example")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	_, _, health, complete := ResolveBypassEvidence(attestationExpectation(), live, attestation)
	if !complete {
		t.Fatalf("a stale attestation beside live evidence stays complete")
	}
	if len(health) != 1 || health[0].Code != CodeAttestationStale {
		t.Fatalf("health = %+v", health)
	}
}

func TestResolveBypassEvidenceFillsTheBlindSpot(t *testing.T) {
	blind := liveCarrier("Required CI (default branch)", false)
	attestation, err := ParseAttestation([]byte(validAttestationContent()), "Ambiguous-Interactive/example")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	resolved, attested, health, complete := ResolveBypassEvidence(
		attestationExpectation(), blind, attestation,
	)
	if !complete || len(health) != 0 || len(attested) != 1 || attested[0] != carrierID {
		t.Fatalf("a fresh attestation must fill the blind spot: %+v %+v", health, attested)
	}
	actors := resolved.Rulesets[0].BypassActors
	if len(actors) != 1 || actors[0].ActorType != "Integration" ||
		actors[0].ActorID != 3977200 || actors[0].Mode != "always" || !actors[0].Attested {
		t.Fatalf("attested actors = %+v", actors)
	}
	findings, _ := Analyze(attestationExpectation(), resolved)
	if len(findings) != 1 || findings[0].Code != CodeUnexpectedBypassActor {
		t.Fatalf("the attested actor must surface as drift: %+v", findings)
	}
	if !strings.HasSuffix(findings[0].Detail, "(attested)") {
		t.Fatalf("attested evidence must be marked: %q", findings[0].Detail)
	}
	if len(findings[0].Detail) > MaxDetailBytes {
		t.Fatalf("detail exceeds the publishable bound")
	}
}

func TestResolveBypassEvidenceFailsClosedWithoutAttestation(t *testing.T) {
	blind := liveCarrier("Required CI (default branch)", false)
	resolved, attested, health, complete := ResolveBypassEvidence(
		attestationExpectation(), blind, Attestation{},
	)
	if complete || len(attested) != 0 {
		t.Fatalf("missing attestation must fail closed")
	}
	if len(health) != 1 || health[0].Code != CodeAttestationMissing {
		t.Fatalf("health = %+v", health)
	}
	if !strings.Contains(health[0].Detail, AttestationPath) {
		t.Fatalf("the missing-attestation detail must name the file: %q", health[0].Detail)
	}
	if resolved.Rulesets[0].BypassKnown {
		t.Fatalf("the blind spot must stay blind")
	}
}

func TestResolveBypassEvidenceFailsClosedOnStaleBlindSpotAttestation(t *testing.T) {
	blind := liveCarrier("Renamed CI (default branch)", false)
	attestation, err := ParseAttestation([]byte(validAttestationContent()), "Ambiguous-Interactive/example")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	_, _, health, complete := ResolveBypassEvidence(attestationExpectation(), blind, attestation)
	if complete {
		t.Fatalf("an untrustworthy attestation must fail closed")
	}
	if len(health) != 1 || health[0].Code != CodeAttestationStale {
		t.Fatalf("health = %+v", health)
	}
}

func TestResolveBypassEvidenceRejectsEntriesForNonCarriers(t *testing.T) {
	attestation, err := ParseAttestation([]byte(validAttestationContent()), "Ambiguous-Interactive/example")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	_, _, health, complete := ResolveBypassEvidence(
		attestationExpectation(), Observed{}, attestation,
	)
	if !complete {
		t.Fatalf("an attestation for a non-carrier is hygiene drift, not missing evidence")
	}
	if len(health) != 1 || health[0].Code != CodeAttestationStale ||
		!strings.Contains(health[0].Detail, "does not carry") {
		t.Fatalf("health = %+v", health)
	}
}

func TestResolveBypassEvidenceIgnoresClassicProtectionCarriers(t *testing.T) {
	observed := Observed{
		Protection: Protection{
			Present:        true,
			AdminEnforced:  true,
			RequiredChecks: []RequiredCheck{{Context: "Unity CI Success"}},
		},
	}
	_, _, health, complete := ResolveBypassEvidence(
		attestationExpectation(), observed, Attestation{},
	)
	if !complete || len(health) != 0 {
		t.Fatalf("classic protection bypass evidence is readable and needs no attestation: %+v", health)
	}
}

func TestResolveBypassEvidenceAcceptsEmptyModeAsAlways(t *testing.T) {
	live := liveCarrier("Required CI (default branch)", true,
		RuleBypassActor{ActorType: "Team", ActorID: 2})
	attestation, err := ParseAttestation([]byte(`{
	  "schemaVersion": 1,
	  "repository": "Ambiguous-Interactive/example",
	  "rulesets": [
	    {
	      "rulesetId": 7,
	      "rulesetName": "Required CI (default branch)",
	      "enforcement": "active",
	      "requiredContexts": ["Unity CI Success"],
	      "bypassActors": [{"actorType": "Team", "actorId": 2}]
	    }
	  ]
	}`), "Ambiguous-Interactive/example")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	_, _, health, complete := ResolveBypassEvidence(attestationExpectation(), live, attestation)
	if !complete || len(health) != 0 {
		t.Fatalf("an omitted live mode and an omitted attested mode are the same mode: %+v", health)
	}
}

func TestResolveBypassEvidenceComparesRawContextCharacters(t *testing.T) {
	// Real rulesets require contexts with characters outside the publishable
	// alphabet. The attestation must compare the raw values, never a
	// sanitized form, or the freshness binding could never match.
	live := Observed{
		ActiveChecks: []ActiveCheck{{Context: "Unity CI Success", RulesetID: carrierID}},
		Rulesets: []Ruleset{{
			ID:          carrierID,
			Name:        "protect main",
			Enforcement: "active",
			RequiredChecks: []RequiredCheck{
				{Context: "Unity CI Success"},
				{Context: "Validate YAML & Workflows"},
				{Context: "Config consistency, regions and C# naming"},
			},
		}},
	}
	attestation, err := ParseAttestation([]byte(`{
	  "schemaVersion": 1,
	  "repository": "Ambiguous-Interactive/example",
	  "rulesets": [
	    {
	      "rulesetId": 7,
	      "rulesetName": "protect main",
	      "enforcement": "active",
	      "requiredContexts": [
	        "Unity CI Success",
	        "Validate YAML & Workflows",
	        "Config consistency, regions and C# naming"
	      ],
	      "bypassActors": []
	    }
	  ]
	}`), "Ambiguous-Interactive/example")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	_, attested, health, complete := ResolveBypassEvidence(attestationExpectation(), live, attestation)
	if !complete || len(health) != 0 || len(attested) != 1 {
		t.Fatalf("raw character contexts must attest cleanly: %+v", health)
	}
}
