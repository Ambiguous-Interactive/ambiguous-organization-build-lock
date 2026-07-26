package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func execute(t *testing.T, yamlText string) response {
	t.Helper()
	input, err := json.Marshal(request{Path: "skill/SKILL.md", YAML: yamlText})
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := run(bytes.NewReader(input), &output); err != nil {
		t.Fatal(err)
	}
	var result response
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
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
