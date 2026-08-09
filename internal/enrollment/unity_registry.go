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

type requiredUnityRepository struct {
	canonical string
	fork      bool
}

var minimumUnityEnrollmentRepositoriesByFold = func() map[string]requiredUnityRepository {
	result := make(map[string]requiredUnityRepository, len(minimumUnityEnrollmentRepositories))
	for repository, fork := range minimumUnityEnrollmentRepositories {
		result[strings.ToLower(repository)] = requiredUnityRepository{
			canonical: repository,
			fork:      fork,
		}
	}
	return result
}()

// UnityEnrollmentRepository declares one exact default-branch audit target.
type UnityEnrollmentRepository struct {
	Repository            string `json:"repository"`
	DefaultBranch         string `json:"defaultBranch"`
	Fork                  bool   `json:"fork"`
	AllowWorkflowDispatch bool   `json:"allowWorkflowDispatch"`
}

// UnityEnrollmentRegistry is the reviewed organization audit contract.
type UnityEnrollmentRegistry struct {
	SchemaVersion      int                         `json:"schemaVersion"`
	Organization       string                      `json:"organization"`
	ApprovedLockSHAs   []string                    `json:"approvedLockShas"`
	ApprovedReturnSHAs []string                    `json:"approvedReturnShas"`
	Repositories       []UnityEnrollmentRepository `json:"repositories"`
	Exceptions         []UnityPolicyException      `json:"exceptions"`
}

// ParseUnityEnrollmentRegistry strictly validates the required baseline and
// any reviewed additions without accepting unknown JSON fields or trailing
// values. The audit derives its reader scope, checkouts, and head revalidation
// directly from this registry.
func ParseUnityEnrollmentRegistry(content []byte) (UnityEnrollmentRegistry, error) {
	if len(content) == 0 || len(content) > MaxUnityEnrollmentPolicyBytes {
		return UnityEnrollmentRegistry{}, fmt.Errorf("unity enrollment policy size is invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	var registry UnityEnrollmentRegistry
	if err := decoder.Decode(&registry); err != nil {
		return UnityEnrollmentRegistry{}, fmt.Errorf("decode Unity enrollment policy: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return UnityEnrollmentRegistry{}, fmt.Errorf("unity enrollment policy must contain one JSON value")
	}
	if registry.SchemaVersion != 1 {
		return UnityEnrollmentRegistry{}, fmt.Errorf("unity enrollment policy schemaVersion must be 1")
	}
	if registry.Organization != UnityEnrollmentOrganization {
		return UnityEnrollmentRegistry{}, fmt.Errorf("unity enrollment policy organization is not authorized")
	}
	if len(registry.Repositories) < len(minimumUnityEnrollmentRepositories) {
		return UnityEnrollmentRegistry{}, fmt.Errorf("unity enrollment repository set is incomplete")
	}
	seen := make(map[string]bool, len(registry.Repositories))
	canonicalRepositories := make(map[string]string, len(registry.Repositories))
	for _, repository := range registry.Repositories {
		if err := ValidateUnityEnrollmentRepository(repository); err != nil {
			return UnityEnrollmentRegistry{}, err
		}
		repositoryKey := strings.ToLower(repository.Repository)
		if seen[repositoryKey] {
			return UnityEnrollmentRegistry{}, fmt.Errorf("unity enrollment policy contains a duplicate repository")
		}
		seen[repositoryKey] = true
		canonicalRepositories[repositoryKey] = repository.Repository
		if required, ok := minimumUnityEnrollmentRepositoriesByFold[repositoryKey]; ok {
			if repository.Repository != required.canonical {
				return UnityEnrollmentRegistry{}, fmt.Errorf("unity enrollment baseline repository spelling is not canonical")
			}
			if repository.Fork != required.fork {
				return UnityEnrollmentRegistry{}, fmt.Errorf("unity enrollment repository fork classification is incorrect")
			}
		}
	}
	for repository := range minimumUnityEnrollmentRepositories {
		if !seen[strings.ToLower(repository)] {
			return UnityEnrollmentRegistry{}, fmt.Errorf("unity enrollment repository set is incomplete")
		}
	}
	policy := UnityEnrollmentPolicy{
		ApprovedLockSHAs:   registry.ApprovedLockSHAs,
		ApprovedReturnSHAs: registry.ApprovedReturnSHAs,
		Exceptions:         registry.Exceptions,
		ProtectedBranches:  []string{"main"},
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
		exceptionKey := strings.ToLower(exception.Repository)
		if !seen[exceptionKey] {
			return UnityEnrollmentRegistry{}, fmt.Errorf("unity enrollment exception repository is not registered")
		}
		if canonicalRepositories[exceptionKey] != exception.Repository {
			return UnityEnrollmentRegistry{}, fmt.Errorf("unity enrollment exception repository spelling is not canonical")
		}
	}
	sort.Slice(registry.Repositories, func(i, j int) bool {
		return registry.Repositories[i].Repository < registry.Repositories[j].Repository
	})
	return registry, nil
}

// ValidateUnityEnrollmentRepository validates one repository declaration
// without serializing it or exposing any of its values as workflow commands.
func ValidateUnityEnrollmentRepository(repository UnityEnrollmentRepository) error {
	if !validRepository(repository.Repository) ||
		!strings.HasPrefix(repository.Repository, UnityEnrollmentOrganization+"/") {
		return fmt.Errorf("unity enrollment policy contains a repository outside the organization")
	}
	if !validRefName(repository.DefaultBranch) {
		return fmt.Errorf("unity enrollment default branch is invalid")
	}
	return nil
}

// AddUnityEnrollmentRepository validates and returns a sorted registry with one
// reviewed organization repository added. It never mutates the input registry.
func AddUnityEnrollmentRepository(
	registry UnityEnrollmentRegistry,
	repository UnityEnrollmentRepository,
) (UnityEnrollmentRegistry, error) {
	for _, current := range registry.Repositories {
		if strings.EqualFold(current.Repository, repository.Repository) {
			return UnityEnrollmentRegistry{}, fmt.Errorf("unity enrollment repository is already registered")
		}
	}
	registry.Repositories = append(
		append([]UnityEnrollmentRepository(nil), registry.Repositories...),
		repository,
	)
	content, err := json.Marshal(registry)
	if err != nil {
		return UnityEnrollmentRegistry{}, fmt.Errorf("encode Unity enrollment policy: %w", err)
	}
	return ParseUnityEnrollmentRegistry(content)
}

func validRefName(value string) bool {
	if value == "" || value == "@" || strings.HasPrefix(value, "-") ||
		strings.HasPrefix(value, "/") || strings.HasSuffix(value, "/") ||
		strings.Contains(value, "//") || strings.Contains(value, "..") ||
		strings.Contains(value, "@{") || strings.HasSuffix(value, ".") {
		return false
	}
	for _, char := range value {
		if char < 0x20 || char == 0x7f || strings.ContainsRune(" ~^:?*[\\", char) {
			return false
		}
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') &&
			(char < '0' || char > '9') && !strings.ContainsRune("._@+-/", char) {
			return false
		}
	}
	for _, component := range strings.Split(value, "/") {
		if component == "" || strings.HasPrefix(component, ".") ||
			strings.HasSuffix(component, ".lock") {
			return false
		}
	}
	return true
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
