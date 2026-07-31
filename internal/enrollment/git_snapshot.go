package enrollment

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"path"
	"strconv"
	"strings"
)

const (
	maxPolicySnapshotFiles     = 512
	maxPolicySnapshotFileBytes = 1 << 20
	maxPolicySnapshotBytes     = 16 << 20
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

	policyFiles := make([]string, 0)
	for _, file := range bytes.Split(tree, []byte{0}) {
		if len(file) == 0 {
			continue
		}
		name := string(file)
		if !policyFile(name) {
			continue
		}
		policyFiles = append(policyFiles, name)
		if len(policyFiles) > maxPolicySnapshotFiles {
			return Snapshot{}, fmt.Errorf(
				"commit %s exceeds the %d policy-file limit",
				sha,
				maxPolicySnapshotFiles,
			)
		}
		clean, err := cleanRepositoryPath(name)
		if err != nil || clean != name || strings.Contains(name, ":") {
			return Snapshot{}, fmt.Errorf("invalid tree path %q", name)
		}
	}

	files := make(map[string][]byte, len(policyFiles))
	policyBytes := int64(0)
	for _, name := range policyFiles {
		sizeOutput, err := git(ctx, repositoryRoot, "cat-file", "-s", sha+":"+name)
		if err != nil {
			return Snapshot{}, fmt.Errorf("size %s at %s: %w", name, sha, err)
		}
		size, err := strconv.ParseInt(strings.TrimSpace(string(sizeOutput)), 10, 64)
		if err != nil || size < 0 {
			return Snapshot{}, fmt.Errorf("invalid blob size for %s at %s", name, sha)
		}
		if size > maxPolicySnapshotFileBytes {
			return Snapshot{}, fmt.Errorf(
				"policy file %s at %s exceeds the %d-byte limit",
				name,
				sha,
				maxPolicySnapshotFileBytes,
			)
		}
		policyBytes += size
		if policyBytes > maxPolicySnapshotBytes {
			return Snapshot{}, fmt.Errorf(
				"commit %s exceeds the %d-byte policy snapshot limit",
				sha,
				maxPolicySnapshotBytes,
			)
		}
		content, err := git(ctx, repositoryRoot, "show", sha+":"+name)
		if err != nil {
			return Snapshot{}, fmt.Errorf("read %s at %s: %w", name, sha, err)
		}
		if int64(len(content)) != size {
			return Snapshot{}, fmt.Errorf("blob size changed for %s at %s", name, sha)
		}
		files[name] = content
	}

	return Snapshot{Repository: repository, SHA: sha, Files: files}, nil
}

func policyFile(file string) bool {
	if strings.HasPrefix(file, ".github/workflows/") && isYAML(file) {
		return true
	}
	if strings.EqualFold(path.Ext(file), ".ps1") {
		return true
	}
	base := strings.ToLower(path.Base(file))
	return base == "action.yml" || base == "action.yaml"
}

func git(ctx context.Context, repositoryRoot string, arguments ...string) ([]byte, error) {
	commandArguments := append([]string{"--no-replace-objects", "-C", repositoryRoot}, arguments...)
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
