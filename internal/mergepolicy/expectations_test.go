package mergepolicy

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

func expectationsContent(body string) string {
	return `{
  "schemaVersion": 2,
  "organization": "Ambiguous-Interactive",
  "repositories": [` + body + `]
}`
}

func validExpectationBody() string {
	return `{
    "repository": "Ambiguous-Interactive/example",
    "defaultBranch": "main",
    "requiredContexts": ["Unity CI Success"],
    "requiredContextAppId": 15368,
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
		expectation.RequiredContextAppID != 15368 ||
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
		"unknown field":              `{"schemaVersion": 2, "organization": "Ambiguous-Interactive", "repositories": [{"repository": "Ambiguous-Interactive/example", "defaultBranch": "main", "requiredContexts": [], "surprise": true}]}`,
		"trailing value":             expectationsContent(validExpectationBody()) + " {}",
		"wrong schema version":       strings.Replace(expectationsContent(validExpectationBody()), `"schemaVersion": 2`, `"schemaVersion": 1`, 1),
		"wrong organization":         strings.Replace(expectationsContent(validExpectationBody()), "Ambiguous-Interactive", "Other-Org", 1),
		"no repositories":            `{"schemaVersion": 2, "organization": "Ambiguous-Interactive", "repositories": []}`,
		"repository outside org":     `{"repository": "Other-Org/example", "defaultBranch": "main", "requiredContexts": []}`,
		"bad repository spelling":    `{"repository": "Ambiguous-Interactive/ex ample", "defaultBranch": "main", "requiredContexts": []}`,
		"duplicate repository":       `{"repository": "Ambiguous-Interactive/example", "defaultBranch": "main", "requiredContexts": []}, {"repository": "Ambiguous-Interactive/example", "defaultBranch": "main", "requiredContexts": []}`,
		"invalid default branch":     `{"repository": "Ambiguous-Interactive/example", "defaultBranch": "bad branch", "requiredContexts": []}`,
		"missing context App ID":     expectationsContent(strings.Replace(validExpectationBody(), "    \"requiredContextAppId\": 15368,\n", "", 1)),
		"nonpositive context App ID": expectationsContent(strings.Replace(validExpectationBody(), `"requiredContextAppId": 15368`, `"requiredContextAppId": 0`, 1)),
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

// encoding/json replaces a byte it cannot decode with U+FFFD rather than
// failing, so a reviewed file that is not valid UTF-8 would be evaluated as a
// value the organization never wrote. The refusal names the encoding, so an
// operator is not sent to fix a spelling the file does not contain. Every field
// in this file also has a validator, and both directions are asserted: the
// substituted form is refused, so no row here decides a verdict on its own and
// the guard is what names the real cause.
func TestParseExpectationsRejectsContentThatIsNotValidUTF8(t *testing.T) {
	content := []byte(expectationsContent(validExpectationBody()))
	fields := map[string]string{
		"organization":     `"organization": "Ambiguous-Interactive"`,
		"repository":       `"repository": "Ambiguous-Interactive/example"`,
		"default branch":   `"defaultBranch": "main"`,
		"required context": `"requiredContexts": ["Unity CI Success"`,
		"bypass actor":     `"actorType": "OrganizationAdmin"`,
	}
	for name, field := range fields {
		t.Run(name, func(t *testing.T) {
			corrupted := oneRawByteIn(t, content, field)
			_, err := ParseExpectations(corrupted)
			if err == nil || !strings.Contains(err.Error(), "not valid UTF-8") {
				t.Fatalf("error = %v, want a named UTF-8 refusal", err)
			}
			if _, substitutedErr := ParseExpectations(withSubstitutedByte(corrupted)); substitutedErr == nil {
				t.Fatal("the substituted form must be refused, or this row is decided by the encoding rule alone")
			}
		})
	}
}

// oneRawByteIn splices one 0xFF byte into the last string of a JSON fragment,
// so the file stays valid JSON and only a strict decode can refuse it.
func oneRawByteIn(t *testing.T, content []byte, fragment string) []byte {
	t.Helper()
	if !bytes.Contains(content, []byte(fragment)) {
		t.Fatalf("fixture %q is missing from the reviewed file", fragment)
	}
	corrupted := bytes.Replace(
		content,
		[]byte(fragment),
		[]byte(fragment[:len(fragment)-1]+"\xff"+`"`),
		1,
	)
	if utf8.Valid(corrupted) {
		t.Fatal("the corrupted fixture is still valid UTF-8, so the test proves nothing")
	}
	if !json.Valid(corrupted) {
		t.Fatal("the corrupted fixture is not valid JSON, so it proves nothing about the encoding")
	}
	return corrupted
}

// withSubstitutedByte replaces the one raw byte with the three bytes a decoder
// substitutes for it.
func withSubstitutedByte(corrupted []byte) []byte {
	return bytes.Replace(corrupted, []byte{0xff}, []byte("�"), 1)
}
