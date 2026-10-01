package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"go.yaml.in/yaml/v4"

	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/jsonstrict"
)

// maxRequestBytes bounds one harness request batch. Every SKILL.md frontmatter
// block in this repository totals far less than this.
const maxRequestBytes = 4 << 20

var allowedFields = map[string]bool{
	"name":          true,
	"description":   true,
	"license":       true,
	"compatibility": true,
	"metadata":      true,
	"allowed-tools": true,
}

type request struct {
	Path string `json:"path"`
	YAML string `json:"yaml"`
}

type response struct {
	Metadata map[string]string `json:"metadata,omitempty"`
	Error    string            `json:"error,omitempty"`
}

func scalar(values map[string]any, key string, required bool) (string, error) {
	value, exists := values[key]
	if !exists {
		if required {
			return "", fmt.Errorf("%s is required", key)
		}
		return "", nil
	}
	text, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("%s must be a string", key)
	}
	return text, nil
}

func validate(input request) response {
	var values map[string]any
	if err := yaml.Unmarshal([]byte(input.YAML), &values); err != nil {
		return response{Error: fmt.Sprintf("%s: invalid YAML frontmatter: %v", input.Path, err)}
	}
	if values == nil {
		return response{Error: input.Path + ": YAML frontmatter must be a mapping"}
	}
	for key := range values {
		if !allowedFields[key] {
			return response{Error: fmt.Sprintf("%s: unknown metadata: %s", input.Path, key)}
		}
	}

	metadata := make(map[string]string)
	for _, key := range []string{"name", "description"} {
		value, err := scalar(values, key, true)
		if err != nil {
			return response{Error: fmt.Sprintf("%s: %v", input.Path, err)}
		}
		metadata[key] = value
	}
	for _, key := range []string{"license", "compatibility", "allowed-tools"} {
		if _, exists := values[key]; !exists {
			continue
		}
		value, err := scalar(values, key, false)
		if err != nil {
			return response{Error: fmt.Sprintf("%s: %v", input.Path, err)}
		}
		metadata[key] = value
	}
	if raw, exists := values["metadata"]; exists {
		mapping, ok := raw.(map[string]any)
		if !ok {
			return response{Error: input.Path + ": metadata must be a string-to-string mapping"}
		}
		for key, value := range mapping {
			if _, ok := value.(string); !ok {
				return response{Error: fmt.Sprintf(
					"%s: metadata value %q must be a string", input.Path, key,
				)}
			}
		}
	}
	return response{Metadata: metadata}
}

func run(reader io.Reader, writer io.Writer) error {
	// The guard needs the whole request as bytes, so the stream is read once
	// under a bound. A skill batch is a fixed set of frontmatter blocks, so the
	// bound cannot reject a real harness and it keeps an unbounded stdin from
	// becoming unbounded memory.
	content, err := io.ReadAll(io.LimitReader(reader, maxRequestBytes+1))
	if err != nil {
		return fmt.Errorf("read requests: %w", err)
	}
	if len(content) > maxRequestBytes {
		return fmt.Errorf("requests exceed the %d-byte limit", maxRequestBytes)
	}
	var inputs []request
	if err := json.Unmarshal(content, &inputs); err != nil {
		return fmt.Errorf("decode requests: %w", err)
	}
	// The guard runs after the decode, so a malformed batch keeps the decoder's
	// own message. A skill description the decoder substituted would be metadata
	// the harness publishes as if a person wrote it.
	if err := jsonstrict.Refusal("requests", content); err != nil {
		return err
	}
	results := make([]response, len(inputs))
	for index, input := range inputs {
		results[index] = validate(input)
	}
	return json.NewEncoder(writer).Encode(results)
}

func main() {
	if err := run(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
