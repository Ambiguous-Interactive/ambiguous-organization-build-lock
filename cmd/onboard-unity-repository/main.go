package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/enrollment"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(arguments []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("onboard-unity-repository", flag.ContinueOnError)
	flags.SetOutput(stderr)
	policyPath := flags.String("policy", "unity-enrollment-policy.json", "reviewed enrollment policy JSON")
	repository := flags.String("repository", "", "full Ambiguous-Interactive repository name")
	defaultBranch := flags.String("default-branch", "", "reviewed default branch")
	fork := flags.Bool("fork", false, "whether the repository is a fork")
	allowWorkflowDispatch := flags.Bool(
		"allow-workflow-dispatch",
		false,
		"whether audited workflows may use workflow_dispatch",
	)
	validateOnly := flags.Bool("validate-only", false, "validate target values without changing policy")
	if err := flags.Parse(arguments); err != nil || flags.NArg() != 0 {
		return 2
	}
	if *policyPath == "" || *repository == "" || *defaultBranch == "" {
		_, _ = fmt.Fprintln(stderr, "policy, repository, and default-branch are required")
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
	candidate := enrollment.UnityEnrollmentRepository{
		Repository:            *repository,
		DefaultBranch:         *defaultBranch,
		Fork:                  *fork,
		AllowWorkflowDispatch: *allowWorkflowDispatch,
	}
	if err := enrollment.ValidateUnityEnrollmentRepository(candidate); err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot onboard Unity repository: %v\n", err)
		return 2
	}
	if *validateOnly {
		_, _ = fmt.Fprintln(stdout, "Unity enrollment target values are valid.")
		return 0
	}
	registry, err = enrollment.AddUnityEnrollmentRepository(
		registry,
		candidate,
	)
	if err != nil {
		_, _ = fmt.Fprintf(stderr, "cannot onboard Unity repository: %v\n", err)
		return 2
	}
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	encoder.SetEscapeHTML(true)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(registry); err != nil {
		_, _ = fmt.Fprintln(stderr, "cannot encode Unity enrollment policy")
		return 2
	}
	if err := replaceFile(*policyPath, output.Bytes()); err != nil {
		_, _ = fmt.Fprintln(stderr, "cannot write Unity enrollment policy")
		return 2
	}
	_, _ = fmt.Fprintf(stdout, "Added %s to the reviewed Unity enrollment registry.\n", *repository)
	return 0
}

func replaceFile(path string, content []byte) error {
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, ".unity-enrollment-policy-")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(content); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}
