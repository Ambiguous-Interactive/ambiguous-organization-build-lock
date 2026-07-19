package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v4"
)

var (
	credentialNamePattern   = regexp.MustCompile(`(?i)(^|_)(API_KEY|ACCESS_KEY|CREDENTIAL|PASSWORD|PASSWD|PRIVATE_KEY|SECRET|TOKEN)(_|$)`)
	allowedReferencePattern = regexp.MustCompile(`^\$\{\{\s*(secrets\.[A-Za-z_][A-Za-z0-9_]*|github\.token)\s*\}\}$`)
	unityAutomationPattern  = regexp.MustCompile(`(?i)\bUNITY_(SERIAL|EMAIL|PASSWORD|LICENSE|LICENSING_SERVER)\b|game-ci/unity-(test-runner|builder|activate)@`)
	credentialValuePatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`),
		regexp.MustCompile(`^(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})$`),
		regexp.MustCompile(`^(AKIA|ASIA)[A-Z0-9]{16}$`),
		regexp.MustCompile(`^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$`),
		regexp.MustCompile(`^-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----`),
		regexp.MustCompile(`^[A-Za-z0-9+/=_-]{32,}$`),
	}
	mixedLettersPattern = regexp.MustCompile(`[A-Za-z]`)
	mixedDigitsPattern  = regexp.MustCompile(`[0-9]`)
)

type finding struct {
	File string
	Line int
	Name string
	Kind string
}

func (f finding) String() string {
	if f.Kind == "unsupported" {
		return fmt.Sprintf("%s:%d: unsupported env mapping syntax; use a direct mapping with scalar values", safeDiagnosticComponent(f.File), f.Line)
	}
	if f.Kind == "unity-automation" {
		return fmt.Sprintf("%s: unregistered Unity credential or activation automation; register the exact reviewed path", safeDiagnosticComponent(f.File))
	}
	return fmt.Sprintf("%s:%d: credential-shaped literal in env[%s]; use OIDC or an exact secrets.NAME or github.token expression", safeDiagnosticComponent(f.File), f.Line, safeDiagnosticComponent(f.Name))
}

func safeDiagnosticComponent(value string) string {
	// QuoteToASCII prevents control characters and Unicode line separators from
	// creating additional log lines. Escaping colons also prevents hostile input
	// from containing a GitHub Actions workflow-command marker such as ::error::.
	return strings.ReplaceAll(strconv.QuoteToASCII(value), ":", `\x3a`)
}

func isCredentialShapedLiteral(name, value string) bool {
	name = strings.TrimSpace(name)
	value = strings.TrimSpace(value)
	if !credentialNamePattern.MatchString(name) || value == "" || allowedReferencePattern.MatchString(value) {
		return false
	}
	if strings.Contains(value, "${{") {
		return true
	}
	for index, pattern := range credentialValuePatterns {
		if !pattern.MatchString(value) {
			continue
		}
		if index != len(credentialValuePatterns)-1 || mixedLettersPattern.MatchString(value) && mixedDigitsPattern.MatchString(value) {
			return true
		}
	}
	return false
}

func dereference(node *yaml.Node, seen map[*yaml.Node]bool) (*yaml.Node, bool) {
	for node != nil && node.Kind == yaml.AliasNode {
		if node.Alias == nil || seen[node] {
			return node, false
		}
		seen[node] = true
		node = node.Alias
	}
	return node, node != nil
}

func auditEnv(file string, node *yaml.Node) []finding {
	resolved, ok := dereference(node, make(map[*yaml.Node]bool))
	if !ok || resolved.Kind != yaml.MappingNode || len(resolved.Content)%2 != 0 {
		return []finding{{File: file, Line: node.Line, Kind: "unsupported"}}
	}

	var findings []finding
	for index := 0; index < len(resolved.Content); index += 2 {
		key, keyOK := dereference(resolved.Content[index], make(map[*yaml.Node]bool))
		value, valueOK := dereference(resolved.Content[index+1], make(map[*yaml.Node]bool))
		if !keyOK || key.Kind != yaml.ScalarNode || key.Value == "<<" || !valueOK || value.Kind != yaml.ScalarNode {
			findings = append(findings, finding{File: file, Line: resolved.Content[index].Line, Kind: "unsupported"})
			continue
		}
		if isCredentialShapedLiteral(key.Value, value.Value) {
			findings = append(findings, finding{File: file, Line: value.Line, Name: key.Value, Kind: "literal"})
		}
	}
	return findings
}

func auditNode(file string, node *yaml.Node, active map[*yaml.Node]bool) []finding {
	if node == nil || active[node] {
		return nil
	}
	active[node] = true
	defer delete(active, node)

	if node.Kind == yaml.AliasNode {
		return auditNode(file, node.Alias, active)
	}

	var findings []finding
	switch node.Kind {
	case yaml.DocumentNode, yaml.SequenceNode:
		for _, child := range node.Content {
			findings = append(findings, auditNode(file, child, active)...)
		}
	case yaml.MappingNode:
		for index := 0; index+1 < len(node.Content); index += 2 {
			key, value := node.Content[index], node.Content[index+1]
			resolvedKey, ok := dereference(key, make(map[*yaml.Node]bool))
			if ok && resolvedKey.Kind == yaml.ScalarNode && resolvedKey.Value == "env" {
				findings = append(findings, auditEnv(file, value)...)
				continue
			}
			findings = append(findings, auditNode(file, key, active)...)
			findings = append(findings, auditNode(file, value, active)...)
		}
	}
	return findings
}

func auditReader(file string, reader io.Reader) ([]finding, error) {
	decoder := yaml.NewDecoder(reader)
	var findings []finding
	for {
		var document yaml.Node
		err := decoder.Decode(&document)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", file, err)
		}
		findings = append(findings, auditNode(file, &document, make(map[*yaml.Node]bool))...)
	}
	return findings, nil
}

func listWorkflowYAML(root string) ([]string, error) {
	githubRoot := filepath.Join(root, ".github")
	var files []string
	err := filepath.WalkDir(githubRoot, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		extension := strings.ToLower(filepath.Ext(entry.Name()))
		if extension == ".yml" || extension == ".yaml" {
			files = append(files, path)
		}
		return nil
	})
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	sort.Strings(files)
	return files, err
}

func auditRepository(root string) ([]finding, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	files, err := listWorkflowYAML(root)
	if err != nil {
		return nil, err
	}
	var findings []finding
	for _, path := range files {
		contents, readErr := os.Open(path)
		if readErr != nil {
			return nil, readErr
		}
		relative, relErr := filepath.Rel(root, path)
		if relErr != nil {
			contents.Close()
			return nil, relErr
		}
		fileFindings, auditErr := auditReader(filepath.ToSlash(relative), contents)
		closeErr := contents.Close()
		if auditErr != nil {
			return nil, auditErr
		}
		if closeErr != nil {
			return nil, closeErr
		}
		findings = append(findings, fileFindings...)
	}
	return findings, nil
}

func isUnregisteredUnityAutomation(file, source string, allowed map[string]bool) bool {
	return unityAutomationPattern.MatchString(source) && !allowed[filepath.ToSlash(file)]
}

func auditUnityAutomationRepository(root string, allowed map[string]bool) ([]finding, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	rootInfo, err := os.Stat(root)
	if err != nil {
		return nil, fmt.Errorf("inspect target root: %w", err)
	}
	if !rootInfo.IsDir() {
		return nil, fmt.Errorf("target root is not a directory")
	}
	githubInfo, err := os.Stat(filepath.Join(root, ".github"))
	if err != nil {
		return nil, fmt.Errorf("inspect target .github directory: %w", err)
	}
	if !githubInfo.IsDir() {
		return nil, fmt.Errorf("target .github path is not a directory")
	}
	files, err := listWorkflowYAML(root)
	if err != nil {
		return nil, err
	}
	var findings []finding
	for _, path := range files {
		contents, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil, readErr
		}
		relative, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return nil, relErr
		}
		relative = filepath.ToSlash(relative)
		if isUnregisteredUnityAutomation(relative, string(contents), allowed) {
			findings = append(findings, finding{File: relative, Kind: "unity-automation"})
		}
	}
	return findings, nil
}

func run(root string, stdout, stderr io.Writer) int {
	findings, err := auditRepository(root)
	if err != nil {
		fmt.Fprintf(stderr, "workflow credential audit failed: %s\n", safeDiagnosticComponent(err.Error()))
		return 1
	}
	if len(findings) > 0 {
		for _, finding := range findings {
			fmt.Fprintln(stderr, finding.String())
		}
		return 1
	}
	fmt.Fprintln(stdout, "Workflow credential-literal policy passed.")
	return 0
}

func runUnityAutomation(root string, allowed map[string]bool, stdout, stderr io.Writer) int {
	findings, err := auditUnityAutomationRepository(root, allowed)
	if err != nil {
		fmt.Fprintf(stderr, "Unity automation audit failed: %s\n", safeDiagnosticComponent(err.Error()))
		return 1
	}
	if len(findings) > 0 {
		for _, finding := range findings {
			fmt.Fprintln(stderr, finding.String())
		}
		return 1
	}
	fmt.Fprintln(stdout, "Registered Unity automation policy passed.")
	return 0
}

func dispatch(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		return run(".", stdout, stderr)
	}
	if args[0] == "unity-automation" {
		if len(args) < 2 {
			fmt.Fprintln(stderr, "usage: workflow-credential-audit unity-automation ROOT [ALLOWED_PATH ...]")
			return 2
		}
		allowed := make(map[string]bool, len(args)-2)
		for _, path := range args[2:] {
			allowed[filepath.ToSlash(filepath.Clean(path))] = true
		}
		return runUnityAutomation(args[1], allowed, stdout, stderr)
	}
	if len(args) != 1 {
		fmt.Fprintln(stderr, "usage: workflow-credential-audit [ROOT] | unity-automation ROOT [ALLOWED_PATH ...]")
		return 2
	}
	return run(args[0], stdout, stderr)
}

func main() {
	os.Exit(dispatch(os.Args[1:], os.Stdout, os.Stderr))
}
