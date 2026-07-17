package enrollment

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"sort"
)

const MaxConsumerPolicyManifestBytes = 16 * 1024

type ConsumerPolicyRepository struct {
	Repository string
	Output     string
}

var ConsumerPolicyRepositories = []ConsumerPolicyRepository{
	{Repository: "Ambiguous-Interactive/DoxReloaded", Output: "dox_reloaded_sha"},
	{Repository: "Ambiguous-Interactive/DxMessaging", Output: "dx_messaging_sha"},
	{Repository: "Ambiguous-Interactive/IshoBoy", Output: "isho_boy_sha"},
	{Repository: "Ambiguous-Interactive/qora-redux", Output: "qora_redux_sha"},
	{Repository: "Ambiguous-Interactive/unity-builder", Output: "unity_builder_sha"},
	{Repository: "Ambiguous-Interactive/unity-helpers", Output: "unity_helpers_sha"},
}

func ParseConsumerPolicyManifest(content []byte) (map[string]string, error) {
	if len(content) > MaxConsumerPolicyManifestBytes {
		return nil, fmt.Errorf("consumer policy manifest exceeds %d bytes", MaxConsumerPolicyManifestBytes)
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return nil, fmt.Errorf("consumer policy manifest must be one JSON object")
	}
	values := make(map[string]string, len(ConsumerPolicyRepositories))
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, fmt.Errorf("consumer policy manifest contains invalid JSON")
		}
		repository, ok := token.(string)
		if !ok {
			return nil, fmt.Errorf("consumer policy manifest keys must be strings")
		}
		if _, exists := values[repository]; exists {
			return nil, fmt.Errorf("consumer policy manifest contains a duplicate repository")
		}
		var sha string
		if err := decoder.Decode(&sha); err != nil {
			return nil, fmt.Errorf("consumer policy manifest values must be strings")
		}
		values[repository] = sha
	}
	end, err := decoder.Token()
	if err != nil || end != json.Delim('}') {
		return nil, fmt.Errorf("consumer policy manifest contains invalid JSON")
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, fmt.Errorf("consumer policy manifest must contain one JSON value")
	}

	expected := make(map[string]struct{}, len(ConsumerPolicyRepositories))
	for _, entry := range ConsumerPolicyRepositories {
		expected[entry.Repository] = struct{}{}
		sha, ok := values[entry.Repository]
		if !ok {
			return nil, fmt.Errorf("consumer policy manifest repository set is incomplete")
		}
		if !isSHA(sha) {
			return nil, fmt.Errorf("consumer policy manifest contains a mutable or malformed commit")
		}
	}
	for repository := range values {
		if _, ok := expected[repository]; !ok {
			return nil, fmt.Errorf("consumer policy manifest contains an unregistered repository")
		}
	}
	return values, nil
}

func SortedConsumerPolicyRepositories() []ConsumerPolicyRepository {
	result := append([]ConsumerPolicyRepository(nil), ConsumerPolicyRepositories...)
	sort.Slice(result, func(i, j int) bool { return result[i].Repository < result[j].Repository })
	return result
}
