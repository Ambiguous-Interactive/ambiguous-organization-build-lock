package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/enrollment"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(arguments []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("audit-cancellation-policy", flag.ContinueOnError)
	flags.SetOutput(stderr)
	repository := flags.String("repository", "", "repository identity in owner/name form")
	sha := flags.String("sha", "", "exact 40-character commit SHA to audit")
	repositoryRoot := flags.String("git-dir", ".", "path to the Git repository")
	requiredGuardSHA := flags.String("required-guard-sha", "", "exact approved current-head guard commit SHA")
	if err := flags.Parse(arguments); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintln(stderr, "audit arguments: unexpected positional arguments")
		return 2
	}

	snapshot, err := enrollment.LoadGitSnapshot(context.Background(), *repositoryRoot, *repository, *sha)
	if err != nil {
		fmt.Fprintf(stderr, "audit snapshot: %v\n", err)
		return 2
	}
	findings, err := enrollment.AnalyzePolicy(snapshot, enrollment.Policy{RequiredGuardSHA: *requiredGuardSHA})
	if err != nil {
		fmt.Fprintf(stderr, "audit policy: %v\n", err)
		return 2
	}
	if err := json.NewEncoder(stdout).Encode(struct {
		Repository string               `json:"repository"`
		SHA        string               `json:"sha"`
		Findings   []enrollment.Finding `json:"findings"`
	}{Repository: snapshot.Repository, SHA: snapshot.SHA, Findings: findings}); err != nil {
		fmt.Fprintf(stderr, "encode audit: %v\n", err)
		return 2
	}
	if len(findings) > 0 {
		return 1
	}
	return 0
}
