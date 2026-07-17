package enrollment

import (
	"bytes"
	"fmt"
	"io"
	"path"
	"sort"
	"strings"
	"unicode"

	"go.yaml.in/yaml/v4"
)

const lockActionPrefix = "Ambiguous-Interactive/ambiguous-organization-build-lock/.github/actions/"
const guardActionPrefix = lockActionPrefix + "require-current-pr-head@"

// Snapshot is a repository tree resolved at one immutable commit.
type Snapshot struct {
	Repository string
	SHA        string
	Files      map[string][]byte
}

// Finding is a stable, source-free policy result suitable for sanitized audit output.
type Finding struct {
	Code string
	Path string
	Job  string
}

// Policy selects optional enrollment rules that require an organization-wide
// immutable implementation in addition to cancellation safety.
type Policy struct {
	RequiredGuardSHA string
}

// AnalyzeCancellationSafety rejects automatic cancellation on every workflow or
// job scope that can transitively reach the organization Unity lock.
func AnalyzeCancellationSafety(snapshot Snapshot) ([]Finding, error) {
	return AnalyzePolicy(snapshot, Policy{})
}

// AnalyzePolicy audits cancellation and, when configured, exact current-head
// guard coverage for every PR-reachable licensed job.
func AnalyzePolicy(snapshot Snapshot, policy Policy) ([]Finding, error) {
	if !isSHA(snapshot.SHA) {
		return nil, fmt.Errorf("snapshot SHA must be a full immutable commit SHA")
	}
	if !validRepository(snapshot.Repository) {
		return nil, fmt.Errorf("snapshot repository must be owner/name")
	}
	if policy.RequiredGuardSHA != "" && !isSHA(policy.RequiredGuardSHA) {
		return nil, fmt.Errorf("required guard SHA must be a full immutable commit SHA")
	}

	a := &analyzer{
		snapshot:         snapshot,
		nodes:            make(map[string]*yaml.Node),
		jobMemo:          make(map[string]bool),
		actionMemo:       make(map[string]bool),
		jobVisiting:      make(map[string]bool),
		actionVisit:      make(map[string]bool),
		guardAction:      make(map[string]bool),
		requiredGuardSHA: policy.RequiredGuardSHA,
		findings:         make([]Finding, 0),
		findingSet:       make(map[string]bool),
	}
	workflowPaths := make([]string, 0)
	for file := range snapshot.Files {
		clean, err := cleanRepositoryPath(file)
		if err != nil {
			return nil, err
		}
		if clean != file {
			return nil, fmt.Errorf("snapshot path %q is not normalized", file)
		}
		if strings.HasPrefix(file, ".github/workflows/") && isYAML(file) {
			workflowPaths = append(workflowPaths, file)
		}
	}
	sort.Strings(workflowPaths)

	for _, workflowPath := range workflowPaths {
		workflow, err := a.node(workflowPath)
		if err != nil {
			return nil, err
		}
		jobs := mappingValue(workflow, "jobs")
		if jobs == nil || jobs.Kind != yaml.MappingNode {
			return nil, fmt.Errorf("%s jobs must be a mapping", workflowPath)
		}
		for index := 0; index < len(jobs.Content); index += 2 {
			jobName := jobs.Content[index].Value
			licensed, err := a.jobLicensed(workflowPath, jobName)
			if err != nil {
				return nil, err
			}
			if !licensed {
				continue
			}
			if unsafeConcurrency(mappingValue(workflow, "concurrency")) {
				a.add("unsafe-workflow-cancellation", workflowPath, jobName)
			}
			if unsafeConcurrency(mappingValue(jobs.Content[index+1], "concurrency")) {
				a.add("unsafe-job-cancellation", workflowPath, jobName)
			}
			unsafeFailFast, err := unsafeMatrixFailFast(jobs.Content[index+1])
			if err != nil {
				return nil, fmt.Errorf("%s:%s: %w", workflowPath, jobName, err)
			}
			if unsafeFailFast {
				a.add("unsafe-matrix-fail-fast", workflowPath, jobName)
			}
			if a.requiredGuardSHA != "" {
				prEvents, err := workflowPREvents(workflow)
				if err != nil {
					return nil, fmt.Errorf("%s trigger: %w", workflowPath, err)
				}
				if len(prEvents) > 0 {
					if err := a.validatePRJobGuards(workflowPath, jobName, prEvents); err != nil {
						return nil, err
					}
				}
			}
		}
	}

	sort.Slice(a.findings, func(i, j int) bool {
		left, right := a.findings[i], a.findings[j]
		if left.Path != right.Path {
			return left.Path < right.Path
		}
		if left.Job != right.Job {
			return left.Job < right.Job
		}
		return left.Code < right.Code
	})
	return a.findings, nil
}

type analyzer struct {
	snapshot         Snapshot
	nodes            map[string]*yaml.Node
	jobMemo          map[string]bool
	actionMemo       map[string]bool
	jobVisiting      map[string]bool
	actionVisit      map[string]bool
	guardAction      map[string]bool
	requiredGuardSHA string
	findings         []Finding
	findingSet       map[string]bool
}

func (a *analyzer) add(code, file, job string) {
	key := code + "\x00" + file + "\x00" + job
	if a.findingSet[key] {
		return
	}
	a.findingSet[key] = true
	a.findings = append(a.findings, Finding{Code: code, Path: file, Job: job})
}

func (a *analyzer) jobLicensed(workflowPath, jobName string) (bool, error) {
	key := workflowPath + "\x00" + jobName
	if licensed, ok := a.jobMemo[key]; ok {
		return licensed, nil
	}
	if a.jobVisiting[key] {
		return false, fmt.Errorf("reusable workflow cycle at %s:%s", workflowPath, jobName)
	}
	a.jobVisiting[key] = true
	defer delete(a.jobVisiting, key)

	workflow, err := a.node(workflowPath)
	if err != nil {
		return false, err
	}
	job := mappingValue(mappingValue(workflow, "jobs"), jobName)
	if job == nil || job.Kind != yaml.MappingNode {
		return false, fmt.Errorf("missing job %s:%s", workflowPath, jobName)
	}

	callNode := mappingValue(job, "uses")
	if callNode != nil {
		call, err := requiredScalar(callNode, workflowPath+":"+jobName+" uses")
		if err != nil {
			return false, err
		}
		if mappingValue(job, "steps") != nil {
			return false, fmt.Errorf("%s:%s cannot define both uses and steps", workflowPath, jobName)
		}
		licensed := false
		if strings.HasPrefix(call, "./") {
			calledPath, err := cleanRepositoryPath(strings.TrimPrefix(call, "./"))
			if err != nil {
				return false, err
			}
			called, err := a.node(calledPath)
			if err != nil {
				return false, fmt.Errorf("called workflow %s: %w", calledPath, err)
			}
			calledJobs := mappingValue(called, "jobs")
			if calledJobs == nil || calledJobs.Kind != yaml.MappingNode {
				return false, fmt.Errorf("%s jobs must be a mapping", calledPath)
			}
			for index := 0; index < len(calledJobs.Content); index += 2 {
				calledLicensed, err := a.jobLicensed(calledPath, calledJobs.Content[index].Value)
				if err != nil {
					return false, err
				}
				licensed = licensed || calledLicensed
			}
		} else if strings.Contains(call, "/.github/workflows/") {
			at := strings.LastIndex(call, "@")
			if at < 0 || !isSHA(call[at+1:]) {
				a.add("mutable-reusable-ref", workflowPath, jobName)
			}
			// Until the snapshot graph supplies this exact remote tree, conservatively
			// treat the call as license-capable so caller cancellation cannot pass.
			a.add("unresolved-reusable-workflow", workflowPath, jobName)
			licensed = true
		} else {
			return false, fmt.Errorf("%s:%s uses is not a reusable workflow", workflowPath, jobName)
		}
		a.jobMemo[key] = licensed
		return licensed, nil
	}

	steps := mappingValue(job, "steps")
	if steps != nil && steps.Kind != yaml.SequenceNode {
		return false, fmt.Errorf("%s:%s steps must be a sequence", workflowPath, jobName)
	}
	licensed := false
	for index, step := range sequenceValues(steps) {
		if step.Kind != yaml.MappingNode {
			return false, fmt.Errorf("%s:%s step %d must be a mapping", workflowPath, jobName, index+1)
		}
		usesNode := mappingValue(step, "uses")
		if usesNode == nil {
			continue
		}
		uses, err := requiredScalar(usesNode, fmt.Sprintf("%s:%s step %d uses", workflowPath, jobName, index+1))
		if err != nil {
			return false, err
		}
		if acquire, ref := acquireReference(uses); acquire {
			if !isSHA(ref) {
				a.add("mutable-acquire-ref", workflowPath, jobName)
			}
			licensed = true
			continue
		}
		if strings.HasPrefix(uses, "./") {
			actionIsLicensed, err := a.actionLicensed(strings.TrimPrefix(uses, "./"))
			if err != nil {
				return false, err
			}
			licensed = licensed || actionIsLicensed
		}
	}

	a.jobMemo[key] = licensed
	return licensed, nil
}

func (a *analyzer) validatePRJobGuards(workflowPath, jobName string, prEvents map[string]bool) error {
	workflow, err := a.node(workflowPath)
	if err != nil {
		return err
	}
	job := mappingValue(mappingValue(workflow, "jobs"), jobName)
	if jobExcludedFromEvents(mappingValue(job, "if"), prEvents) {
		return nil
	}

	if callNode := mappingValue(job, "uses"); callNode != nil {
		call, err := requiredScalar(callNode, workflowPath+":"+jobName+" uses")
		if err != nil {
			return err
		}
		if !strings.HasPrefix(call, "./") {
			return nil
		}
		calledPath, err := cleanRepositoryPath(strings.TrimPrefix(call, "./"))
		if err != nil {
			return err
		}
		called, err := a.node(calledPath)
		if err != nil {
			return err
		}
		calledJobs := mappingValue(called, "jobs")
		for index := 0; index < len(calledJobs.Content); index += 2 {
			calledJobName := calledJobs.Content[index].Value
			licensed, err := a.jobLicensed(calledPath, calledJobName)
			if err != nil {
				return err
			}
			if licensed {
				if err := a.validatePRJobGuards(calledPath, calledJobName, prEvents); err != nil {
					return err
				}
			}
		}
		return nil
	}

	steps := sequenceValues(mappingValue(job, "steps"))
	if len(steps) == 0 {
		return fmt.Errorf("%s:%s licensed PR job has no steps", workflowPath, jobName)
	}
	if !a.validGuardStep(steps[0]) {
		a.add(guardFindingCode(steps[0], "missing-initial-current-head-guard"), workflowPath, jobName)
	}
	for index, step := range steps {
		entry, localAction, err := a.licensedEntry(step)
		if err != nil {
			return fmt.Errorf("%s:%s step %d: %w", workflowPath, jobName, index+1, err)
		}
		if !entry {
			continue
		}
		if index == 0 || !a.validGuardBefore(steps[index-1], step) {
			candidate := (*yaml.Node)(nil)
			if index > 0 {
				candidate = steps[index-1]
			}
			a.add(guardFindingCode(candidate, "missing-pre-lock-current-head-guard"), workflowPath, jobName)
		}
		if localAction != "" {
			if err := a.validateCompositeGuards(localAction); err != nil {
				return fmt.Errorf("%s:%s step %d: %w", workflowPath, jobName, index+1, err)
			}
		}
	}
	return nil
}

func (a *analyzer) validateCompositeGuards(actionPath string) error {
	manifestPath, err := a.actionManifest(actionPath)
	if err != nil {
		return err
	}
	if a.guardAction[manifestPath] {
		return nil
	}
	a.guardAction[manifestPath] = true

	manifest, err := a.node(manifestPath)
	if err != nil {
		return err
	}
	steps := sequenceValues(mappingValue(mappingValue(manifest, "runs"), "steps"))
	for index, step := range steps {
		entry, localAction, err := a.licensedEntry(step)
		if err != nil {
			return fmt.Errorf("%s runs.steps entry %d: %w", manifestPath, index+1, err)
		}
		if !entry {
			continue
		}
		if index == 0 || !a.validGuardBefore(steps[index-1], step) {
			candidate := (*yaml.Node)(nil)
			if index > 0 {
				candidate = steps[index-1]
			}
			a.add(guardFindingCode(candidate, "missing-pre-lock-current-head-guard"), manifestPath, "")
		}
		if localAction != "" {
			if err := a.validateCompositeGuards(localAction); err != nil {
				return err
			}
		}
	}
	return nil
}

func (a *analyzer) licensedEntry(step *yaml.Node) (bool, string, error) {
	usesNode := mappingValue(step, "uses")
	if usesNode == nil {
		return false, "", nil
	}
	uses, err := requiredScalar(usesNode, "step uses")
	if err != nil {
		return false, "", err
	}
	if acquire, _ := acquireReference(uses); acquire {
		return true, "", nil
	}
	if !strings.HasPrefix(uses, "./") {
		return false, "", nil
	}
	localAction := strings.TrimPrefix(uses, "./")
	licensed, err := a.actionLicensed(localAction)
	if err != nil {
		return false, "", err
	}
	return licensed, localAction, nil
}

func (a *analyzer) validGuardStep(step *yaml.Node) bool {
	return mappingValue(step, "if") == nil && a.validGuardCore(step)
}

func (a *analyzer) validGuardBefore(guard, entry *yaml.Node) bool {
	guardIf := mappingValue(guard, "if")
	if !a.validGuardCore(guard) || (guardIf != nil && mappingValue(guard, "id") != nil) || referencesStepSpecificContext(guardIf) {
		return false
	}
	entryTerms := make(map[string]bool)
	for _, term := range effectiveConditionTerms(mappingValue(entry, "if")) {
		entryTerms[normalizeConditionTerm(term)] = true
	}
	// The entry must be gated on every preceding step succeeding. A status
	// function anywhere in an explicit condition suppresses GitHub's implicit
	// success(), so require it as a top-level conjunction after expansion.
	if !entryTerms["success()"] {
		return false
	}
	guardTerms := effectiveConditionTerms(guardIf)
	if guardTerms == nil {
		return false
	}
	for _, term := range guardTerms {
		if !entryTerms[normalizeConditionTerm(term)] {
			return false
		}
	}
	return true
}

func (a *analyzer) validGuardCore(step *yaml.Node) bool {
	if step == nil || step.Kind != yaml.MappingNode {
		return false
	}
	allowed := map[string]bool{"name": true, "id": true, "if": true, "uses": true, "with": true}
	for index := 0; index < len(step.Content); index += 2 {
		if !allowed[step.Content[index].Value] {
			return false
		}
	}
	uses := mappingValue(step, "uses")
	if uses == nil || uses.Kind != yaml.ScalarNode || uses.Value != guardActionPrefix+a.requiredGuardSHA {
		return false
	}
	with := mappingValue(step, "with")
	if with == nil || with.Kind != yaml.MappingNode || len(with.Content) != 6 {
		return false
	}
	want := map[string]string{
		"github-token":        "${{ github.token }}",
		"pull-request-number": "${{ github.event.pull_request.number }}",
		"expected-head-sha":   "${{ github.event.pull_request.head.sha }}",
	}
	for key, value := range want {
		input := mappingValue(with, key)
		if input == nil || input.Kind != yaml.ScalarNode || input.Value != value {
			return false
		}
	}
	return true
}

func guardFindingCode(step *yaml.Node, missing string) string {
	uses := mappingValue(step, "uses")
	if uses != nil && uses.Kind == yaml.ScalarNode && strings.HasPrefix(uses.Value, guardActionPrefix) {
		return "invalid-current-head-guard"
	}
	return missing
}

func (a *analyzer) actionLicensed(actionPath string) (bool, error) {
	manifestPath, err := a.actionManifest(actionPath)
	if err != nil {
		return false, err
	}
	if licensed, ok := a.actionMemo[manifestPath]; ok {
		return licensed, nil
	}
	if a.actionVisit[manifestPath] {
		return false, fmt.Errorf("composite action cycle at %s", manifestPath)
	}
	a.actionVisit[manifestPath] = true
	defer delete(a.actionVisit, manifestPath)

	manifest, err := a.node(manifestPath)
	if err != nil {
		return false, fmt.Errorf("local action %s: %w", manifestPath, err)
	}
	runs := mappingValue(manifest, "runs")
	if runs == nil || runs.Kind != yaml.MappingNode {
		return false, fmt.Errorf("%s runs must be a mapping", manifestPath)
	}
	using, err := requiredScalar(mappingValue(runs, "using"), manifestPath+" runs.using")
	if err != nil {
		return false, err
	}
	steps := mappingValue(runs, "steps")
	if using != "composite" {
		if steps != nil {
			return false, fmt.Errorf("%s non-composite action must not define runs.steps", manifestPath)
		}
		a.actionMemo[manifestPath] = false
		return false, nil
	}
	if steps == nil || steps.Kind != yaml.SequenceNode {
		return false, fmt.Errorf("%s runs.steps must be a sequence", manifestPath)
	}
	licensed := false
	for index, step := range sequenceValues(steps) {
		if step.Kind != yaml.MappingNode {
			return false, fmt.Errorf("%s runs.steps entry %d must be a mapping", manifestPath, index+1)
		}
		usesNode := mappingValue(step, "uses")
		if usesNode == nil {
			continue
		}
		uses, err := requiredScalar(usesNode, fmt.Sprintf("%s runs.steps entry %d uses", manifestPath, index+1))
		if err != nil {
			return false, err
		}
		if acquire, ref := acquireReference(uses); acquire {
			if !isSHA(ref) {
				a.add("mutable-acquire-ref", manifestPath, "")
			}
			licensed = true
			continue
		}
		if strings.HasPrefix(uses, "./") {
			actionIsLicensed, err := a.actionLicensed(strings.TrimPrefix(uses, "./"))
			if err != nil {
				return false, err
			}
			licensed = licensed || actionIsLicensed
		}
	}
	a.actionMemo[manifestPath] = licensed
	return licensed, nil
}

func (a *analyzer) actionManifest(actionPath string) (string, error) {
	clean := ""
	if actionPath != "" {
		var err error
		clean, err = cleanRepositoryPath(actionPath)
		if err != nil {
			return "", err
		}
	}
	if isYAML(clean) {
		return clean, nil
	}
	if _, ok := a.snapshot.Files[path.Join(clean, "action.yml")]; ok {
		return path.Join(clean, "action.yml"), nil
	}
	return path.Join(clean, "action.yaml"), nil
}

func (a *analyzer) node(file string) (*yaml.Node, error) {
	if node, ok := a.nodes[file]; ok {
		return node, nil
	}
	content, ok := a.snapshot.Files[file]
	if !ok {
		return nil, fmt.Errorf("snapshot does not contain %s", file)
	}
	var document yaml.Node
	decoder := yaml.NewDecoder(bytes.NewReader(content))
	if err := decoder.Decode(&document); err != nil {
		return nil, fmt.Errorf("parse %s: %w", file, err)
	}
	if len(document.Content) != 1 || document.Content[0].Kind != yaml.MappingNode {
		return nil, fmt.Errorf("%s must contain one mapping document", file)
	}
	var trailing yaml.Node
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("%s must not contain multiple YAML documents", file)
		}
		return nil, fmt.Errorf("parse trailing content in %s: %w", file, err)
	}
	root := document.Content[0]
	if err := validateNode(root, file); err != nil {
		return nil, err
	}
	a.nodes[file] = root
	return root, nil
}

func validateNode(node *yaml.Node, file string) error {
	if node.Kind == yaml.AliasNode {
		return fmt.Errorf("%s contains an unsupported YAML alias", file)
	}
	if node.Kind == yaml.MappingNode {
		seen := make(map[string]bool)
		for index := 0; index < len(node.Content); index += 2 {
			key := node.Content[index]
			if key.Kind != yaml.ScalarNode {
				return fmt.Errorf("%s contains a non-scalar mapping key", file)
			}
			if seen[key.Value] {
				return fmt.Errorf("%s contains duplicate key %q", file, key.Value)
			}
			seen[key.Value] = true
		}
	}
	for _, child := range node.Content {
		if err := validateNode(child, file); err != nil {
			return err
		}
	}
	return nil
}

func workflowPREvents(workflow *yaml.Node) (map[string]bool, error) {
	events := make(map[string]bool)
	on := mappingValue(workflow, "on")
	if on == nil {
		return events, nil
	}
	add := func(value string) {
		if value == "pull_request" || value == "pull_request_target" {
			events[value] = true
		}
	}
	switch on.Kind {
	case yaml.ScalarNode:
		add(on.Value)
	case yaml.SequenceNode:
		for _, event := range on.Content {
			if event.Kind != yaml.ScalarNode {
				return nil, fmt.Errorf("on sequence entries must be scalars")
			}
			add(event.Value)
		}
	case yaml.MappingNode:
		for index := 0; index < len(on.Content); index += 2 {
			if on.Content[index].Kind != yaml.ScalarNode {
				return nil, fmt.Errorf("on mapping keys must be scalars")
			}
			add(on.Content[index].Value)
		}
	default:
		return nil, fmt.Errorf("on must be a scalar, sequence, or mapping")
	}
	return events, nil
}

func jobExcludedFromEvents(ifNode *yaml.Node, events map[string]bool) bool {
	if ifNode == nil || ifNode.Kind != yaml.ScalarNode {
		return false
	}
	if ifNode.Tag == "!!bool" {
		return ifNode.Value == "false"
	}
	expression := strings.TrimSpace(ifNode.Value)
	if strings.HasPrefix(expression, "${{") && strings.HasSuffix(expression, "}}") {
		expression = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(expression, "${{"), "}}"))
	}
	terms, _ := splitTopLevelAnd(expression)
	for event := range events {
		excluded := false
		for _, term := range terms {
			if termFalseForEvent(term, event) {
				excluded = true
				break
			}
		}
		if !excluded {
			return false
		}
	}
	return len(events) > 0
}

func splitTopLevelAnd(expression string) ([]string, bool) {
	terms := make([]string, 0, 1)
	start, depth := 0, 0
	topLevelOr := false
	var quote rune
	runes := []rune(expression)
	for index := 0; index < len(runes); index++ {
		char := runes[index]
		if quote != 0 {
			if char == quote && (index == 0 || runes[index-1] != '\\') {
				quote = 0
			}
			continue
		}
		if char == '\'' || char == '"' {
			quote = char
			continue
		}
		switch char {
		case '(':
			depth++
		case ')':
			if depth == 0 {
				return nil, false
			}
			depth--
		case '&':
			if index+1 >= len(runes) || runes[index+1] != '&' {
				return nil, false
			}
			if depth == 0 {
				term := strings.TrimSpace(string(runes[start:index]))
				if term == "" {
					return nil, false
				}
				terms = append(terms, term)
				start = index + 2
			}
			index++
		case '|':
			if index+1 >= len(runes) || runes[index+1] != '|' {
				return nil, false
			}
			if depth == 0 {
				topLevelOr = true
			}
			index++
		}
	}
	if quote != 0 || depth != 0 {
		return nil, false
	}
	if topLevelOr {
		return nil, true
	}
	term := strings.TrimSpace(string(runes[start:]))
	if term == "" {
		return nil, false
	}
	terms = append(terms, term)
	return terms, false
}

func conditionTerms(expression string) ([]string, bool) {
	expression = strings.TrimSpace(expression)
	if strings.HasPrefix(expression, "${{") && strings.HasSuffix(expression, "}}") {
		expression = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(expression, "${{"), "}}"))
	}
	return splitTopLevelAnd(expression)
}

func effectiveConditionTerms(ifNode *yaml.Node) []string {
	if ifNode == nil {
		return []string{"success()"}
	}
	if ifNode.Kind != yaml.ScalarNode {
		return nil
	}
	terms, topLevelOr := conditionTerms(ifNode.Value)
	if terms == nil {
		if !topLevelOr || containsStatusFunction(ifNode.Value) {
			return nil
		}
		expression := strings.TrimSpace(ifNode.Value)
		if strings.HasPrefix(expression, "${{") && strings.HasSuffix(expression, "}}") {
			expression = strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(expression, "${{"), "}}"))
		}
		return []string{expression, "success()"}
	}
	if !containsStatusFunction(ifNode.Value) {
		terms = append(terms, "success()")
	}
	return terms
}

func containsStatusFunction(expression string) bool {
	var quote rune
	runes := []rune(expression)
	for index := 0; index < len(runes); {
		character := runes[index]
		if quote != 0 {
			if character == quote {
				quote = 0
			}
			index++
			continue
		}
		if character == '\'' || character == '"' {
			quote = character
			index++
			continue
		}
		if !unicode.IsLetter(character) && character != '_' {
			index++
			continue
		}
		start := index
		for index < len(runes) && (unicode.IsLetter(runes[index]) || unicode.IsDigit(runes[index]) || runes[index] == '_') {
			index++
		}
		name := strings.ToLower(string(runes[start:index]))
		for index < len(runes) && unicode.IsSpace(runes[index]) {
			index++
		}
		if index < len(runes) && runes[index] == '(' &&
			(name == "success" || name == "always" || name == "failure" || name == "cancelled") {
			return true
		}
	}
	return false
}

func referencesStepSpecificContext(ifNode *yaml.Node) bool {
	if ifNode == nil {
		return false
	}
	if ifNode.Kind != yaml.ScalarNode {
		return true
	}
	var quote rune
	runes := []rune(ifNode.Value)
	for index := 0; index < len(runes); {
		character := runes[index]
		if quote != 0 {
			if character == quote {
				quote = 0
			}
			index++
			continue
		}
		if character == '\'' || character == '"' {
			quote = character
			index++
			continue
		}
		if !unicode.IsLetter(character) && character != '_' {
			index++
			continue
		}
		start := index
		for index < len(runes) && (unicode.IsLetter(runes[index]) || unicode.IsDigit(runes[index]) || runes[index] == '_') {
			index++
		}
		identifier := string(runes[start:index])
		if strings.EqualFold(identifier, "env") || strings.EqualFold(identifier, "github") {
			return true
		}
	}
	return false
}

func termFalseForEvent(term, event string) bool {
	term = trimOuterParentheses(strings.TrimSpace(term))
	if term == "false" {
		return true
	}
	compact := strings.ReplaceAll(strings.ReplaceAll(term, " ", ""), "\t", "")
	const prefix = "github.event_name"
	if !strings.HasPrefix(compact, prefix) {
		return false
	}
	rest := strings.TrimPrefix(compact, prefix)
	operator := ""
	for _, candidate := range []string{"==", "!="} {
		if strings.HasPrefix(rest, candidate) {
			operator = candidate
			rest = strings.TrimPrefix(rest, candidate)
			break
		}
	}
	if operator == "" || len(rest) < 2 || (rest[0] != '\'' && rest[0] != '"') ||
		rest[len(rest)-1] != rest[0] || strings.Count(rest, string(rest[0])) != 2 {
		return false
	}
	value := rest[1 : len(rest)-1]
	if operator == "==" {
		return event != value
	}
	return event == value
}

func trimOuterParentheses(value string) string {
	for strings.HasPrefix(value, "(") && strings.HasSuffix(value, ")") {
		depth, wraps := 0, true
		for index, char := range value {
			switch char {
			case '(':
				depth++
			case ')':
				depth--
				if depth == 0 && index != len(value)-1 {
					wraps = false
				}
			}
		}
		if !wraps || depth != 0 {
			break
		}
		value = strings.TrimSpace(value[1 : len(value)-1])
	}
	return value
}

func normalizeConditionTerm(value string) string {
	value = trimOuterParentheses(strings.TrimSpace(value))
	var normalized strings.Builder
	var quote rune
	for _, char := range value {
		if quote != 0 {
			normalized.WriteRune(char)
			if char == quote {
				quote = 0
			}
			continue
		}
		if char == '\'' || char == '"' {
			quote = char
			normalized.WriteRune(char)
			continue
		}
		if !unicode.IsSpace(char) {
			normalized.WriteRune(char)
		}
	}
	return normalized.String()
}

func unsafeConcurrency(node *yaml.Node) bool {
	if node == nil {
		return false
	}
	cancel := mappingValue(node, "cancel-in-progress")
	if cancel == nil {
		return false
	}
	return cancel.Kind != yaml.ScalarNode || cancel.Tag != "!!bool" || cancel.Value != "false"
}

func unsafeMatrixFailFast(job *yaml.Node) (bool, error) {
	strategy := mappingValue(job, "strategy")
	if strategy == nil {
		return false, nil
	}
	if strategy.Kind != yaml.MappingNode {
		return false, fmt.Errorf("strategy must be a mapping")
	}
	if mappingValue(strategy, "matrix") == nil {
		return false, nil
	}
	failFast := mappingValue(strategy, "fail-fast")
	return failFast == nil || failFast.Kind != yaml.ScalarNode || failFast.Tag != "!!bool" || failFast.Value != "false", nil
}

func mappingValue(node *yaml.Node, key string) *yaml.Node {
	if node == nil || node.Kind != yaml.MappingNode {
		return nil
	}
	for index := 0; index < len(node.Content); index += 2 {
		if node.Content[index].Value == key {
			return node.Content[index+1]
		}
	}
	return nil
}

func sequenceValues(node *yaml.Node) []*yaml.Node {
	if node == nil || node.Kind != yaml.SequenceNode {
		return nil
	}
	return node.Content
}

func requiredScalar(node *yaml.Node, location string) (string, error) {
	if node == nil || node.Kind != yaml.ScalarNode || strings.TrimSpace(node.Value) == "" {
		return "", fmt.Errorf("%s must be a non-empty scalar", location)
	}
	return node.Value, nil
}

func cleanRepositoryPath(file string) (string, error) {
	if strings.Contains(file, "\\") || strings.HasPrefix(file, "/") {
		return "", fmt.Errorf("repository path %q is invalid", file)
	}
	clean := path.Clean(file)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", fmt.Errorf("repository path %q escapes the snapshot", file)
	}
	return clean, nil
}

func isYAML(file string) bool {
	ext := strings.ToLower(path.Ext(file))
	return ext == ".yml" || ext == ".yaml"
}

func acquireReference(uses string) (bool, string) {
	at := strings.LastIndex(uses, "@")
	if at < 0 {
		at = len(uses)
	}
	target := uses[:at]
	repositoryParts := strings.SplitN(target, "/", 3)
	if len(repositoryParts) != 3 ||
		!strings.EqualFold(repositoryParts[0], "Ambiguous-Interactive") ||
		!strings.EqualFold(repositoryParts[1], "ambiguous-organization-build-lock") {
		return false, ""
	}
	actionPath := path.Clean(strings.ReplaceAll(repositoryParts[2], "\\", "/"))
	parts := strings.Split(actionPath, "/")
	if len(parts) != 3 ||
		!strings.EqualFold(parts[0], ".github") || !strings.EqualFold(parts[1], "actions") ||
		(!strings.EqualFold(parts[2], "acquire-build-lock") && !strings.EqualFold(parts[2], "acquire-build-lock-with-cleanup")) {
		return false, ""
	}
	if at == len(uses) {
		return true, ""
	}
	return true, uses[at+1:]
}

func isSHA(value string) bool {
	if len(value) != 40 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') && (character < 'A' || character > 'F') {
			return false
		}
	}
	return true
}

func validRepository(value string) bool {
	parts := strings.Split(value, "/")
	if len(parts) != 2 || len(parts[0]) > 39 || len(parts[1]) > 100 {
		return false
	}
	validOwnerCharacter := func(character rune) bool {
		return character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || character == '-'
	}
	validRepositoryCharacter := func(character rune) bool {
		return validOwnerCharacter(character) || character == '_' || character == '.'
	}
	if parts[0] == "" || parts[0][0] == '-' || parts[0][len(parts[0])-1] == '-' || strings.Contains(parts[0], "--") {
		return false
	}
	for _, character := range parts[0] {
		if !validOwnerCharacter(character) {
			return false
		}
	}
	if parts[1] == "" {
		return false
	}
	for _, character := range parts[1] {
		if !validRepositoryCharacter(character) {
			return false
		}
	}
	return true
}
