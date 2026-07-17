package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"

	"github.com/Ambiguous-Interactive/ambiguous-organization-build-lock/internal/enrollment"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(arguments []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("validate-consumer-policy-manifest", flag.ContinueOnError)
	flags.SetOutput(stderr)
	gitDirectory := flags.String("git-dir", "", "candidate Git repository")
	sha := flags.String("sha", "", "exact candidate commit SHA")
	githubOutput := flags.String("github-output", "", "GitHub Actions output file")
	if err := flags.Parse(arguments); err != nil || flags.NArg() != 0 {
		return 2
	}
	if *gitDirectory == "" || *githubOutput == "" || !regexp.MustCompile(`^[0-9a-f]{40}$`).MatchString(*sha) {
		fmt.Fprintln(stderr, "git-dir, exact sha, and github-output are required")
		return 2
	}
	objectType, err := git(context.Background(), *gitDirectory, "cat-file", "-t", *sha)
	if err != nil || objectType != "commit" {
		fmt.Fprintln(stderr, "candidate sha must identify an exact Git commit")
		return 2
	}
	mode, err := git(context.Background(), *gitDirectory, "ls-tree", *sha, "--", "consumer-policy.json")
	if err != nil || !strings.HasPrefix(mode, "100644 blob ") || !strings.HasSuffix(mode, "\tconsumer-policy.json") {
		fmt.Fprintln(stderr, "candidate consumer-policy.json must be one regular 100644 Git blob")
		return 2
	}
	sizeText, err := git(context.Background(), *gitDirectory, "cat-file", "-s", *sha+":consumer-policy.json")
	size, parseErr := strconv.ParseInt(sizeText, 10, 64)
	if err != nil || parseErr != nil || size < 0 || size > enrollment.MaxConsumerPolicyManifestBytes {
		fmt.Fprintln(stderr, "candidate consumer-policy.json exceeds the policy size limit")
		return 2
	}
	content, err := gitBytes(context.Background(), *gitDirectory, "show", *sha+":consumer-policy.json")
	if err != nil {
		fmt.Fprintln(stderr, "cannot read candidate consumer-policy.json from the exact commit")
		return 2
	}
	values, err := enrollment.ParseConsumerPolicyManifest(content)
	if err != nil {
		fmt.Fprintf(stderr, "invalid candidate consumer-policy.json: %v\n", err)
		return 2
	}
	file, err := os.OpenFile(*githubOutput, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		fmt.Fprintln(stderr, "cannot open GitHub output file")
		return 2
	}
	for _, entry := range enrollment.SortedConsumerPolicyRepositories() {
		if _, err := fmt.Fprintf(file, "%s=%s\n", entry.Output, values[entry.Repository]); err != nil {
			_ = file.Close()
			fmt.Fprintln(stderr, "cannot write GitHub output file")
			return 2
		}
	}
	if err := file.Close(); err != nil {
		fmt.Fprintln(stderr, "cannot close GitHub output file")
		return 2
	}
	fmt.Fprintln(stdout, "Validated exact seven-repository consumer policy manifest.")
	return 0
}

func git(ctx context.Context, directory string, arguments ...string) (string, error) {
	content, err := gitBytes(ctx, directory, arguments...)
	return strings.TrimSpace(string(content)), err
}

func gitBytes(ctx context.Context, directory string, arguments ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, "git", append([]string{"--git-dir", directory}, arguments...)...)
	content, err := command.Output()
	if err != nil {
		return nil, fmt.Errorf("git command failed")
	}
	if len(content) > enrollment.MaxConsumerPolicyManifestBytes {
		return nil, fmt.Errorf("git object exceeds policy limit")
	}
	return content, nil
}
