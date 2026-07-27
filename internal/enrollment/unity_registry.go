package enrollment

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
)

const (
	MaxUnityEnrollmentPolicyBytes = 64 * 1024
	UnityEnrollmentOrganization   = "Ambiguous-Interactive"
)

var minimumUnityEnrollmentRepositories = map[string]bool{
	"Ambiguous-Interactive/DoxReloaded":   false,
	"Ambiguous-Interactive/DxMessaging":   false,
	"Ambiguous-Interactive/IshoBoy":       false,
	"Ambiguous-Interactive/qora-redux":    false,
	"Ambiguous-Interactive/unity-builder": true,
	"Ambiguous-Interactive/unity-helpers": false,
}

// UnityEnrollmentRepository declares one exact default-branch audit target.
type UnityEnrollmentRepository struct {
	Repository            string `json:"repository"`
	DefaultBranch         string `json:"defaultBranch"`
	Fork                  bool   `json:"fork"`
	AllowWorkflowDispatch bool   `json:"allowWorkflowDispatch"`
}

// UnityEnrollmentRegistry is the reviewed organization audit contract.
type UnityEnrollmentRegistry struct {
	SchemaVersion    int                         `json:"schemaVersion"`
	Organization     string                      `json:"organization"`
	ApprovedLockSHAs []string                    `json:"approvedLockShas"`
	Repositories     []UnityEnrollmentRepository `json:"repositories"`
	Exceptions       []UnityPolicyException      `json:"exceptions"`
}

// ParseUnityEnrollmentRegistry strictly validates the required baseline and
// requires the exact workflow-coordinated repository set without accepting
// unknown JSON fields or trailing values. Expansion must update the registry,
// reader-App token scope, checkout steps, and head revalidation together.
func ParseUnityEnrollmentRegistry(content []byte) (UnityEnrollmentRegistry, error) {
	if len(content) == 0 || len(content) > MaxUnityEnrollmentPolicyBytes {
		return UnityEnrollmentRegistry{}, fmt.Errorf("Unity enrollment policy size is invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	var registry UnityEnrollmentRegistry
	if err := decoder.Decode(&registry); err != nil {
		return UnityEnrollmentRegistry{}, fmt.Errorf("decode Unity enrollment policy: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return UnityEnrollmentRegistry{}, fmt.Errorf("Unity enrollment policy must contain one JSON value")
	}
	if registry.SchemaVersion != 1 {
		return UnityEnrollmentRegistry{}, fmt.Errorf("Unity enrollment policy schemaVersion must be 1")
	}
	if registry.Organization != UnityEnrollmentOrganization {
		return UnityEnrollmentRegistry{}, fmt.Errorf("Unity enrollment policy organization is not authorized")
	}
	if len(registry.Repositories) != len(minimumUnityEnrollmentRepositories) {
		return UnityEnrollmentRegistry{}, fmt.Errorf("Unity enrollment repository set must match the workflow audit scope")
	}
	seen := make(map[string]bool, len(registry.Repositories))
	for _, repository := range registry.Repositories {
		if !validRepository(repository.Repository) ||
			!strings.HasPrefix(repository.Repository, registry.Organization+"/") {
			return UnityEnrollmentRegistry{}, fmt.Errorf("Unity enrollment policy contains a repository outside the organization")
		}
		if seen[repository.Repository] {
			return UnityEnrollmentRegistry{}, fmt.Errorf("Unity enrollment policy contains a duplicate repository")
		}
		seen[repository.Repository] = true
		if expectedFork, required := minimumUnityEnrollmentRepositories[repository.Repository]; required &&
			expectedFork != repository.Fork {
			return UnityEnrollmentRegistry{}, fmt.Errorf("Unity enrollment repository fork classification is incorrect")
		}
		if _, required := minimumUnityEnrollmentRepositories[repository.Repository]; !required {
			return UnityEnrollmentRegistry{}, fmt.Errorf("Unity enrollment repository is outside the workflow audit scope")
		}
		if !validRefName(repository.DefaultBranch) {
			return UnityEnrollmentRegistry{}, fmt.Errorf("Unity enrollment default branch is invalid")
		}
	}
	for repository := range minimumUnityEnrollmentRepositories {
		if !seen[repository] {
			return UnityEnrollmentRegistry{}, fmt.Errorf("Unity enrollment repository set is incomplete")
		}
	}
	policy := UnityEnrollmentPolicy{
		ApprovedLockSHAs:  registry.ApprovedLockSHAs,
		Exceptions:        registry.Exceptions,
		ProtectedBranches: []string{"main"},
	}
	// Reuse the snapshot analyzer's strict policy validation without exposing a
	// second, drifting interpretation of approved SHAs and exceptions.
	if _, err := AnalyzeUnityEnrollment(Snapshot{
		Repository: "Ambiguous-Interactive/registry-validation",
		SHA:        strings.Repeat("a", 40),
		Files:      map[string][]byte{},
	}, policy); err != nil {
		return UnityEnrollmentRegistry{}, err
	}
	for _, exception := range registry.Exceptions {
		if !seen[exception.Repository] {
			return UnityEnrollmentRegistry{}, fmt.Errorf("Unity enrollment exception repository is not registered")
		}
	}
	sort.Slice(registry.Repositories, func(i, j int) bool {
		return registry.Repositories[i].Repository < registry.Repositories[j].Repository
	})
	return registry, nil
}

func validRefName(value string) bool {
	if value == "" || strings.TrimSpace(value) != value || strings.ContainsAny(value, "\r\n ~^:?*[\\") {
		return false
	}
	return !strings.HasPrefix(value, ".") && !strings.HasSuffix(value, ".") &&
		!strings.Contains(value, "..") && !strings.Contains(value, "@{")
}

// UnityAuditFinding adds immutable repository provenance to a source-free
// analyzer finding.
type UnityAuditFinding struct {
	Repository string `json:"repository"`
	SHA        string `json:"sha,omitempty"`
	Code       string `json:"code"`
	Path       string `json:"path,omitempty"`
	Job        string `json:"job,omitempty"`
}

// UnityAuditedRepository records the exact default-branch object inspected.
type UnityAuditedRepository struct {
	Repository string `json:"repository"`
	SHA        string `json:"sha"`
}

// UnityOrganizationAudit is the bounded artifact consumed by issue sync.
type UnityOrganizationAudit struct {
	Complete     bool                     `json:"complete"`
	Repositories []UnityAuditedRepository `json:"repositories"`
	Inventory    []UnityInventoryEntry    `json:"inventory"`
	Findings     []UnityAuditFinding      `json:"findings"`
}
