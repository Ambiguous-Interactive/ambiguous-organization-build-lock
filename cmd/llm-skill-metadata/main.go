package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"go.yaml.in/yaml/v4"
)

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
	var input request
	if err := json.NewDecoder(reader).Decode(&input); err != nil {
		return fmt.Errorf("decode request: %w", err)
	}
	return json.NewEncoder(writer).Encode(validate(input))
}

func main() {
	if err := run(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
