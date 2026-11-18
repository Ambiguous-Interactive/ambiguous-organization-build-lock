package enrollment

import (
	"bytes"
	"errors"
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
	RequiredGuardSHA   string
	RequiredAcquireSHA string
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
	if policy.RequiredAcquireSHA != "" && !isSHA(policy.RequiredAcquireSHA) {
		return nil, fmt.Errorf("required acquire SHA must be a full immutable commit SHA")
	}

	a := &analyzer{
		snapshot:           snapshot,
		nodes:              make(map[string]*yaml.Node),
		jobMemo:            make(map[string]bool),
		actionMemo:         make(map[string]bool),
		jobVisiting:        make(map[string]bool),
		actionVisit:        make(map[string]bool),
		guardAction:        make(map[string]bool),
		requiredGuardSHA:   policy.RequiredGuardSHA,
		requiredAcquireSHA: policy.RequiredAcquireSHA,
		findings:           make([]Finding, 0),
		findingSet:         make(map[string]bool),
		reusableMemo:       make(map[string]bool),
		reusableVisiting:   make(map[string]bool),
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
				a.add("unsafe-workflow-queue", workflowPath, jobName)
			}
			if unsafeJobConcurrency(mappingValue(jobs.Content[index+1], "concurrency")) {
				a.add("unsafe-job-queue", workflowPath, jobName)
			}
			unsafeFailFast, err := unsafeMatrixFailFast(jobs.Content[index+1])
			if err != nil {
				return nil, fmt.Errorf("%s:%s: %w", workflowPath, jobName, err)
			}
			if unsafeFailFast {
				a.add("unsafe-matrix-fail-fast", workflowPath, jobName)
			}
			if a.requiredGuardSHA != "" || a.requiredAcquireSHA != "" {
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

// ReusableWorkflowSource resolves the exact bytes of one remote reusable
// workflow at the immutable commit a caller pins. The organization audit
// supplies it from the callee repository, and tests supply it directly. A nil
// source leaves every remote call unresolved, which stays the fail-closed
// verdict.
type ReusableWorkflowSource func(repository, path, sha string) ([]byte, error)

type analyzer struct {
	snapshot           Snapshot
	nodes              map[string]*yaml.Node
	jobMemo            map[string]bool
	actionMemo         map[string]bool
	jobVisiting        map[string]bool
	actionVisit        map[string]bool
	guardAction        map[string]bool
	requiredGuardSHA   string
	requiredAcquireSHA string
	reusableSource     ReusableWorkflowSource
	reusableMemo       map[string]bool
	reusableVisiting   map[string]bool
	reusableDepth      int
	findings           []Finding
	findingSet         map[string]bool
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
		switch {
		case strings.HasPrefix(call, "./"):
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
		case strings.Contains(call, "/.github/workflows/"):
			at := strings.LastIndex(call, "@")
			if at < 0 || !isSHA(call[at+1:]) {
				a.add("mutable-reusable-ref", workflowPath, jobName)
			} else if licensed, resolved := a.reusableWorkflowLicensed(
				call[:at],
				call[at+1:],
			); resolved && okReusableCaller(job) {
				a.jobMemo[key] = licensed
				return licensed, nil
			}
			// Until the callee tree proves otherwise, conservatively treat the
			// call as license-capable so caller cancellation cannot pass.
			a.add("unresolved-reusable-workflow", workflowPath, jobName)
			licensed = true
		default:
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
		a.validateActionOwnership(uses, workflowPath, jobName)
		if acquire, ref := acquireReference(uses); acquire {
			a.validateAcquireRef(ref, workflowPath, jobName)
			licensed = true
			continue
		}
		if strings.HasPrefix(uses, "./") {
			actionIsLicensed, err := a.actionLicensed(a.localActionPath(uses, job))
			if err != nil {
				return false, err
			}
			licensed = licensed || actionIsLicensed
		}
	}

	a.jobMemo[key] = licensed
	return licensed, nil
}

// maxReusableWorkflowDepth bounds how far one remote call may chain. A callee
// that delegates again is read, but a chain past this depth proves nothing and
// stays unresolved.
const maxReusableWorkflowDepth = 4

// okReusableCaller keeps a resolved call conservative when the caller hands
// organization credentials to it. A remote reusable workflow can only receive
// the values a caller maps into it, so a job that names no Unity or lock
// credential has nothing of that kind to pass.
//
// The mapping must name each secret exactly. `secrets: inherit`, a JSON dump of
// the secrets context, and a dynamic index each hand the callee more than this
// review can bound.
func okReusableCaller(job *yaml.Node) bool {
	text := strings.ToLower(nodeScalarText(job))
	if containsUnityCredentialReference(text) || containsOpaqueSecretReference(text) {
		return false
	}
	secrets := mappingValue(job, "secrets")
	if secrets == nil {
		return true
	}
	if secrets.Kind != yaml.MappingNode {
		return false
	}
	for index := 0; index < len(secrets.Content); index += 2 {
		name := strings.TrimSpace(secrets.Content[index].Value)
		value := secrets.Content[index+1]
		if name == "" || strings.ContainsAny(name, " \t\r\n{}[]'\"") ||
			value.Kind != yaml.ScalarNode ||
			!exactExpression(value, "secrets."+name) {
			return false
		}
	}
	return true
}

// containsOpaqueSecretReference reports a secret expression that names no exact
// secret, so a reviewer cannot say which values the callee receives.
func containsOpaqueSecretReference(text string) bool {
	text = strings.ToLower(strings.Join(strings.Fields(text), ""))
	return strings.Contains(text, "tojson(secrets)") || strings.Contains(text, "secrets[")
}

// reusableWorkflowLicensed reports whether the reusable workflow a caller pins
// can license Unity work, and whether that verdict is proven from the callee
// source at the exact pinned commit. Unproven calls stay unresolved so the
// caller cannot pass without a cleanup path it does not own.
func (a *analyzer) reusableWorkflowLicensed(target, ref string) (bool, bool) {
	if a.reusableSource == nil || a.reusableDepth >= maxReusableWorkflowDepth {
		return false, false
	}
	repository, workflowPath, ok := remoteReusableTarget(target)
	if !ok {
		return false, false
	}
	// A commit and a repository name ignore case. A workflow file name does not,
	// so only those two fields fold.
	key := strings.ToLower(repository+"@"+ref) + "\x00" + workflowPath
	if licensed, memoized := a.reusableMemo[key]; memoized {
		return licensed, true
	}
	if a.reusableVisiting[key] {
		return false, false
	}
	a.reusableVisiting[key] = true
	defer delete(a.reusableVisiting, key)
	content, err := a.reusableSource(repository, workflowPath, ref)
	if err != nil {
		return false, false
	}
	// The callee is audited as its own snapshot, so a local action or a local
	// workflow call there resolves against the callee repository rather than
	// this one. Its findings are dropped: only its licensed verdict decides
	// whether this caller's job is a paid lifecycle.
	called := &analyzer{
		snapshot: Snapshot{
			Repository: repository,
			SHA:        ref,
			Files:      map[string][]byte{workflowPath: content},
		},
		nodes:            make(map[string]*yaml.Node),
		jobMemo:          make(map[string]bool),
		actionMemo:       make(map[string]bool),
		jobVisiting:      make(map[string]bool),
		actionVisit:      make(map[string]bool),
		guardAction:      make(map[string]bool),
		reusableSource:   a.reusableSource,
		reusableMemo:     a.reusableMemo,
		reusableVisiting: a.reusableVisiting,
		reusableDepth:    a.reusableDepth + 1,
		findings:         make([]Finding, 0),
		findingSet:       make(map[string]bool),
	}
	workflow, err := called.node(workflowPath)
	if err != nil {
		return false, false
	}
	jobs := mappingValue(workflow, "jobs")
	if jobs == nil || jobs.Kind != yaml.MappingNode {
		return false, false
	}
	licensed := false
	for index := 0; index < len(jobs.Content); index += 2 {
		calledLicensed, err := called.jobLicensed(workflowPath, jobs.Content[index].Value)
		if err != nil {
			return false, false
		}
		licensed = licensed || calledLicensed
	}
	// A job that activates Unity through a third-party action holds no central
	// acquire step, so the licensed verdict alone would call it inert. Any
	// Unity marker in the callee keeps the caller paid.
	licensed = licensed || containsUnityMarker(strings.ToLower(nodeScalarText(workflow)))
	a.reusableMemo[key] = licensed
	return licensed, true
}

// remoteReusableTarget splits `owner/repo/.github/workflows/file.yml` into the
// callee repository and its workflow path. GitHub resolves reusable workflows
// only from that exact directory, so a deeper or re-normalized path proves no
// identity the audit could read. The file name is a plain YAML name: a
// percent-encoded or quoted segment could reach a different path at a mirror.
func remoteReusableTarget(target string) (string, string, bool) {
	const marker = "/.github/workflows/"
	at := strings.Index(target, marker)
	if at < 0 {
		return "", "", false
	}
	repository := target[:at]
	workflowPath := target[at+1:]
	if !validRepository(repository) {
		return "", "", false
	}
	clean, err := cleanRepositoryPath(workflowPath)
	if err != nil || clean != workflowPath ||
		!validWorkflowFileName(strings.TrimPrefix(workflowPath, ".github/workflows/")) {
		return "", "", false
	}
	return repository, workflowPath, true
}

// validWorkflowFileName accepts one reviewed workflow file name under
// `.github/workflows/`: no directory separator, no percent encoding, and no
// character GitHub does not accept in a workflow path.
func validWorkflowFileName(value string) bool {
	if value == "" || !isYAML(value) {
		return false
	}
	stem := strings.TrimSuffix(value, path.Ext(value))
	if stem == "" || strings.HasPrefix(stem, ".") {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' ||
			character == '.' || character == '_' || character == '-' {
			continue
		}
		return false
	}
	return true
}

// localActionPath maps a workspace-relative action path through a checkout of
// this repository at a path prefix. GitHub resolves `./main/.github/...`
// against that checkout, so the snapshot contains the same bytes one level
// down. A checkout that names another repository is not evidence for this
// snapshot and is left unresolved.
func (a *analyzer) localActionPath(uses string, job *yaml.Node) string {
	local := strings.TrimPrefix(uses, "./")
	longest := ""
	for _, step := range sequenceValues(mappingValue(job, "steps")) {
		candidate := stepUses(step)
		at := strings.LastIndex(candidate, "@")
		if at < 0 || !strings.EqualFold(candidate[:at], "actions/checkout") {
			continue
		}
		with := mappingValue(step, "with")
		repository := scalarValue(mappingValue(with, "repository"))
		if repository != "" && !strings.EqualFold(repository, a.snapshot.Repository) {
			continue
		}
		prefix := strings.Trim(
			strings.ReplaceAll(scalarValue(mappingValue(with, "path")), "\\", "/"),
			"/",
		)
		if prefix == "" || prefix == "." || strings.HasPrefix(prefix, "/") ||
			strings.Contains("/"+prefix+"/", "/../") {
			continue
		}
		if (local == prefix || strings.HasPrefix(local, prefix+"/")) && len(prefix) > len(longest) {
			longest = prefix
		}
	}
	if longest == "" {
		return local
	}
	return strings.TrimPrefix(strings.TrimPrefix(local, longest), "/")
}

// validateActionOwnership keeps organization-owned action files centralized.
// Reusable workflows remain separately audited as call-graph edges; this rule
// covers only remote action paths, where a repository-local action owner would
// otherwise be easy to overlook during enrollment review.
func (a *analyzer) validateActionOwnership(uses, workflowPath, jobName string) {
	at := strings.LastIndex(uses, "@")
	if at < 0 {
		at = len(uses)
	}
	parts := strings.SplitN(uses[:at], "/", 3)
	if len(parts) != 3 || !strings.EqualFold(parts[0], UnityEnrollmentOrganization) {
		return
	}
	actionPath := path.Clean(strings.ReplaceAll(parts[2], "\\", "/"))
	if strings.HasPrefix(strings.ToLower(actionPath), ".github/actions/") &&
		!strings.EqualFold(parts[1], "ambiguous-organization-build-lock") {
		a.add("foreign-action-reference", workflowPath, jobName)
	}
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
	if envHasNodeOptions(workflow) || envHasNodeOptions(job) {
		a.add("unsafe-node-options", workflowPath, jobName)
	}
	if mappingValue(job, "container") != nil {
		a.add("unsafe-job-container", workflowPath, jobName)
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
	if a.requiredGuardSHA != "" && !a.validGuardStep(steps[0]) {
		a.add(guardFindingCode(steps[0], "missing-initial-current-head-guard"), workflowPath, jobName)
	}
	for index, step := range steps {
		entry, localAction, err := a.licensedEntry(step, job)
		if err != nil {
			return fmt.Errorf("%s:%s step %d: %w", workflowPath, jobName, index+1, err)
		}
		if !entry {
			continue
		}
		if a.requiredGuardSHA != "" && (index == 0 || !a.validGuardBefore(steps[index-1], step)) {
			candidate := (*yaml.Node)(nil)
			if index > 0 {
				candidate = steps[index-1]
			}
			a.add(guardFindingCode(candidate, "missing-pre-lock-current-head-guard"), workflowPath, jobName)
		}
		if localAction == "" && !a.validAcquirePRInputs(step) {
			a.add("invalid-acquire-pr-head-revalidation", workflowPath, jobName)
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
		entry, localAction, err := a.licensedEntry(step, nil)
		if err != nil {
			return fmt.Errorf("%s runs.steps entry %d: %w", manifestPath, index+1, err)
		}
		if !entry {
			continue
		}
		if a.requiredGuardSHA != "" && (index == 0 || !a.validGuardBefore(steps[index-1], step)) {
			candidate := (*yaml.Node)(nil)
			if index > 0 {
				candidate = steps[index-1]
			}
			a.add(guardFindingCode(candidate, "missing-pre-lock-current-head-guard"), manifestPath, "")
		}
		if localAction == "" && !a.validAcquirePRInputs(step) {
			a.add("invalid-acquire-pr-head-revalidation", manifestPath, "")
		}
		if localAction != "" {
			if err := a.validateCompositeGuards(localAction); err != nil {
				return err
			}
		}
	}
	return nil
}

func (a *analyzer) licensedEntry(step *yaml.Node, job *yaml.Node) (bool, string, error) {
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
	if job != nil {
		localAction = a.localActionPath(uses, job)
	}
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

func (a *analyzer) validAcquirePRInputs(step *yaml.Node) bool {
	if step == nil || step.Kind != yaml.MappingNode {
		return false
	}
	allowed := map[string]bool{
		"name": true, "id": true, "if": true, "uses": true, "with": true, "env": true, "timeout-minutes": true,
	}
	for index := 0; index < len(step.Content); index += 2 {
		if !allowed[step.Content[index].Value] {
			return false
		}
	}
	uses := mappingValue(step, "uses")
	if uses == nil || uses.Kind != yaml.ScalarNode {
		return false
	}
	acquire, ref := acquireReference(uses.Value)
	if !acquire || (a.requiredAcquireSHA != "" && !strings.EqualFold(ref, a.requiredAcquireSHA)) {
		return false
	}
	with := mappingValue(step, "with")
	if with == nil || with.Kind != yaml.MappingNode {
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
	env := mappingValue(step, "env")
	if env == nil || env.Kind != yaml.MappingNode || len(env.Content) != 4 {
		return false
	}
	credentialEnv := map[string]string{
		"BUILD_LOCK_APP_ID":          "${{ secrets.BUILD_LOCK_APP_ID }}",
		"BUILD_LOCK_APP_PRIVATE_KEY": "${{ secrets.BUILD_LOCK_APP_PRIVATE_KEY }}",
	}
	for key, value := range credentialEnv {
		binding := mappingValue(env, key)
		if binding == nil || binding.Kind != yaml.ScalarNode || binding.Value != value {
			return false
		}
	}
	return true
}

func envHasNodeOptions(node *yaml.Node) bool {
	env := mappingValue(node, "env")
	if env == nil {
		return false
	}
	if env.Kind != yaml.MappingNode {
		return true
	}
	for index := 0; index < len(env.Content); index += 2 {
		if strings.EqualFold(env.Content[index].Value, "NODE_OPTIONS") {
			return true
		}
	}
	return false
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
		a.validateActionOwnership(uses, manifestPath, "")
		if acquire, ref := acquireReference(uses); acquire {
			a.validateAcquireRef(ref, manifestPath, "")
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

func (a *analyzer) validateAcquireRef(ref, file, job string) {
	if !isSHA(ref) {
		a.add("mutable-acquire-ref", file, job)
		return
	}
	if a.requiredAcquireSHA != "" && !strings.EqualFold(ref, a.requiredAcquireSHA) {
		a.add("unapproved-acquire-ref", file, job)
	}
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
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
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
	configs, err := pullRequestEventConfigs(workflow)
	if err != nil {
		return nil, err
	}
	for _, event := range configs {
		if event.name == "pull_request" || event.name == "pull_request_target" {
			events[event.name] = true
		}
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

// unsafeConcurrency reports a workflow concurrency scope that can reach the
// organization Unity lock but does not cancel superseded runs. A queued or
// duplicated superseded run wastes a paid self-hosted seat, so the reviewed
// shape is a workflow block with a literal `cancel-in-progress: true`
// (issue #274). Cancellation is safe for licensed work: the acquire action
// traps cancellation signals and releases before activation, the licensed
// cleanup chain runs under `if: always()`, and the scheduled reaper recovers
// a holder whose runner died. An absent workflow block, `false`, quoted
// values, and expressions all fail closed.
func unsafeConcurrency(node *yaml.Node) bool {
	cancel, present := concurrencyCancelValue(node)
	if !present {
		return true
	}
	return !literalTrue(cancel)
}

// unsafeJobConcurrency reports an existing job concurrency scope that would
// re-queue what the workflow scope cancels. A job block is optional: when it
// is absent, the workflow scope governs supersession. When it exists, it
// must cancel like the workflow scope does; a group that omits the key
// defaults to queueing and fails closed, and so does a scalar shorthand
// block, which GitHub treats the same way.
func unsafeJobConcurrency(node *yaml.Node) bool {
	if node == nil {
		return false
	}
	if node.Kind != yaml.MappingNode {
		return true
	}
	cancel := mappingValue(node, "cancel-in-progress")
	if cancel == nil {
		return true
	}
	return !literalTrue(cancel)
}

// unsafeAggregateConcurrency reports an aggregate-reporter job whose own
// concurrency can cancel it before it reports. An existing block must keep
// the literal false default, and an absent block already inherits GitHub's
// non-cancelling behavior, so the reporter survives sibling cancellation
// inside its run. Run-level cancellation of a superseded run is fine: the
// successor run reports the context instead. This is the opposite of the
// licensed-work rule and applies only to jobs that exist to report an
// aggregate truthfully.
func unsafeAggregateConcurrency(node *yaml.Node) bool {
	cancel, present := concurrencyCancelValue(node)
	if !present {
		return false
	}
	return cancel.Kind != yaml.ScalarNode || cancel.Tag != "!!bool" || cancel.Value != "false"
}

func concurrencyCancelValue(node *yaml.Node) (*yaml.Node, bool) {
	if node == nil || node.Kind != yaml.MappingNode {
		return nil, false
	}
	cancel := mappingValue(node, "cancel-in-progress")
	return cancel, cancel != nil
}

func literalTrue(cancel *yaml.Node) bool {
	return cancel.Kind == yaml.ScalarNode && cancel.Tag == "!!bool" && cancel.Value == "true"
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
