package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/enrollment"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(arguments []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("audit-unity-enrollment", flag.ContinueOnError)
	flags.SetOutput(stderr)
	policyPath := flags.String("policy", "unity-enrollment-policy.json", "reviewed enrollment policy JSON")
	repositoriesRoot := flags.String("repositories-root", ".policy-consumers", "checked-out consumer root")
	outputPath := flags.String("output", "", "bounded JSON audit artifact")
	validatePolicyOnly := flags.Bool(
		"validate-policy-only",
		false,
		"validate the reviewed registry without loading repositories",
	)
	if err := flags.Parse(arguments); err != nil || flags.NArg() != 0 {
		return 2
	}
	if !*validatePolicyOnly && (*outputPath == "" || *repositoriesRoot == "") {
		_, _ = fmt.Fprintln(stderr, "policy, repositories-root, and output are required")
		return 2
	}
	content, err := os.ReadFile(*policyPath)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "cannot read Unity enrollment policy")
		return 2
	}
	registry, err := enrollment.ParseUnityEnrollmentRegistry(content)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "invalid Unity enrollment policy: %v\n", err)
		return 2
	}
	if *validatePolicyOnly {
		_, _ = fmt.Fprintln(stdout, "Unity enrollment policy is valid.")
		return 0
	}

	audit := enrollment.UnityOrganizationAudit{
		Complete:     true,
		Repositories: make([]enrollment.UnityAuditedRepository, 0, len(registry.Repositories)),
		Inventory:    make([]enrollment.UnityInventoryEntry, 0),
		Findings:     make([]enrollment.UnityAuditFinding, 0),
	}
	for _, repository := range registry.Repositories {
		root := filepath.Join(*repositoriesRoot, repositoryName(repository.Repository))
		sha, snapshot, loadErr := loadExactSnapshot(root, repository)
		if loadErr != nil {
			audit.Complete = false
			audit.Findings = append(audit.Findings, enrollment.UnityAuditFinding{
				Repository: repository.Repository,
				Code:       "repository-retrieval-incomplete",
			})
			_, _ = fmt.Fprintf(stderr, "Unity enrollment retrieval failed for %s\n", repository.Repository)
			continue
		}
		audit.Repositories = append(audit.Repositories, enrollment.UnityAuditedRepository{
			Repository: repository.Repository,
			SHA:        sha,
		})
		result, analyzeErr := enrollment.AnalyzeUnityEnrollment(snapshot, enrollment.UnityEnrollmentPolicy{
			ApprovedLockSHAs:      registry.ApprovedLockSHAs,
			ApprovedReturnSHAs:    registry.ApprovedReturnSHAs,
			Exceptions:            registry.Exceptions,
			ProtectedBranches:     []string{repository.DefaultBranch},
			AllowWorkflowDispatch: repository.AllowWorkflowDispatch,
			Now:                   time.Now().UTC(),
		})
		if analyzeErr != nil {
			audit.Complete = false
			audit.Findings = append(audit.Findings, enrollment.UnityAuditFinding{
				Repository: repository.Repository,
				SHA:        sha,
				Code:       "repository-analysis-incomplete",
			})
			_, _ = fmt.Fprintf(stderr, "Unity enrollment analysis failed for %s\n", repository.Repository)
			continue
		}
		audit.Inventory = append(audit.Inventory, result.Inventory...)
		for _, finding := range result.Findings {
			audit.Findings = append(audit.Findings, enrollment.UnityAuditFinding{
				Repository: repository.Repository,
				SHA:        sha,
				Code:       finding.Code,
				Path:       finding.Path,
				Job:        finding.Job,
			})
		}
	}
	sortAudit(&audit)
	if err := writeAudit(*outputPath, audit); err != nil {
		_, _ = fmt.Fprintln(stderr, "cannot write Unity enrollment audit artifact")
		return 2
	}
	_, _ = fmt.Fprintf(
		stdout,
		"Audited %d/%d enrolled repositories; active-jobs=%d findings=%d complete=%t\n",
		len(audit.Repositories),
		len(registry.Repositories),
		len(audit.Inventory),
		len(audit.Findings),
		audit.Complete,
	)
	if !audit.Complete || len(audit.Findings) > 0 {
		return 1
	}
	return 0
}

func loadExactSnapshot(
	root string,
	repository enrollment.UnityEnrollmentRepository,
) (string, enrollment.Snapshot, error) {
	sha, err := git(root, "rev-parse", "--verify", "HEAD^{commit}")
	if err != nil || !fullSHA(sha) {
		return "", enrollment.Snapshot{}, fmt.Errorf("resolve exact commit")
	}
	origin, err := git(root, "remote", "get-url", "origin")
	if err != nil || !canonicalRemote(origin, repository.Repository) {
		return "", enrollment.Snapshot{}, fmt.Errorf("verify repository origin")
	}
	snapshot, err := enrollment.LoadGitSnapshot(context.Background(), root, repository.Repository, sha)
	if err != nil {
		return "", enrollment.Snapshot{}, fmt.Errorf("load exact snapshot")
	}
	return sha, snapshot, nil
}

func repositoryName(repository string) string {
	segments := strings.Split(repository, "/")
	return segments[len(segments)-1]
}

func canonicalRemote(remote, repository string) bool {
	remote = strings.TrimSuffix(strings.TrimSpace(remote), ".git")
	return remote == "https://github.com/"+repository ||
		remote == "git@github.com:"+repository
}

func fullSHA(value string) bool {
	if len(value) != 40 {
		return false
	}
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

func git(root string, arguments ...string) (string, error) {
	command := exec.Command("git", append([]string{"--no-replace-objects", "-C", root}, arguments...)...)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	output, err := command.Output()
	if err != nil {
		return "", fmt.Errorf("git command failed")
	}
	return strings.TrimSpace(string(output)), nil
}

func sortAudit(audit *enrollment.UnityOrganizationAudit) {
	sort.Slice(audit.Repositories, func(i, j int) bool {
		return audit.Repositories[i].Repository < audit.Repositories[j].Repository
	})
	sort.Slice(audit.Inventory, func(i, j int) bool {
		left, right := audit.Inventory[i], audit.Inventory[j]
		if left.Repository != right.Repository {
			return left.Repository < right.Repository
		}
		if left.Path != right.Path {
			return left.Path < right.Path
		}
		return left.Job < right.Job
	})
	sort.Slice(audit.Findings, func(i, j int) bool {
		left, right := audit.Findings[i], audit.Findings[j]
		if left.Repository != right.Repository {
			return left.Repository < right.Repository
		}
		if left.Path != right.Path {
			return left.Path < right.Path
		}
		if left.Job != right.Job {
			return left.Job < right.Job
		}
		return left.Code < right.Code
	})
}

func writeAudit(path string, audit enrollment.UnityOrganizationAudit) error {
	var content bytes.Buffer
	encoder := json.NewEncoder(&content)
	encoder.SetEscapeHTML(true)
	if err := encoder.Encode(audit); err != nil {
		return err
	}
	return os.WriteFile(path, content.Bytes(), 0o600)
}
