package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/jsonstrict"
)

func execute(t *testing.T, yamlText string) response {
	t.Helper()
	input, err := json.Marshal([]request{{Path: "skill/SKILL.md", YAML: yamlText}})
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := run(bytes.NewReader(input), &output); err != nil {
		t.Fatal(err)
	}
	var results []response
	if err := json.Unmarshal(output.Bytes(), &results); err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("got %d results, want 1", len(results))
	}
	return results[0]
}

func TestValidateStandardYAML(t *testing.T) {
	result := execute(t, strings.TrimSpace(`
name: example
description: >
  Perform example work.
  Use when examples are requested.
metadata:
  author: organization
allowed-tools: Bash(git:*) Read
`))
	if result.Error != "" {
		t.Fatal(result.Error)
	}
	if !strings.Contains(result.Metadata["description"], "Use when") {
		t.Fatalf("description was not parsed: %q", result.Metadata["description"])
	}
}

func TestValidateTypesAndUnknownFields(t *testing.T) {
	for _, testCase := range []struct {
		name string
		yaml string
		want string
	}{
		{"metadata scalar", "name: example\ndescription: valid\nmetadata: invalid", "metadata must be"},
		{"metadata value", "name: example\ndescription: valid\nmetadata:\n  version: 1", "must be a string"},
		{"collection description", "name: example\ndescription: [invalid]", "description must be a string"},
		{"unknown", "name: example\ndescription: valid\ntriggers: invalid", "unknown metadata"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if result := execute(t, testCase.yaml); !strings.Contains(result.Error, testCase.want) {
				t.Fatalf("error %q does not contain %q", result.Error, testCase.want)
			}
		})
	}
}

// The harness publishes every description as if a person wrote it, so a value the
// decoder substituted would be skill metadata nobody authored. The clean batch
// carries the weight: a guard that refused every non-ASCII batch would pass a
// table with only refusal rows. The truncated row carries the ordering, because a
// guard above the decode would report a byte rule and hide the syntax error the
// harness author has to fix. The over-bound row keeps the size door on its own
// message.
func TestRunRefusesRequestsTheDecoderCannotRepresent(t *testing.T) {
	clean, err := json.Marshal([]request{{Path: "skill/SKILL.md", YAML: "name: example\ndescription: valid"}})
	if err != nil {
		t.Fatal(err)
	}
	damaged := bytes.Replace(clean, []byte("description: valid"), []byte(`description: \ud800`), 1)
	if bytes.Equal(clean, damaged) {
		t.Fatal("the batch does not hold the literal this test damages")
	}
	unreadable := bytes.Replace(clean, []byte("description: valid"), []byte("description: \xff"), 1)

	cases := []struct {
		name       string
		content    []byte
		want       string
		wantAbsent string
	}{
		{name: "clean batch", content: clean},
		{
			name:    "escaped lone surrogate",
			content: damaged,
			want:    "requests " + jsonstrict.ReasonLoneSurrogateEscape,
		},
		{name: "unreadable byte", content: unreadable, want: "requests " + jsonstrict.ReasonNotUTF8},
		{
			name:       "truncated batch keeps the decoder message",
			content:    damaged[:len(damaged)-1],
			want:       "decode requests: unexpected end of JSON input",
			wantAbsent: "lone surrogate",
		},
		{
			name:       "batch over the size bound",
			content:    append(bytes.Repeat([]byte(" "), maxRequestBytes+1), '['),
			want:       fmt.Sprintf("requests exceed the %d-byte limit", maxRequestBytes),
			wantAbsent: "lone surrogate",
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			var output bytes.Buffer
			err := run(bytes.NewReader(test.content), &output)
			if test.want == "" {
				if err != nil {
					t.Fatalf("a clean batch was refused: %v", err)
				}
				var results []response
				if err := json.Unmarshal(output.Bytes(), &results); err != nil {
					t.Fatal(err)
				}
				if len(results) != 1 || results[0].Metadata["name"] != "example" {
					t.Fatalf("clean batch did not publish its metadata: %#v", results)
				}
				return
			}
			if err == nil {
				t.Fatal("a batch the decoder cannot represent was accepted")
			}
			if !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want %q", err, test.want)
			}
			if test.wantAbsent != "" && strings.Contains(err.Error(), test.wantAbsent) {
				t.Fatalf("error = %v, must not claim %q", err, test.wantAbsent)
			}
		})
	}
}

func TestRunValidatesMetadataBatchInOrder(t *testing.T) {
	input, err := json.Marshal([]request{
		{Path: "first/SKILL.md", YAML: "name: first\ndescription: valid"},
		{Path: "second/SKILL.md", YAML: "name: second\ndescription: valid\nunknown: value"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := run(bytes.NewReader(input), &output); err != nil {
		t.Fatal(err)
	}
	var results []response
	if err := json.Unmarshal(output.Bytes(), &results); err != nil {
		t.Fatal(err)
	}
	if len(results) != 2 {
		t.Fatalf("got %d results, want 2", len(results))
	}
	if got := results[0].Metadata["name"]; got != "first" {
		t.Fatalf("first result name = %q, want first", got)
	}
	if !strings.Contains(results[1].Error, "second/SKILL.md: unknown metadata") {
		t.Fatalf("second result error = %q", results[1].Error)
	}
}
