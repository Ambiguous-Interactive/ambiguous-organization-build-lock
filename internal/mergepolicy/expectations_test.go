package mergepolicy

import (
	"strings"
	"testing"
)

func expectationsContent(body string) string {
	return `{
  "schemaVersion": 1,
  "organization": "Ambiguous-Interactive",
  "repositories": [` + body + `]
}`
}

func validExpectationBody() string {
	return `{
    "repository": "Ambiguous-Interactive/example",
    "defaultBranch": "main",
    "requiredContexts": ["Unity CI Success"],
    "requireAdminEnforcement": true,
    "allowedBypassActors": [
      {"actorType": "OrganizationAdmin", "actorId": 5, "mode": "always"}
    ]
  }`
}

func TestParseExpectationsAcceptsReviewedFile(t *testing.T) {
	expectations, err := ParseExpectations([]byte(expectationsContent(validExpectationBody())))
	if err != nil {
		t.Fatalf("parse reviewed expectations: %v", err)
	}
	if len(expectations.Repositories) != 1 {
		t.Fatalf("repository count = %d, want 1", len(expectations.Repositories))
	}
	expectation := expectations.Repositories[0]
	if expectation.Repository != "Ambiguous-Interactive/example" ||
		expectation.DefaultBranch != "main" ||
		len(expectation.RequiredContexts) != 1 ||
		expectation.RequiredContexts[0] != "Unity CI Success" ||
		!expectation.RequireAdminEnforcement ||
		len(expectation.AllowedBypassActors) != 1 ||
		expectation.AllowedBypassActors[0].ActorType != "OrganizationAdmin" ||
		expectation.AllowedBypassActors[0].ActorID != 5 ||
		expectation.AllowedBypassActors[0].Mode != "always" {
		t.Fatalf("parsed expectation does not match the reviewed file: %+v", expectation)
	}
}

func TestParseExpectationsSortsRepositories(t *testing.T) {
	content := expectationsContent(`{"repository": "Ambiguous-Interactive/b", "defaultBranch": "main", "requiredContexts": []},
  {"repository": "Ambiguous-Interactive/a", "defaultBranch": "main", "requiredContexts": []}`)
	expectations, err := ParseExpectations([]byte(content))
	if err != nil {
		t.Fatalf("parse expectations: %v", err)
	}
	if expectations.Repositories[0].Repository != "Ambiguous-Interactive/a" {
		t.Fatalf("repositories are not sorted: %+v", expectations.Repositories)
	}
}

func TestParseExpectationsRejectsInvalidFiles(t *testing.T) {
	cases := map[string]string{
		"empty":                      "",
		"too large":                  strings.Repeat(" ", MaxExpectationsBytes+1),
		"unknown field":              `{"schemaVersion": 1, "organization": "Ambiguous-Interactive", "repositories": [{"repository": "Ambiguous-Interactive/example", "defaultBranch": "main", "requiredContexts": [], "surprise": true}]}`,
		"trailing value":             expectationsContent(validExpectationBody()) + " {}",
		"wrong schema version":       strings.Replace(expectationsContent(validExpectationBody()), `"schemaVersion": 1`, `"schemaVersion": 2`, 1),
		"wrong organization":         strings.Replace(expectationsContent(validExpectationBody()), "Ambiguous-Interactive", "Other-Org", 1),
		"no repositories":            `{"schemaVersion": 1, "organization": "Ambiguous-Interactive", "repositories": []}`,
		"repository outside org":     `{"repository": "Other-Org/example", "defaultBranch": "main", "requiredContexts": []}`,
		"bad repository spelling":    `{"repository": "Ambiguous-Interactive/ex ample", "defaultBranch": "main", "requiredContexts": []}`,
		"duplicate repository":       `{"repository": "Ambiguous-Interactive/example", "defaultBranch": "main", "requiredContexts": []}, {"repository": "Ambiguous-Interactive/example", "defaultBranch": "main", "requiredContexts": []}`,
		"invalid default branch":     `{"repository": "Ambiguous-Interactive/example", "defaultBranch": "bad branch", "requiredContexts": []}`,
		"empty context":              `{"repository": "Ambiguous-Interactive/example", "defaultBranch": "main", "requiredContexts": [""]}`,
		"unbounded context":          `{"repository": "Ambiguous-Interactive/example", "defaultBranch": "main", "requiredContexts": ["` + strings.Repeat("a", MaxContextBytes+1) + `"]}`,
		"context with control chars": `{"repository": "Ambiguous-Interactive/example", "defaultBranch": "main", "requiredContexts": ["a\tb"]}`,
		"unknown actor type":         `{"repository": "Ambiguous-Interactive/example", "defaultBranch": "main", "requiredContexts": [], "allowedBypassActors": [{"actorType": "Wizard", "actorId": 1}]}`,
		"nonpositive actor id":       `{"repository": "Ambiguous-Interactive/example", "defaultBranch": "main", "requiredContexts": [], "allowedBypassActors": [{"actorType": "Team", "actorId": 0}]}`,
		"duplicate actor":            `{"repository": "Ambiguous-Interactive/example", "defaultBranch": "main", "requiredContexts": [], "allowedBypassActors": [{"actorType": "Team", "actorId": 3}, {"actorType": "Team", "actorId": 3}]}`,
		"invalid bypass mode":        `{"repository": "Ambiguous-Interactive/example", "defaultBranch": "main", "requiredContexts": [], "allowedBypassActors": [{"actorType": "Team", "actorId": 3, "mode": "whenever"}]}`,
		"too many repositories": func() string {
			entries := make([]string, 0, MaxRepositories+1)
			for index := 0; index <= MaxRepositories; index++ {
				entries = append(entries, `{"repository": "Ambiguous-Interactive/example-`+strings.Repeat("a", 80)+`", "defaultBranch": "main", "requiredContexts": []}`)
			}
			return expectationsContent(strings.Join(entries, ",\n"))
		}(),
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseExpectations([]byte(content)); err == nil {
				t.Fatalf("expected %q to be rejected", name)
			}
		})
	}
}
