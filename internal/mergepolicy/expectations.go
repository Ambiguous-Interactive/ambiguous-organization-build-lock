// Package mergepolicy compares the reviewed default-branch merge policy with
// the branch protection and ruleset state each consumer repository publishes.
// The comparison fails closed: missing evidence is a finding, never a pass.
package mergepolicy

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
)

const (
	// MaxExpectationsBytes bounds the reviewed expectation file.
	MaxExpectationsBytes = 64 * 1024
	// Organization is the only authorized owner for audited repositories.
	Organization = "Ambiguous-Interactive"
	// MaxRepositories bounds the expectation set.
	MaxRepositories = 64
	// MaxContextsPerRepository bounds one repository's required context list.
	MaxContextsPerRepository = 32
	// MaxContextBytes bounds one required check-context name.
	MaxContextBytes = 128
	// MaxDetailBytes bounds one finding detail in the artifact and issue.
	MaxDetailBytes = 256
	// Alphabet is the only text the audit publishes. The sanitizer maps every
	// byte outside this set to '?', and the issue contract accepts exactly
	// this set, so sanitized evidence is always publishable. The value is a
	// regular-expression character-class fragment; consumers append the
	// literal hyphen last so it can never form an accidental range.
	Alphabet = "A-Za-z0-9_.+ /():?"
)

// SanitizeText bounds free-form API text to limit bytes and maps every rune
// outside Alphabet to '?' so the result always satisfies the issue contract.
func SanitizeText(value string, limit int) string {
	if len(value) > limit {
		value = value[:limit]
	}
	var sanitized strings.Builder
	for _, char := range value {
		if isSanitary(char) {
			sanitized.WriteRune(char)
			continue
		}
		sanitized.WriteByte('?')
	}
	return sanitized.String()
}

// BoundDetail clamps one finding detail to MaxDetailBytes. Details are built
// from sanitized parts and ASCII text, so a byte cut is always a rune cut.
func BoundDetail(detail string) string {
	if len(detail) > MaxDetailBytes {
		return detail[:MaxDetailBytes]
	}
	return detail
}

func isSanitary(char rune) bool {
	if char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' {
		return true
	}
	return strings.ContainsRune(" _.+ /():?-", char)
}

var (
	repositoryPattern = regexp.MustCompile(`^Ambiguous-Interactive/[A-Za-z0-9_.-]{1,100}$`)
	contextPattern    = regexp.MustCompile(`^[A-Za-z0-9_.+ /()-]{1,128}$`)
)

// BypassActor is one reviewed identity allowed to bypass a required check.
type BypassActor struct {
	ActorType string `json:"actorType"`
	ActorID   int64  `json:"actorId"`
}

// RepositoryExpectation is the reviewed merge policy for one consumer
// repository. RequiredContexts lists the always-reporting Unity aggregates
// that the default branch must require before a merge. An empty list means
// the repository is exempt; the audit then only proves the settings remain
// readable. AllowedBypassActors scopes ruleset bypass identities that
// reviewed operators accepted. RequireAdminEnforcement additionally demands
// that classic branch protection cannot be bypassed by repository
// administrators.
type RepositoryExpectation struct {
	Repository              string        `json:"repository"`
	DefaultBranch           string        `json:"defaultBranch"`
	RequiredContexts        []string      `json:"requiredContexts"`
	RequireAdminEnforcement bool          `json:"requireAdminEnforcement"`
	AllowedBypassActors     []BypassActor `json:"allowedBypassActors"`
}

// Expectations is the reviewed organization merge-policy contract.
type Expectations struct {
	SchemaVersion int                     `json:"schemaVersion"`
	Organization  string                  `json:"organization"`
	Repositories  []RepositoryExpectation `json:"repositories"`
}

func validExpectationRepository(repository string) bool {
	return repositoryPattern.MatchString(repository)
}

func validContext(context string) bool {
	return len(context) <= MaxContextBytes && contextPattern.MatchString(context)
}

func validActorType(actorType string) bool {
	switch actorType {
	case "OrganizationAdmin", "RepositoryRole", "Team", "Integration":
		return true
	default:
		return false
	}
}

// ParseExpectations strictly validates the reviewed expectation file without
// accepting unknown JSON fields or trailing values.
func ParseExpectations(content []byte) (Expectations, error) {
	if len(content) == 0 || len(content) > MaxExpectationsBytes {
		return Expectations{}, fmt.Errorf("merge policy expectations size is invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	var expectations Expectations
	if err := decoder.Decode(&expectations); err != nil {
		return Expectations{}, fmt.Errorf("decode merge policy expectations: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return Expectations{}, fmt.Errorf("merge policy expectations must contain one JSON value")
	}
	if expectations.SchemaVersion != 1 {
		return Expectations{}, fmt.Errorf("merge policy expectations schemaVersion must be 1")
	}
	if expectations.Organization != Organization {
		return Expectations{}, fmt.Errorf("merge policy expectations organization is not authorized")
	}
	if len(expectations.Repositories) == 0 || len(expectations.Repositories) > MaxRepositories {
		return Expectations{}, fmt.Errorf("merge policy expectation repository count is invalid")
	}
	seen := make(map[string]bool, len(expectations.Repositories))
	for _, expectation := range expectations.Repositories {
		if !validExpectationRepository(expectation.Repository) {
			return Expectations{}, fmt.Errorf("merge policy expectations contain a repository outside the organization")
		}
		key := strings.ToLower(expectation.Repository)
		if seen[key] {
			return Expectations{}, fmt.Errorf("merge policy expectations contain a duplicate repository")
		}
		seen[key] = true
		if !validRefName(expectation.DefaultBranch) {
			return Expectations{}, fmt.Errorf("merge policy expectations contain an invalid default branch")
		}
		if len(expectation.RequiredContexts) > MaxContextsPerRepository {
			return Expectations{}, fmt.Errorf("merge policy expectations exceed the required context bound")
		}
		for _, context := range expectation.RequiredContexts {
			if !validContext(context) {
				return Expectations{}, fmt.Errorf("merge policy expectations contain an invalid required context")
			}
		}
		if len(expectation.AllowedBypassActors) > MaxContextsPerRepository {
			return Expectations{}, fmt.Errorf("merge policy expectations exceed the bypass actor bound")
		}
		actorKeys := make(map[string]bool, len(expectation.AllowedBypassActors))
		for _, actor := range expectation.AllowedBypassActors {
			if !validActorType(actor.ActorType) || actor.ActorID <= 0 {
				return Expectations{}, fmt.Errorf("merge policy expectations contain an invalid bypass actor")
			}
			actorKey := actor.ActorType + "\x00" + fmt.Sprint(actor.ActorID)
			if actorKeys[actorKey] {
				return Expectations{}, fmt.Errorf("merge policy expectations contain a duplicate bypass actor")
			}
			actorKeys[actorKey] = true
		}
	}
	sortExpectations(expectations.Repositories)
	return expectations, nil
}

func sortExpectations(repositories []RepositoryExpectation) {
	for i := 1; i < len(repositories); i++ {
		for j := i; j > 0 && repositories[j].Repository < repositories[j-1].Repository; j-- {
			repositories[j], repositories[j-1] = repositories[j-1], repositories[j]
		}
	}
}

// validRefName applies the same Git ref rules as the enrollment registry.
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
