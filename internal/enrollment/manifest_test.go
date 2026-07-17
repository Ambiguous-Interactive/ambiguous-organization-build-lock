package enrollment

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseConsumerPolicyManifest(t *testing.T) {
	valid := validConsumerPolicyManifest(t)
	tests := []struct {
		name    string
		content string
		wantErr bool
	}{
		{name: "valid", content: valid},
		{name: "invalid JSON", content: "{", wantErr: true},
		{name: "wrong root", content: "[]", wantErr: true},
		{name: "trailing value", content: valid + "\n{}", wantErr: true},
		{name: "duplicate", content: strings.Replace(valid, "{", `{"Ambiguous-Interactive/DxMessaging":"282e38d156ff7611c68354e8f22aca275cb3b077",`, 1), wantErr: true},
		{name: "extra", content: strings.Replace(valid, "{", `{"Ambiguous-Interactive/extra":"282e38d156ff7611c68354e8f22aca275cb3b077",`, 1), wantErr: true},
		{name: "missing", content: strings.Replace(valid, `"Ambiguous-Interactive/DxMessaging":"282e38d156ff7611c68354e8f22aca275cb3b077",`, "", 1), wantErr: true},
		{name: "non string", content: strings.Replace(valid, `"282e38d156ff7611c68354e8f22aca275cb3b077"`, "null", 1), wantErr: true},
		{name: "mutable", content: strings.Replace(valid, "282e38d156ff7611c68354e8f22aca275cb3b077", "main", 1), wantErr: true},
	}
	for index := range tests {
		testCase := tests[index]
		t.Run(testCase.name, func(t *testing.T) {
			_, err := ParseConsumerPolicyManifest([]byte(testCase.content))
			if (err != nil) != testCase.wantErr {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestParseConsumerPolicyManifestRejectsOversizeWithoutEchoingContent(t *testing.T) {
	sentinel := "candidate-secret-sentinel"
	_, err := ParseConsumerPolicyManifest([]byte(strings.Repeat(" ", MaxConsumerPolicyManifestBytes) + sentinel))
	if err == nil || strings.Contains(err.Error(), sentinel) {
		t.Fatalf("error must reject without echoing candidate content: %v", err)
	}
}

func validConsumerPolicyManifest(t *testing.T) string {
	t.Helper()
	values := make(map[string]string, len(ConsumerPolicyRepositories))
	for _, entry := range ConsumerPolicyRepositories {
		values[entry.Repository] = "0123456789abcdef0123456789abcdef01234567"
	}
	values["Ambiguous-Interactive/DxMessaging"] = "282e38d156ff7611c68354e8f22aca275cb3b077"
	content, err := json.Marshal(values)
	if err != nil {
		t.Fatal(err)
	}
	return string(content)
}
