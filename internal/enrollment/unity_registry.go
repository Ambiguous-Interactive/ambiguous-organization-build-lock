package enrollment

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"
	"time"
)

// requiredContextPattern mirrors the reviewed context contract of
// internal/mergepolicy/expectations.go so one accepted spelling passes both
// audits.
var requiredContextPattern = regexp.MustCompile(`^[A-Za-z0-9_.+ /()-]{1,128}$`)

// maxRequiredContextsPerRepository mirrors the merge-policy count bound.
const maxRequiredContextsPerRepository = 32

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
// RequiredContexts repeats the reviewed merge-policy contexts whose reporting
// workflow must provably run on every pull request.
type UnityEnrollmentRepository struct {
	Repository            string   `json:"repository"`
	DefaultBranch         string   `json:"defaultBranch"`
	Fork                  bool     `json:"fork"`
	AllowWorkflowDispatch bool     `json:"allowWorkflowDispatch"`
	RequiredContexts      []string `json:"requiredContexts,omitempty"`
}

// UnityEnrollmentRegistry is the reviewed organization audit contract.
type UnityEnrollmentRegistry struct {
	SchemaVersion            int                         `json:"schemaVersion"`
	Organization             string                      `json:"organization"`
	ApprovedLockSHAs         []string                    `json:"approvedLockShas"`
	ApprovedReturnSHAs       []string                    `json:"approvedReturnShas"`
	ApprovedDarwinReturnSHAs []string                    `json:"approvedDarwinReturnShas"`
	Repositories             []UnityEnrollmentRepository `json:"repositories"`
	Exceptions               []UnityPolicyException      `json:"exceptions"`
	RepinExceptions          []UnityRepinException       `json:"repinExceptions"`
	RepinCompanions          []UnityRepinCompanion       `json:"repinCompanions"`
}

// UnityRepinCompanion is one reviewed consumer file that derives its content
// from the pinned lock release, so a pin-only repin pull request would be born
// red without it. The mode names one mechanical rewrite the repin automation
// may apply; nothing else in the file is ever touched.
type UnityRepinCompanion struct {
	Repository string `json:"repository"`
	Path       string `json:"path"`
	Mode       string `json:"mode"`
}

// repinCompanionModes are the reviewed mechanical rewrites. pin-lines applies
// the workflow `uses:` pin rewrite to every line of the file; pin-literal
// replaces a bare occurrence of a currently pinned SHA; policy-snapshot
// mirrors the reviewed approved*Shas allowlists exactly.
var repinCompanionModes = map[string]bool{
	"pin-lines":       true,
	"pin-literal":     true,
	"policy-snapshot": true,
}

// UnityRepinException is a reviewed, expiring permission to skip repinning one
// consumer workflow file. It protects callers whose input contract is not yet
// compatible with the newest authorized release. Without it, a pin-only update
// can move a caller to an action that requires evidence the caller cannot
// supply.
type UnityRepinException struct {
	Repository string `json:"repository"`
	Path       string `json:"path"`
	Reason     string `json:"reason"`
	Owner      string `json:"owner"`
	ExpiresAt  string `json:"expiresAt"`
}

// validRepinExceptionPath requires the exact normalized form of one workflow
// file: a top-level `.github/workflows/` YAML path with no directory
// component and no line or Markdown-format control characters, because the
// path is reproduced in run logs and repin pull request bodies.
func validRepinExceptionPath(value string) bool {
	clean, err := cleanRepositoryPath(value)
	if err != nil || clean != value || !isYAML(clean) ||
		!strings.HasPrefix(clean, ".github/workflows/") {
		return false
	}
	rest := strings.TrimPrefix(clean, ".github/workflows/")
	return !strings.Contains(rest, "/") && !strings.ContainsAny(rest, "\r\n`")
}

// validRepinCompanionPath requires one normalized repository-relative file
// outside `.github/`, because the workflow pin rewrite already owns every
// `.github` YAML file. Companion paths are reproduced in run logs, repin pull
// request bodies, and `git add` arguments, so control characters, backticks,
// and option-like leading dashes are refused.
func validRepinCompanionPath(value string) bool {
	if strings.HasPrefix(value, ".github/") || value == ".github" {
		return false
	}
	clean, err := cleanRepositoryPath(value)
	if err != nil || clean != value ||
		strings.HasPrefix(clean, "-") || strings.ContainsAny(clean, "\r\n`") {
		return false
	}
	if clean == "." {
		return false
	}
	for _, character := range clean {
		if character < 0x20 || character == 0x7f {
			return false
		}
	}
	return true
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
		ApprovedLockSHAs:         registry.ApprovedLockSHAs,
		ApprovedReturnSHAs:       registry.ApprovedReturnSHAs,
		ApprovedDarwinReturnSHAs: registry.ApprovedDarwinReturnSHAs,
		Exceptions:               registry.Exceptions,
		RepinExceptions:          registry.RepinExceptions,
		ProtectedBranches:        []string{"main"},
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
	repinExceptions := make(map[string]bool)
	for _, exception := range registry.RepinExceptions {
		exceptionKey := strings.ToLower(exception.Repository)
		if !seen[exceptionKey] {
			return UnityEnrollmentRegistry{}, fmt.Errorf("repin exception repository is not registered")
		}
		if canonicalRepositories[exceptionKey] != exception.Repository {
			return UnityEnrollmentRegistry{}, fmt.Errorf("repin exception repository spelling is not canonical")
		}
		if !validRepinExceptionPath(exception.Path) {
			return UnityEnrollmentRegistry{}, fmt.Errorf("repin exception path must be a normalized workflow YAML path")
		}
		if strings.TrimSpace(exception.Owner) == "" || strings.ContainsAny(exception.Owner, "\r\n`") {
			return UnityEnrollmentRegistry{}, fmt.Errorf("repin exception owner is required")
		}
		if strings.TrimSpace(exception.Reason) == "" || strings.ContainsAny(exception.Reason, "\r\n`") {
			return UnityEnrollmentRegistry{}, fmt.Errorf("repin exception reason is required")
		}
		if _, err := time.Parse(time.RFC3339, exception.ExpiresAt); err != nil {
			return UnityEnrollmentRegistry{}, fmt.Errorf("repin exception expiry must be RFC3339")
		}
		key := exceptionKey + "\x00" + exception.Path
		if repinExceptions[key] {
			return UnityEnrollmentRegistry{}, fmt.Errorf("repin exceptions contain a duplicate repository/path entry")
		}
		repinExceptions[key] = true
	}
	companions := make(map[string]bool)
	for _, companion := range registry.RepinCompanions {
		companionKey := strings.ToLower(companion.Repository)
		if !seen[companionKey] {
			return UnityEnrollmentRegistry{}, fmt.Errorf("repin companion repository is not registered")
		}
		if canonicalRepositories[companionKey] != companion.Repository {
			return UnityEnrollmentRegistry{}, fmt.Errorf("repin companion repository spelling is not canonical")
		}
		if !validRepinCompanionPath(companion.Path) {
			return UnityEnrollmentRegistry{}, fmt.Errorf("repin companion path must be a normalized repository-relative path outside .github")
		}
		if !repinCompanionModes[companion.Mode] {
			return UnityEnrollmentRegistry{}, fmt.Errorf("repin companion mode is not a reviewed mechanical rewrite")
		}
		key := companionKey + "\x00" + companion.Path
		if companions[key] {
			return UnityEnrollmentRegistry{}, fmt.Errorf("repin companions contain a duplicate repository/path entry")
		}
		companions[key] = true
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
	return validateRequiredContexts(repository.RequiredContexts)
}

// validateRequiredContexts keeps every reviewed aggregate context a literal,
// single-line check name with the same reviewed spelling and count bound the
// merge-policy audit accepts in internal/mergepolicy/expectations.go. An
// empty list means the repository requires no aggregate, so no reporting
// workflow needs provable pull-request coverage.
func validateRequiredContexts(contexts []string) error {
	if len(contexts) > maxRequiredContextsPerRepository {
		return fmt.Errorf("unity enrollment policy requires too many contexts for one repository")
	}
	seen := make(map[string]bool, len(contexts))
	for _, context := range contexts {
		if context == "" || strings.TrimSpace(context) != context ||
			strings.ContainsAny(context, "\r\n") ||
			!requiredContextPattern.MatchString(context) {
			return fmt.Errorf("unity enrollment required context must be a trimmed single-line name")
		}
		if seen[context] {
			return fmt.Errorf("unity enrollment policy contains a duplicate required context")
		}
		seen[context] = true
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
