package enrollment

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"path"
	"strings"
)

// LoadGitSnapshot reads policy-relevant blobs from an exact commit object. It
// never reads the working tree, so branch movement or local edits cannot mix
// content from different revisions into one audit.
func LoadGitSnapshot(ctx context.Context, repositoryRoot, repository, sha string) (Snapshot, error) {
	if !isSHA(sha) {
		return Snapshot{}, fmt.Errorf("snapshot SHA must be a full immutable commit SHA")
	}
	if repositoryRoot == "" {
		return Snapshot{}, fmt.Errorf("repository root is required")
	}
	if !validRepository(repository) {
		return Snapshot{}, fmt.Errorf("repository must be owner/name")
	}

	if _, err := git(ctx, repositoryRoot, "cat-file", "-e", sha+"^{commit}"); err != nil {
		return Snapshot{}, fmt.Errorf("resolve commit %s: %w", sha, err)
	}
	tree, err := git(ctx, repositoryRoot, "ls-tree", "-r", "--name-only", "-z", sha)
	if err != nil {
		return Snapshot{}, fmt.Errorf("list commit %s: %w", sha, err)
	}

	files := make(map[string][]byte)
	for _, file := range bytes.Split(tree, []byte{0}) {
		if len(file) == 0 {
			continue
		}
		name := string(file)
		if !policyFile(name) {
			continue
		}
		clean, err := cleanRepositoryPath(name)
		if err != nil || clean != name || strings.Contains(name, ":") {
			return Snapshot{}, fmt.Errorf("invalid tree path %q", name)
		}
		content, err := git(ctx, repositoryRoot, "show", sha+":"+name)
		if err != nil {
			return Snapshot{}, fmt.Errorf("read %s at %s: %w", name, sha, err)
		}
		files[name] = content
	}

	return Snapshot{Repository: repository, SHA: sha, Files: files}, nil
}

func policyFile(file string) bool {
	if strings.HasPrefix(file, ".github/workflows/") && isYAML(file) {
		return true
	}
	base := strings.ToLower(path.Base(file))
	return base == "action.yml" || base == "action.yaml"
}

func git(ctx context.Context, repositoryRoot string, arguments ...string) ([]byte, error) {
	commandArguments := append([]string{"-C", repositoryRoot}, arguments...)
	command := exec.CommandContext(ctx, "git", commandArguments...)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	output, err := command.Output()
	if err != nil {
		message := strings.TrimSpace(stderr.String())
		if message != "" {
			return nil, fmt.Errorf("%s", message)
		}
		return nil, err
	}
	return output, nil
}
