package enrollment

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"go.yaml.in/yaml/v4"
)

const (
	cleanupClassifierAction = "classify-unity-cleanup-evidence"
	cleanupGateAction       = "require-confirmed-unity-cleanup"
	preflightAction         = "check-unity-runner-availability"
	releaseAction           = "release-build-lock"
)

// UnityPolicyException is a reviewed, expiring classification for a workflow
// that contains Unity-shaped fixture or deliberately disabled content without
// receiving organization Unity credentials.
type UnityPolicyException struct {
	Repository     string `json:"repository"`
	Path           string `json:"path"`
	Classification string `json:"classification"`
	Owner          string `json:"owner"`
	ExpiresAt      string `json:"expiresAt"`
}

// UnityEnrollmentPolicy defines the immutable lock versions and narrow
// exceptions accepted by an organization enrollment audit.
type UnityEnrollmentPolicy struct {
	ApprovedLockSHAs      []string               `json:"approvedLockShas"`
	Exceptions            []UnityPolicyException `json:"exceptions"`
	ProtectedBranches     []string               `json:"-"`
	AllowWorkflowDispatch bool                   `json:"-"`
	Now                   time.Time              `json:"-"`
}

// UnityInventoryEntry is a source-free, deterministic classification suitable
// for issue output. It deliberately contains no source line or matched text.
type UnityInventoryEntry struct {
	Repository     string `json:"repository"`
	SHA            string `json:"sha"`
	Path           string `json:"path"`
	Job            string `json:"job"`
	Classification string `json:"classification"`
}

// UnityEnrollmentResult contains the sanitized active inventory and findings.
type UnityEnrollmentResult struct {
	Inventory []UnityInventoryEntry `json:"inventory"`
	Findings  []Finding             `json:"findings"`
}

type unityPolicyAnalyzer struct {
	analyzer       *analyzer
	approved       map[string]bool
	exceptions     map[string]UnityPolicyException
	usedExceptions map[string]bool
	now            time.Time
}

type flattenedUnityStep struct {
	node                *yaml.Node
	scope               string
	enclosingConditions []*yaml.Node
	enclosingSteps      []*yaml.Node
	cleanupWrapper      bool
}

// AnalyzeUnityEnrollment classifies Unity-related jobs and rejects incomplete
// licensed lifecycle policy at one immutable repository snapshot.
func AnalyzeUnityEnrollment(snapshot Snapshot, policy UnityEnrollmentPolicy) (UnityEnrollmentResult, error) {
	if !isSHA(snapshot.SHA) {
		return UnityEnrollmentResult{}, fmt.Errorf("snapshot SHA must be a full immutable commit SHA")
	}
	if !validRepository(snapshot.Repository) {
		return UnityEnrollmentResult{}, fmt.Errorf("snapshot repository must be owner/name")
	}
	approved := make(map[string]bool, len(policy.ApprovedLockSHAs))
	for _, sha := range policy.ApprovedLockSHAs {
		sha = strings.ToLower(strings.TrimSpace(sha))
		if !isSHA(sha) {
			return UnityEnrollmentResult{}, fmt.Errorf("approved lock SHA must be a full immutable commit SHA")
		}
		if approved[sha] {
			return UnityEnrollmentResult{}, fmt.Errorf("approved lock SHA list contains a duplicate")
		}
		approved[sha] = true
	}
	if len(approved) == 0 {
		return UnityEnrollmentResult{}, fmt.Errorf("at least one approved lock SHA is required")
	}
	protectedBranches := make(map[string]bool, len(policy.ProtectedBranches))
	for _, branch := range policy.ProtectedBranches {
		if !validRefName(branch) || protectedBranches[branch] {
			return UnityEnrollmentResult{}, fmt.Errorf("protected branch policy is invalid")
		}
		protectedBranches[branch] = true
	}
	if len(protectedBranches) == 0 {
		return UnityEnrollmentResult{}, fmt.Errorf("at least one protected branch is required")
	}

	now := policy.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	exceptions := make(map[string]UnityPolicyException)
	for _, exception := range policy.Exceptions {
		if !validRepository(exception.Repository) {
			return UnityEnrollmentResult{}, fmt.Errorf("policy exception repository must be owner/name")
		}
		clean, err := cleanRepositoryPath(exception.Path)
		if err != nil || clean != exception.Path || !isYAML(clean) ||
			!strings.HasPrefix(clean, ".github/workflows/") {
			return UnityEnrollmentResult{}, fmt.Errorf("policy exception path must be a normalized workflow YAML path")
		}
		if exception.Classification != "synthetic" && exception.Classification != "disabled" {
			return UnityEnrollmentResult{}, fmt.Errorf("policy exception classification must be synthetic or disabled")
		}
		if strings.TrimSpace(exception.Owner) == "" || strings.ContainsAny(exception.Owner, "\r\n") {
			return UnityEnrollmentResult{}, fmt.Errorf("policy exception owner is required")
		}
		if _, err := time.Parse(time.RFC3339, exception.ExpiresAt); err != nil {
			return UnityEnrollmentResult{}, fmt.Errorf("policy exception expiry must be RFC3339")
		}
		key := exception.Repository + "\x00" + exception.Path
		if _, exists := exceptions[key]; exists {
			return UnityEnrollmentResult{}, fmt.Errorf("policy contains a duplicate repository/path exception")
		}
		exceptions[key] = exception
	}

	base := &analyzer{
		snapshot:           snapshot,
		nodes:              make(map[string]*yaml.Node),
		jobMemo:            make(map[string]bool),
		actionMemo:         make(map[string]bool),
		jobVisiting:        make(map[string]bool),
		actionVisit:        make(map[string]bool),
		guardAction:        make(map[string]bool),
		findings:           make([]Finding, 0),
		findingSet:         make(map[string]bool),
		requiredAcquireSHA: "",
	}
	a := &unityPolicyAnalyzer{
		analyzer:       base,
		approved:       approved,
		exceptions:     exceptions,
		usedExceptions: make(map[string]bool),
		now:            now,
	}
	result := UnityEnrollmentResult{
		Inventory: make([]UnityInventoryEntry, 0),
		Findings:  make([]Finding, 0),
	}

	workflowPaths := make([]string, 0)
	for file := range snapshot.Files {
		clean, err := cleanRepositoryPath(file)
		if err != nil || clean != file {
			return UnityEnrollmentResult{}, fmt.Errorf("snapshot contains a non-normalized path")
		}
		if strings.HasPrefix(file, ".github/workflows/") && isYAML(file) {
			workflowPaths = append(workflowPaths, file)
		}
	}
	sort.Strings(workflowPaths)

	for _, workflowPath := range workflowPaths {
		workflow, err := base.node(workflowPath)
		if err != nil {
			return UnityEnrollmentResult{}, err
		}
		jobs := mappingValue(workflow, "jobs")
		if jobs == nil || jobs.Kind != yaml.MappingNode {
			return UnityEnrollmentResult{}, fmt.Errorf("%s jobs must be a mapping", workflowPath)
		}
		preflightJobs := a.preflightJobs(jobs)
		for index := 0; index < len(jobs.Content); index += 2 {
			jobName := jobs.Content[index].Value
			job := jobs.Content[index+1]
			if job.Kind != yaml.MappingNode {
				return UnityEnrollmentResult{}, fmt.Errorf("%s:%s job must be a mapping", workflowPath, jobName)
			}
			text := strings.ToLower(nodeScalarText(mappingValue(workflow, "env")) + nodeScalarText(job))
			licensed, err := base.jobLicensed(workflowPath, jobName)
			if err != nil {
				return UnityEnrollmentResult{}, err
			}
			steps, err := a.flattenedSteps(
				sequenceValues(mappingValue(job, "steps")),
				make(map[string]bool),
				"job",
				nil,
				nil,
			)
			if err != nil {
				return UnityEnrollmentResult{}, fmt.Errorf("%s:%s: %w", workflowPath, jobName, err)
			}
			activates := false
			for _, step := range steps {
				activates = activates || stepActivatesUnity(step.node)
				text += strings.ToLower(nodeScalarText(step.node))
			}
			paid := licensed || containsUnityCredentialReference(text)
			fallbackCleanup := !licensed &&
				!activates &&
				!containsUnityLicenseCredentialReference(text) &&
				containsReleaseAction(steps)
			related := paid || containsUnityMarker(text)
			if !related {
				continue
			}

			classification := "non-licensing-static"
			if fallbackCleanup {
				classification = "fallback-cleanup"
			} else if paid {
				classification = "paid-serial"
				if workflowDispatchOnly(workflow) {
					classification = "controlled-canary"
				}
			} else if exception, ok := a.exception(workflowPath); ok {
				classification = exception.Classification
			} else if containsReviewRequiredMarker(text) {
				base.add("unreviewed-unity-reference", workflowPath, jobName)
			}
			result.Inventory = append(result.Inventory, UnityInventoryEntry{
				Repository:     snapshot.Repository,
				SHA:            snapshot.SHA,
				Path:           workflowPath,
				Job:            jobName,
				Classification: classification,
			})
			if fallbackCleanup {
				a.auditFallbackCleanup(
					workflow,
					jobs,
					workflowPath,
					jobName,
					job,
					steps,
					protectedBranches,
					policy.AllowWorkflowDispatch,
				)
			} else if paid {
				a.auditPaidJob(
					workflow,
					jobs,
					workflowPath,
					jobName,
					job,
					steps,
					preflightJobs,
					licensed,
					protectedBranches,
					policy.AllowWorkflowDispatch,
				)
			}
		}
	}

	for key, exception := range exceptions {
		if exception.Repository != snapshot.Repository {
			continue
		}
		if expiry, _ := time.Parse(time.RFC3339, exception.ExpiresAt); !expiry.After(now) {
			base.add("expired-policy-exception", exception.Path, "")
		}
		if !a.usedExceptions[key] {
			base.add("stale-policy-exception", exception.Path, "")
		}
	}
	sortUnityResult(&result, base.findings)
	return result, nil
}

func (a *unityPolicyAnalyzer) exception(workflowPath string) (UnityPolicyException, bool) {
	key := a.analyzer.snapshot.Repository + "\x00" + workflowPath
	exception, ok := a.exceptions[key]
	if !ok {
		return UnityPolicyException{}, false
	}
	a.usedExceptions[key] = true
	expiry, _ := time.Parse(time.RFC3339, exception.ExpiresAt)
	if !expiry.After(a.now) {
		a.analyzer.add("expired-policy-exception", workflowPath, "")
	}
	return exception, true
}

func (a *unityPolicyAnalyzer) auditFallbackCleanup(
	workflow, jobs *yaml.Node,
	workflowPath, jobName string,
	job *yaml.Node,
	steps []flattenedUnityStep,
	protectedBranches map[string]bool,
	allowWorkflowDispatch bool,
) {
	if unsafeConcurrency(mappingValue(workflow, "concurrency")) {
		a.analyzer.add("unsafe-workflow-cancellation", workflowPath, jobName)
	}
	if unsafeConcurrency(mappingValue(job, "concurrency")) {
		a.analyzer.add("unsafe-job-cancellation", workflowPath, jobName)
	}
	if unsafe, err := unsafeMatrixFailFast(job); err != nil || unsafe {
		a.analyzer.add("unsafe-matrix-fail-fast", workflowPath, jobName)
	}
	if mappingValue(job, "environment") != nil {
		a.analyzer.add("approval-environment", workflowPath, jobName)
	}
	if mappingValue(job, "env") != nil {
		a.analyzer.add("job-scoped-unity-credential", workflowPath, jobName)
	}
	if !eligibleUnityTrigger(workflow, job, protectedBranches, allowWorkflowDispatch) {
		a.analyzer.add("ineligible-unity-trigger", workflowPath, jobName)
	}
	if scalarValue(mappingValue(job, "runs-on")) != "ubuntu-latest" {
		a.analyzer.add("fallback-cleanup-not-hosted", workflowPath, jobName)
	}
	if !optionalTimeoutAtLeast(job, 5) {
		a.analyzer.add("invalid-fallback-timeout", workflowPath, jobName)
	}

	releases := make([]int, 0, 1)
	for index, step := range steps {
		uses := stepUses(step.node)
		if lockActionName(uses) != releaseAction {
			a.analyzer.add("unexpected-fallback-step", workflowPath, jobName)
		}
		if isRemoteAction(uses) {
			ref := actionRef(uses)
			if !isSHA(ref) {
				a.analyzer.add("mutable-action-ref", workflowPath, jobName)
			} else if strings.HasPrefix(uses, lockActionPrefix) &&
				!a.approved[strings.ToLower(ref)] {
				a.analyzer.add("unapproved-lock-ref", workflowPath, jobName)
			}
		}
		if lockActionName(uses) == releaseAction {
			releases = append(releases, index)
		}
	}
	if len(releases) != 1 {
		a.analyzer.add("invalid-fallback-release", workflowPath, jobName)
		return
	}
	releaseIndex := releases[0]
	release := steps[releaseIndex]
	sourceJob, suffix, typedRelease := fallbackReleaseSource(release.node, job)
	sourcePaid := a.paidSourceJob(workflow, workflowPath, sourceJob)
	sourceMatched := a.sourceAcquireMatches(workflowPath, sourceJob, suffix)
	if !fallbackConditionCoversSource(mappingValue(job, "if"), sourceJob) {
		a.analyzer.add("fallback-cleanup-not-always", workflowPath, jobName)
	}
	if !criticalNodeFailurePropagates(job) ||
		!criticalStepFailurePropagates(release) ||
		!cleanupStepAlways(release) ||
		!optionalTimeoutAtLeast(release.node, 5) ||
		!typedRelease ||
		!sourcePaid ||
		!sourceMatched {
		a.analyzer.add("invalid-fallback-release", workflowPath, jobName)
	}
	if !hasFallbackAggregate(jobs, jobName, sourceJob) {
		a.analyzer.add("missing-fallback-aggregate", workflowPath, jobName)
	}
}

func optionalTimeoutAtLeast(node *yaml.Node, minimum int) bool {
	timeout := mappingValue(node, "timeout-minutes")
	if timeout == nil {
		return true
	}
	if timeout.Kind != yaml.ScalarNode {
		return false
	}
	value, err := strconv.Atoi(timeout.Value)
	return err == nil && value >= minimum
}

func (a *unityPolicyAnalyzer) sourceAcquireMatches(
	workflowPath, jobName, suffix string,
) bool {
	if jobName == "" || suffix == "" {
		return false
	}
	workflow, err := a.analyzer.node(workflowPath)
	if err != nil {
		return false
	}
	job := mappingValue(mappingValue(workflow, "jobs"), jobName)
	if job == nil || job.Kind != yaml.MappingNode {
		return false
	}
	steps, err := a.flattenedSteps(
		sequenceValues(mappingValue(job, "steps")),
		make(map[string]bool),
		"job",
		nil,
		nil,
	)
	if err != nil {
		return false
	}
	matches := 0
	for _, step := range steps {
		acquire, _ := acquireReference(stepUses(step.node))
		if !acquire {
			continue
		}
		if !affirmativeStepRunnable(step) {
			return false
		}
		with := mappingValue(step.node, "with")
		if with == nil || with.Kind != yaml.MappingNode ||
			scalarValue(mappingValue(with, "lock-name")) != "wallstop-organization-builds" ||
			!optionalInputEquals(with, "lock-repository", "Ambiguous-Interactive/ambiguous-organization-build-lock") ||
			!optionalInputEquals(with, "state-branch", "lock-state") ||
			scalarValue(mappingValue(with, "holder-id-suffix")) != suffix {
			return false
		}
		matches++
	}
	return matches == 1
}

func (a *unityPolicyAnalyzer) paidSourceJob(
	workflow *yaml.Node,
	workflowPath, jobName string,
) bool {
	if jobName == "" {
		return false
	}
	licensed, err := a.analyzer.jobLicensed(workflowPath, jobName)
	if err != nil {
		return false
	}
	job := mappingValue(mappingValue(workflow, "jobs"), jobName)
	if job == nil || job.Kind != yaml.MappingNode {
		return false
	}
	text := strings.ToLower(nodeScalarText(mappingValue(workflow, "env")) + nodeScalarText(job))
	steps, err := a.flattenedSteps(
		sequenceValues(mappingValue(job, "steps")),
		make(map[string]bool),
		"job",
		nil,
		nil,
	)
	if err != nil {
		return false
	}
	for _, step := range steps {
		text += strings.ToLower(nodeScalarText(step.node))
	}
	return licensed || containsUnityLicenseCredentialReference(text)
}

func (a *unityPolicyAnalyzer) auditPaidJob(
	workflow, jobs *yaml.Node,
	workflowPath, jobName string,
	job *yaml.Node,
	steps []flattenedUnityStep,
	preflightJobs map[string]bool,
	licensed bool,
	protectedBranches map[string]bool,
	allowWorkflowDispatch bool,
) {
	if !licensed {
		a.analyzer.add("missing-lock-acquire", workflowPath, jobName)
	}
	if unsafeConcurrency(mappingValue(workflow, "concurrency")) {
		a.analyzer.add("unsafe-workflow-cancellation", workflowPath, jobName)
	}
	if unsafeConcurrency(mappingValue(job, "concurrency")) {
		a.analyzer.add("unsafe-job-cancellation", workflowPath, jobName)
	}
	if unsafe, err := unsafeMatrixFailFast(job); err != nil || unsafe {
		a.analyzer.add("unsafe-matrix-fail-fast", workflowPath, jobName)
	}
	if mappingValue(job, "environment") != nil {
		a.analyzer.add("approval-environment", workflowPath, jobName)
	}
	if jobEnvContainsCredential(job) {
		a.analyzer.add("job-scoped-unity-credential", workflowPath, jobName)
	}
	if !eligibleUnityTrigger(workflow, job, protectedBranches, allowWorkflowDispatch) {
		a.analyzer.add("ineligible-unity-trigger", workflowPath, jobName)
	}

	if len(steps) == 0 {
		a.analyzer.add("missing-licensed-steps", workflowPath, jobName)
		return
	}
	firstAcquire, firstActivation, unityReturn := -1, -1, -1
	acquireID, returnID, classifierID, releaseID := "", "", "", ""
	acquireScope, returnScope, classifierScope := "", "", ""
	returnAlways := false
	classifier, release, gate := -1, -1, -1
	classifierIsWrapper := false
	classifierTyped, classifierAlways := false, false
	releaseAlways, releaseTyped, gateAlways, gateTyped := false, false, false, false
	jobFailurePropagates := criticalNodeFailurePropagates(job)
	for index, step := range steps {
		node := step.node
		if step.cleanupWrapper {
			if !jobFailurePropagates || !criticalStepFailurePropagates(step) {
				continue
			}
			unityReturn = index
			returnID = stepID(node)
			returnScope = step.scope
			returnAlways = cleanupStepAlways(step)
			classifier = index
			classifierID = returnID
			classifierScope = step.scope
			classifierAlways = returnAlways
			classifierTyped = true
			classifierIsWrapper = true
			continue
		}
		uses := stepUses(node)
		if uses != "" {
			if isRemoteAction(uses) {
				ref := actionRef(uses)
				if !isSHA(ref) {
					a.analyzer.add("mutable-action-ref", workflowPath, jobName)
				} else if strings.HasPrefix(uses, lockActionPrefix) && !a.approved[strings.ToLower(ref)] {
					a.analyzer.add("unapproved-lock-ref", workflowPath, jobName)
				}
			}
			if acquire, ref := acquireReference(uses); acquire {
				if firstAcquire < 0 && jobFailurePropagates && affirmativeStepRunnable(step) {
					firstAcquire = index
					acquireID = stepID(node)
					acquireScope = step.scope
				}
				if !a.approved[strings.ToLower(ref)] {
					if isSHA(ref) {
						a.analyzer.add("unapproved-lock-ref", workflowPath, jobName)
					}
				}
			}
			switch lockActionName(uses) {
			case cleanupClassifierAction:
				if !jobFailurePropagates || !cleanupStepAlways(step) {
					a.analyzer.add("classifier-not-always", workflowPath, jobName)
					continue
				}
				classifier = index
				classifierID = stepID(node)
				classifierScope = step.scope
				classifierAlways = cleanupStepAlways(step)
				classifierIsWrapper = false
			case releaseAction:
				if !jobFailurePropagates || !cleanupStepAlways(step) {
					a.analyzer.add("release-not-always", workflowPath, jobName)
					continue
				}
				release = index
				releaseID = stepID(node)
				releaseAlways = cleanupStepAlways(step)
			case cleanupGateAction:
				if !jobFailurePropagates || !cleanupStepAlways(step) {
					a.analyzer.add("cleanup-gate-not-always", workflowPath, jobName)
					continue
				}
				gate = index
				gateAlways = cleanupStepAlways(step)
			}
		}
		if firstActivation < 0 && stepActivatesUnity(node) {
			firstActivation = index
		}
	}
	if !classifierIsWrapper && classifier >= 0 && unityReturn >= 0 &&
		returnID != "" && classifierScope == returnScope {
		classifierTyped = typedClassifierInputs(steps[classifier].node, returnID)
	}
	if release >= 0 && classifier >= 0 && classifierID != "" &&
		steps[release].scope == classifierScope {
		releaseTyped = typedReleaseInputs(steps[release].node, classifierID)
	}
	if gate >= 0 && acquireID != "" && classifierID != "" && releaseID != "" &&
		steps[gate].scope == acquireScope && steps[gate].scope == classifierScope &&
		steps[gate].scope == steps[release].scope {
		gateTyped = typedGateInputs(steps[gate].node, acquireID, classifierID, releaseID)
	}
	if firstAcquire < 0 {
		a.analyzer.add("missing-lock-acquire", workflowPath, jobName)
	}
	if firstActivation >= 0 && (firstAcquire < 0 || firstAcquire >= firstActivation) {
		a.analyzer.add("acquire-after-activation", workflowPath, jobName)
	}
	if unityReturn < 0 || returnID == "" || unityReturn <= firstActivation {
		a.analyzer.add("missing-unity-return", workflowPath, jobName)
	} else if !returnAlways {
		a.analyzer.add("unity-return-not-always", workflowPath, jobName)
	}
	if classifier < 0 {
		a.analyzer.add("missing-cleanup-classifier", workflowPath, jobName)
	} else {
		if !classifierAlways {
			a.analyzer.add("classifier-not-always", workflowPath, jobName)
		}
		if !classifierTyped {
			a.analyzer.add("classifier-inputs-not-typed", workflowPath, jobName)
		}
		if unityReturn >= 0 && (classifier < unityReturn ||
			(classifier == unityReturn && !classifierIsWrapper)) {
			a.analyzer.add("classifier-before-unity-return", workflowPath, jobName)
		}
	}
	if release < 0 {
		a.analyzer.add("missing-typed-release", workflowPath, jobName)
	} else {
		if !releaseAlways {
			a.analyzer.add("release-not-always", workflowPath, jobName)
		}
		if !releaseTyped {
			a.analyzer.add("release-inputs-not-typed", workflowPath, jobName)
		}
		if classifier >= 0 && release <= classifier {
			a.analyzer.add("release-before-classification", workflowPath, jobName)
		}
	}
	if gate < 0 {
		a.analyzer.add("missing-cleanup-gate", workflowPath, jobName)
	} else {
		if !gateAlways {
			a.analyzer.add("cleanup-gate-not-always", workflowPath, jobName)
		}
		if !gateTyped {
			a.analyzer.add("cleanup-gate-inputs-not-typed", workflowPath, jobName)
		}
		if release >= 0 && gate <= release {
			a.analyzer.add("cleanup-gate-before-release", workflowPath, jobName)
		}
	}
	if selfHostedJob(job) && !needsAny(job, preflightJobs) {
		a.analyzer.add("missing-runner-preflight", workflowPath, jobName)
	}
	if !hasAggregate(jobs, jobName, job, preflightJobs) {
		a.analyzer.add("missing-unity-aggregate", workflowPath, jobName)
	}
}

func (a *unityPolicyAnalyzer) flattenedSteps(
	steps []*yaml.Node,
	visiting map[string]bool,
	scope string,
	enclosingConditions []*yaml.Node,
	enclosingSteps []*yaml.Node,
) ([]flattenedUnityStep, error) {
	result := make([]flattenedUnityStep, 0, len(steps))
	for index, step := range steps {
		uses := stepUses(step)
		if !strings.HasPrefix(uses, "./") {
			result = append(result, flattenedUnityStep{
				node:                step,
				scope:               scope,
				enclosingConditions: append([]*yaml.Node(nil), enclosingConditions...),
				enclosingSteps:      append([]*yaml.Node(nil), enclosingSteps...),
			})
			continue
		}
		actionPath := strings.TrimPrefix(uses, "./")
		manifestPath, err := a.analyzer.actionManifest(actionPath)
		if err != nil {
			return nil, err
		}
		if visiting[manifestPath] {
			return nil, fmt.Errorf("composite action cycle at %s", manifestPath)
		}
		manifest, err := a.analyzer.node(manifestPath)
		if err != nil {
			return nil, err
		}
		runs := mappingValue(manifest, "runs")
		using, err := requiredScalar(mappingValue(runs, "using"), manifestPath+" runs.using")
		if err != nil {
			return nil, err
		}
		if using != "composite" {
			result = append(result, flattenedUnityStep{
				node:                step,
				scope:               scope,
				enclosingConditions: append([]*yaml.Node(nil), enclosingConditions...),
				enclosingSteps:      append([]*yaml.Node(nil), enclosingSteps...),
			})
			continue
		}
		visiting[manifestPath] = true
		nestedConditions := append([]*yaml.Node(nil), enclosingConditions...)
		if condition := mappingValue(step, "if"); condition != nil {
			nestedConditions = append(nestedConditions, condition)
		}
		nestedEnclosingSteps := append([]*yaml.Node(nil), enclosingSteps...)
		nestedEnclosingSteps = append(nestedEnclosingSteps, step)
		nested, err := a.flattenedSteps(
			sequenceValues(mappingValue(runs, "steps")),
			visiting,
			fmt.Sprintf("%s/%d", scope, index),
			nestedConditions,
			nestedEnclosingSteps,
		)
		delete(visiting, manifestPath)
		if err != nil {
			return nil, err
		}
		result = append(result, nested...)
		wrapper := flattenedUnityStep{
			node:                step,
			scope:               scope,
			enclosingConditions: append([]*yaml.Node(nil), enclosingConditions...),
			enclosingSteps:      append([]*yaml.Node(nil), enclosingSteps...),
		}
		if a.validCleanupComposite(wrapper, manifest) {
			wrapper.cleanupWrapper = true
			result = append(result, wrapper)
		}
	}
	return result, nil
}

func (a *unityPolicyAnalyzer) validCleanupComposite(
	wrapper flattenedUnityStep,
	manifest *yaml.Node,
) bool {
	if stepID(wrapper.node) == "" || !cleanupStepAlways(wrapper) {
		return false
	}
	runs := mappingValue(manifest, "runs")
	steps := sequenceValues(mappingValue(runs, "steps"))
	if len(steps) == 0 {
		return false
	}

	trustedClassifiers := make(map[string]bool)
	redundantClassifier := ""
	returnIndex := -1
	returnID := ""
	for index, step := range steps {
		if compositeReturnEvidence(step) && stepID(step) != "" &&
			conditionIsSafeAlways(mappingValue(step, "if")) {
			returnIndex = index
			returnID = stepID(step)
		}
		if lockActionName(stepUses(step)) != cleanupClassifierAction ||
			!a.approved[strings.ToLower(actionRef(stepUses(step)))] ||
			stepID(step) == "" || !criticalNodeFailurePropagates(step) {
			continue
		}
		if returnIndex >= 0 && index > returnIndex &&
			conditionIsSafeAlways(mappingValue(step, "if")) &&
			typedClassifierInputs(step, returnID) {
			trustedClassifiers[stepID(step)] = true
			redundantClassifier = stepID(step)
			continue
		}
	}
	if redundantClassifier == "" {
		return false
	}

	outputs := mappingValue(manifest, "outputs")
	for _, output := range []string{
		"resource-cleanup-status",
		"resource-health",
		"resource-reason",
		"classification-complete",
	} {
		definition := mappingValue(outputs, output)
		if definition == nil || definition.Kind != yaml.MappingNode ||
			!outputForwardsTrustedClassifiers(
				mappingValue(definition, "value"),
				output,
				redundantClassifier,
				trustedClassifiers,
			) {
			return false
		}
	}
	return true
}

func outputForwardsTrustedClassifiers(
	value *yaml.Node,
	output, required string,
	trusted map[string]bool,
) bool {
	if value == nil || value.Kind != yaml.ScalarNode {
		return false
	}
	expression := strings.Join(strings.Fields(value.Value), "")
	expression = strings.TrimPrefix(expression, "${{")
	expression = strings.TrimSuffix(expression, "}}")
	parts := strings.Split(expression, "||")
	foundRequired := false
	for _, part := range parts {
		const prefix = "steps."
		suffix := ".outputs." + output
		if !strings.HasPrefix(part, prefix) || !strings.HasSuffix(part, suffix) {
			return false
		}
		id := strings.TrimSuffix(strings.TrimPrefix(part, prefix), suffix)
		if !trusted[id] {
			return false
		}
		foundRequired = foundRequired || id == required
	}
	return foundRequired
}

func stepReferenceID(value *yaml.Node, output string) string {
	if value == nil || value.Kind != yaml.ScalarNode {
		return ""
	}
	expression := strings.Join(strings.Fields(value.Value), "")
	const prefix = "${{steps."
	suffix := ".outputs." + output + "}}"
	if !strings.HasPrefix(expression, prefix) || !strings.HasSuffix(expression, suffix) {
		return ""
	}
	return strings.TrimSuffix(strings.TrimPrefix(expression, prefix), suffix)
}

func scalarValue(node *yaml.Node) string {
	if node == nil || node.Kind != yaml.ScalarNode {
		return ""
	}
	return node.Value
}

func (a *unityPolicyAnalyzer) preflightJobs(jobs *yaml.Node) map[string]bool {
	result := make(map[string]bool)
	for index := 0; index < len(jobs.Content); index += 2 {
		jobName, job := jobs.Content[index].Value, jobs.Content[index+1]
		if !affirmativeCondition(mappingValue(job, "if")) ||
			!criticalNodeFailurePropagates(job) {
			continue
		}
		for _, step := range sequenceValues(mappingValue(job, "steps")) {
			uses := stepUses(step)
			if lockActionName(uses) == preflightAction &&
				a.approved[strings.ToLower(actionRef(uses))] &&
				affirmativeCondition(mappingValue(step, "if")) &&
				criticalNodeFailurePropagates(step) {
				result[jobName] = true
			}
		}
	}
	return result
}

func sortUnityResult(result *UnityEnrollmentResult, findings []Finding) {
	sort.Slice(result.Inventory, func(i, j int) bool {
		left, right := result.Inventory[i], result.Inventory[j]
		if left.Repository != right.Repository {
			return left.Repository < right.Repository
		}
		if left.Path != right.Path {
			return left.Path < right.Path
		}
		return left.Job < right.Job
	})
	result.Findings = append(result.Findings, findings...)
	sort.Slice(result.Findings, func(i, j int) bool {
		left, right := result.Findings[i], result.Findings[j]
		if left.Path != right.Path {
			return left.Path < right.Path
		}
		if left.Job != right.Job {
			return left.Job < right.Job
		}
		return left.Code < right.Code
	})
}

func nodeScalarText(node *yaml.Node) string {
	if node == nil {
		return ""
	}
	if node.Kind == yaml.ScalarNode {
		return node.Value + "\n"
	}
	var builder strings.Builder
	for _, child := range node.Content {
		builder.WriteString(nodeScalarText(child))
	}
	return builder.String()
}

func containsUnityCredentialReference(text string) bool {
	text = strings.ToLower(strings.Join(strings.Fields(text), ""))
	return containsCredentialName(text, []string{
		"unity_serial", "unity_email", "unity_password", "unity_license",
		"build_lock_app_id", "build_lock_app_private_key",
	})
}

func containsUnityLicenseCredentialReference(text string) bool {
	text = strings.ToLower(strings.Join(strings.Fields(text), ""))
	return containsCredentialName(text, []string{
		"unity_serial", "unity_email", "unity_password", "unity_license",
	})
}

func containsCredentialName(text string, sensitiveNames []string) bool {
	for _, name := range sensitiveNames {
		if strings.Contains(text, "secrets."+name) ||
			strings.Contains(text, "secrets['"+name+"']") ||
			strings.Contains(text, `secrets["`+name+`"]`) {
			return true
		}
	}
	if strings.Contains(text, "secrets[") {
		for _, name := range sensitiveNames {
			if strings.Contains(text, name) {
				return true
			}
		}
	}
	return false
}

func containsReleaseAction(steps []flattenedUnityStep) bool {
	for _, step := range steps {
		uses := strings.ToLower(stepUses(step.node))
		prefix := strings.ToLower(lockActionPrefix + releaseAction + "@")
		if strings.HasPrefix(uses, prefix) {
			return true
		}
	}
	return false
}

func containsReviewRequiredMarker(text string) bool {
	for _, marker := range []string{
		"unity_serial", "unity_email", "unity_password", "unity-editor",
		"game-ci/unity-builder", "game-ci/unity-test-runner",
	} {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return false
}

func containsUnityMarker(text string) bool {
	return containsReviewRequiredMarker(text) ||
		strings.Contains(text, strings.ToLower(lockActionPrefix)) ||
		strings.Contains(text, "unity")
}

func workflowDispatchOnly(workflow *yaml.Node) bool {
	on := mappingValue(workflow, "on")
	if on == nil {
		return false
	}
	if on.Kind == yaml.ScalarNode {
		return on.Value == "workflow_dispatch"
	}
	if on.Kind == yaml.MappingNode && len(on.Content) == 2 {
		return on.Content[0].Value == "workflow_dispatch"
	}
	if on.Kind == yaml.SequenceNode && len(on.Content) == 1 {
		return on.Content[0].Value == "workflow_dispatch"
	}
	return false
}

func stepUses(step *yaml.Node) string {
	node := mappingValue(step, "uses")
	if node == nil || node.Kind != yaml.ScalarNode {
		return ""
	}
	return node.Value
}

func isRemoteAction(uses string) bool {
	return uses != "" && !strings.HasPrefix(uses, "./") && !strings.HasPrefix(uses, "docker://")
}

func actionRef(uses string) string {
	at := strings.LastIndex(uses, "@")
	if at < 0 {
		return ""
	}
	return uses[at+1:]
}

func lockActionName(uses string) string {
	if !strings.HasPrefix(uses, lockActionPrefix) {
		return ""
	}
	at := strings.LastIndex(uses, "@")
	if at < len(lockActionPrefix) {
		return ""
	}
	return strings.TrimSuffix(uses[len(lockActionPrefix):at], "/")
}

func conditionIsSafeAlways(node *yaml.Node) bool {
	if node == nil || node.Kind != yaml.ScalarNode {
		return false
	}
	value := strings.ToLower(strings.Join(strings.Fields(node.Value), ""))
	value = strings.TrimPrefix(value, "${{")
	value = strings.TrimSuffix(value, "}}")
	return value == "always()"
}

func cleanupStepAlways(step flattenedUnityStep) bool {
	if !conditionIsSafeAlways(mappingValue(step.node, "if")) ||
		!criticalStepFailurePropagates(step) {
		return false
	}
	for _, condition := range step.enclosingConditions {
		if !conditionIsSafeAlways(condition) {
			return false
		}
	}
	return true
}

func affirmativeStepRunnable(step flattenedUnityStep) bool {
	if !affirmativeCondition(mappingValue(step.node, "if")) ||
		!criticalStepFailurePropagates(step) {
		return false
	}
	for _, condition := range step.enclosingConditions {
		if !affirmativeCondition(condition) {
			return false
		}
	}
	return true
}

func affirmativeCondition(condition *yaml.Node) bool {
	return condition == nil || conditionIsSafeAlways(condition)
}

func criticalStepFailurePropagates(step flattenedUnityStep) bool {
	if !criticalNodeFailurePropagates(step.node) {
		return false
	}
	for _, enclosing := range step.enclosingSteps {
		if !criticalNodeFailurePropagates(enclosing) {
			return false
		}
	}
	return true
}

func criticalNodeFailurePropagates(node *yaml.Node) bool {
	value := mappingValue(node, "continue-on-error")
	if value == nil {
		return true
	}
	return value.Kind == yaml.ScalarNode && value.Tag == "!!bool" && value.Value == "false"
}

func stepID(step *yaml.Node) string {
	id := mappingValue(step, "id")
	if id == nil || id.Kind != yaml.ScalarNode || !validStepID(id.Value) {
		return ""
	}
	return id.Value
}

func validStepID(value string) bool {
	if value == "" {
		return false
	}
	for index, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') ||
			(index > 0 && char >= '0' && char <= '9') || (index > 0 && (char == '_' || char == '-')) {
			continue
		}
		return false
	}
	return true
}

func exactStepOutput(value *yaml.Node, id, output string) bool {
	if value == nil || value.Kind != yaml.ScalarNode || id == "" {
		return false
	}
	return strings.Join(strings.Fields(value.Value), "") ==
		"${{steps."+id+".outputs."+output+"}}"
}

func exactStepOutcome(value *yaml.Node, id string) bool {
	if value == nil || value.Kind != yaml.ScalarNode || id == "" {
		return false
	}
	return strings.Join(strings.Fields(value.Value), "") == "${{steps."+id+".outcome}}"
}

func typedReleaseInputs(step *yaml.Node, classifierID string) bool {
	with := mappingValue(step, "with")
	if with == nil || with.Kind != yaml.MappingNode {
		return false
	}
	for input, output := range map[string]string{
		"resource-cleanup-status": "resource-cleanup-status",
		"resource-health":         "resource-health",
		"resource-reason":         "resource-reason",
	} {
		if !exactStepOutput(mappingValue(with, input), classifierID, output) {
			return false
		}
	}
	return true
}

func fallbackReleaseSource(step, job *yaml.Node) (string, string, bool) {
	with := mappingValue(step, "with")
	env := mappingValue(step, "env")
	if with == nil || with.Kind != yaml.MappingNode ||
		env == nil || env.Kind != yaml.MappingNode ||
		len(env.Content) != 4 ||
		!mappingHasOnlyKeys(with, map[string]bool{
			"lock-name":               true,
			"holder-id":               true,
			"holder-id-suffix":        true,
			"runner-id":               true,
			"resource-cleanup-status": true,
			"resource-health":         true,
			"resource-reason":         true,
			"lock-repository":         true,
			"state-branch":            true,
		}) {
		return "", "", false
	}
	if scalarValue(mappingValue(with, "lock-name")) != "wallstop-organization-builds" ||
		!optionalInputEquals(with, "lock-repository", "Ambiguous-Interactive/ambiguous-organization-build-lock") ||
		!optionalInputEquals(with, "state-branch", "lock-state") ||
		mappingValue(with, "resource-safe") != nil ||
		scalarValue(mappingValue(with, "runner-id")) != "${{ runner.name }}" ||
		scalarValue(mappingValue(with, "resource-cleanup-status")) != "unknown" ||
		scalarValue(mappingValue(with, "resource-health")) != "healthy" ||
		scalarValue(mappingValue(with, "resource-reason")) != "return-terminated" ||
		scalarValue(mappingValue(env, "BUILD_LOCK_APP_ID")) != "${{ secrets.BUILD_LOCK_APP_ID }}" ||
		scalarValue(mappingValue(env, "BUILD_LOCK_APP_PRIVATE_KEY")) != "${{ secrets.BUILD_LOCK_APP_PRIVATE_KEY }}" {
		return "", "", false
	}

	holderID := scalarValue(mappingValue(with, "holder-id"))
	prefix := ""
	for _, candidate := range []string{
		"${{ github.repository }}:${{ github.run_id }}:",
		"${{github.repository}}:${{github.run_id}}:",
		"${{ github.repository }}:${{github.run_id}}:",
		"${{github.repository}}:${{ github.run_id }}:",
	} {
		if strings.HasPrefix(holderID, candidate) {
			prefix = candidate
			break
		}
	}
	if prefix == "" {
		return "", "", false
	}
	identity := strings.TrimPrefix(holderID, prefix)
	separator := strings.Index(identity, ":")
	if separator <= 0 || separator == len(identity)-1 {
		return "", "", false
	}
	sourceJob, suffix := identity[:separator], identity[separator+1:]
	if !needsAny(job, map[string]bool{sourceJob: true}) ||
		scalarValue(mappingValue(with, "holder-id-suffix")) != suffix ||
		!literalHolderSuffix(suffix) {
		return "", "", false
	}
	return sourceJob, suffix, true
}

func optionalInputEquals(with *yaml.Node, input, expected string) bool {
	value := mappingValue(with, input)
	return value == nil || scalarValue(value) == expected
}

func mappingHasOnlyKeys(node *yaml.Node, allowed map[string]bool) bool {
	if node == nil || node.Kind != yaml.MappingNode {
		return false
	}
	seen := make(map[string]bool, len(node.Content)/2)
	for index := 0; index < len(node.Content); index += 2 {
		key := node.Content[index].Value
		if node.Content[index].Kind != yaml.ScalarNode ||
			!allowed[key] ||
			seen[key] {
			return false
		}
		seen[key] = true
	}
	return true
}

func literalHolderSuffix(value string) bool {
	return value != "" &&
		strings.TrimSpace(value) == value &&
		!strings.ContainsAny(value, "\r\n") &&
		!strings.Contains(value, "${{")
}

func typedClassifierInputs(step *yaml.Node, returnID string) bool {
	with := mappingValue(step, "with")
	if with == nil || with.Kind != yaml.MappingNode {
		return false
	}
	for input, output := range map[string]string{
		"return-log-path":           "return-log-path",
		"return-command-completed":  "return-command-completed",
		"return-exit-code":          "return-exit-code",
		"evidence-capture-complete": "evidence-capture-complete",
	} {
		if !exactStepOutput(mappingValue(with, input), returnID, output) {
			return false
		}
	}
	return true
}

func typedGateInputs(step *yaml.Node, acquireID, classifierID, releaseID string) bool {
	with := mappingValue(step, "with")
	if with == nil || with.Kind != yaml.MappingNode {
		return false
	}
	if !exactStepOutput(mappingValue(with, "acquired"), acquireID, "acquired") ||
		!exactStepOutcome(mappingValue(with, "release-outcome"), releaseID) {
		return false
	}
	for input, output := range map[string]string{
		"classification-complete": "classification-complete",
		"cleanup-status":          "resource-cleanup-status",
		"cleanup-health":          "resource-health",
		"cleanup-reason":          "resource-reason",
	} {
		if !exactStepOutput(mappingValue(with, input), classifierID, output) {
			return false
		}
	}
	for input, output := range map[string]string{
		"cleanup-result": "cleanup-result",
		"released":       "released",
		"release-health": "resource-health",
		"release-reason": "resource-reason",
	} {
		if !exactStepOutput(mappingValue(with, input), releaseID, output) {
			return false
		}
	}
	return true
}

func eligibleUnityTrigger(
	workflow, job *yaml.Node,
	protectedBranches map[string]bool,
	allowWorkflowDispatch bool,
) bool {
	on := mappingValue(workflow, "on")
	if on == nil {
		return false
	}
	eligible := func(event string, config *yaml.Node) bool {
		switch event {
		case "workflow_dispatch":
			return allowWorkflowDispatch
		case "pull_request":
			return sameRepositoryPullRequestGuard(mappingValue(job, "if"))
		case "pull_request_target":
			return jobExcludedFromEvents(mappingValue(job, "if"), map[string]bool{event: true})
		case "push":
			if config == nil || config.Kind != yaml.MappingNode {
				return false
			}
			if mappingValue(config, "tags") != nil || mappingValue(config, "tags-ignore") != nil ||
				mappingValue(config, "branches-ignore") != nil {
				return false
			}
			branches := mappingValue(config, "branches")
			if branches == nil {
				return false
			}
			values := sequenceValues(branches)
			if branches.Kind == yaml.ScalarNode {
				values = []*yaml.Node{branches}
			}
			if len(values) == 0 {
				return false
			}
			for _, branch := range values {
				if branch.Kind != yaml.ScalarNode || !protectedBranches[branch.Value] {
					return false
				}
			}
			return true
		default:
			return false
		}
	}
	switch on.Kind {
	case yaml.ScalarNode:
		return eligible(on.Value, nil)
	case yaml.SequenceNode:
		if len(on.Content) == 0 {
			return false
		}
		for _, event := range on.Content {
			if event.Kind != yaml.ScalarNode || !eligible(event.Value, nil) {
				return false
			}
		}
		return true
	case yaml.MappingNode:
		if len(on.Content) == 0 {
			return false
		}
		for index := 0; index < len(on.Content); index += 2 {
			if on.Content[index].Kind != yaml.ScalarNode ||
				!eligible(on.Content[index].Value, on.Content[index+1]) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func stepActivatesUnity(step *yaml.Node) bool {
	uses := strings.ToLower(stepUses(step))
	if strings.Contains(uses, "game-ci/unity-builder@") || strings.Contains(uses, "game-ci/unity-test-runner@") {
		return true
	}
	run := mappingValue(step, "run")
	if run == nil || run.Kind != yaml.ScalarNode {
		return false
	}
	text := strings.ToLower(run.Value)
	return (strings.Contains(text, "unity-editor") || strings.Contains(text, "unity.exe")) &&
		!strings.Contains(text, "-returnlicense")
}

func stepReturnsUnity(step *yaml.Node) bool {
	run := mappingValue(step, "run")
	if run == nil || run.Kind != yaml.ScalarNode {
		return false
	}
	text := strings.ToLower(run.Value)
	if !strings.Contains(text, "-returnlicense") {
		return false
	}
	return strings.Contains(text, "unity-editor") || strings.Contains(text, "unity.exe") ||
		(strings.Contains(text, "& $") && strings.Contains(text, "@return"))
}

func compositeReturnEvidence(step *yaml.Node) bool {
	if !stepReturnsUnity(step) || !conditionIsSafeAlways(mappingValue(step, "if")) ||
		!criticalNodeFailurePropagates(step) {
		return false
	}
	shell := mappingValue(step, "shell")
	if shell == nil || shell.Kind != yaml.ScalarNode || shell.Value != "bash" {
		return false
	}
	lines := make([]string, 0)
	for _, line := range strings.Split(scalarValue(mappingValue(step, "run")), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			lines = append(lines, line)
		}
	}
	expected := []string{
		`return_log="${RUNNER_TEMP}/return.log"`,
		"command_completed=false",
		"evidence_capture_complete=false",
		"set +e",
		`unity-editor -batchmode -returnlicense -logFile "$return_log"`,
		"return_exit_code=$?",
		"set -e",
		"command_completed=true",
		"evidence_capture_complete=true",
		`echo "return-log-path=$return_log" >> "$GITHUB_OUTPUT"`,
		`echo "return-command-completed=$command_completed" >> "$GITHUB_OUTPUT"`,
		`echo "return-exit-code=$return_exit_code" >> "$GITHUB_OUTPUT"`,
		`echo "evidence-capture-complete=$evidence_capture_complete" >> "$GITHUB_OUTPUT"`,
	}
	if len(lines) != len(expected) {
		return false
	}
	for index := range expected {
		if lines[index] != expected[index] {
			return false
		}
	}
	return true
}

func jobEnvContainsCredential(job *yaml.Node) bool {
	env := mappingValue(job, "env")
	if env == nil || env.Kind != yaml.MappingNode {
		return false
	}
	for index := 0; index < len(env.Content); index += 2 {
		value := strings.ToLower(nodeScalarText(env.Content[index+1]))
		if containsUnityCredentialReference(value) {
			return true
		}
	}
	return false
}

func selfHostedJob(job *yaml.Node) bool {
	return strings.Contains(strings.ToLower(nodeScalarText(mappingValue(job, "runs-on"))), "self-hosted")
}

func needsAny(job *yaml.Node, candidates map[string]bool) bool {
	needs := mappingValue(job, "needs")
	if needs == nil {
		return false
	}
	if needs.Kind == yaml.ScalarNode {
		return candidates[needs.Value]
	}
	if needs.Kind == yaml.SequenceNode {
		for _, value := range needs.Content {
			if value.Kind == yaml.ScalarNode && candidates[value.Value] {
				return true
			}
		}
	}
	return false
}

func hasAggregate(
	jobs *yaml.Node,
	licensedJob string,
	licensedJobNode *yaml.Node,
	preflightJobs map[string]bool,
) bool {
	requiredPreflights := neededCandidates(licensedJobNode, preflightJobs)
	if len(requiredPreflights) == 0 {
		return false
	}
	for index := 0; index < len(jobs.Content); index += 2 {
		job := jobs.Content[index+1]
		if !needsAny(job, map[string]bool{licensedJob: true}) ||
			!conditionIsSafeAlways(mappingValue(job, "if")) ||
			!criticalNodeFailurePropagates(job) {
			continue
		}
		for _, step := range sequenceValues(mappingValue(job, "steps")) {
			for preflight := range requiredPreflights {
				if needsAny(job, map[string]bool{preflight: true}) &&
					aggregateStepEnforces(step, licensedJob, preflight) {
					return true
				}
			}
		}
	}
	return false
}

func hasFallbackAggregate(jobs *yaml.Node, fallbackJob, sourceJob string) bool {
	if sourceJob == "" {
		return false
	}
	for index := 0; index < len(jobs.Content); index += 2 {
		job := jobs.Content[index+1]
		unsafeFailFast, matrixErr := unsafeMatrixFailFast(job)
		if !needsAny(job, map[string]bool{fallbackJob: true}) ||
			!needsAny(job, map[string]bool{sourceJob: true}) ||
			!conditionIsSafeAlways(mappingValue(job, "if")) ||
			!criticalNodeFailurePropagates(job) ||
			scalarValue(mappingValue(job, "runs-on")) != "ubuntu-latest" ||
			mappingValue(job, "environment") != nil ||
			unsafeConcurrency(mappingValue(job, "concurrency")) ||
			matrixErr != nil ||
			unsafeFailFast {
			continue
		}
		for _, step := range sequenceValues(mappingValue(job, "steps")) {
			if !affirmativeCondition(mappingValue(step, "if")) ||
				!criticalNodeFailurePropagates(step) {
				continue
			}
			shell := mappingValue(step, "shell")
			if shell == nil || shell.Kind != yaml.ScalarNode ||
				(shell.Value != "bash" && shell.Value != "sh") {
				continue
			}
			run := mappingValue(step, "run")
			if run == nil || run.Kind != yaml.ScalarNode {
				continue
			}
			lines := make([]string, 0, 1)
			for _, line := range strings.Split(run.Value, "\n") {
				if line = strings.TrimSpace(line); line != "" {
					lines = append(lines, line)
				}
			}
			sourceFound, fallbackFound, valid := false, false, true
			for _, line := range lines {
				checkedJob := aggregateResultCheckJob(line)
				if checkedJob == "" ||
					!needsAny(job, map[string]bool{checkedJob: true}) ||
					mappingValue(jobs, checkedJob) == nil {
					valid = false
					break
				}
				sourceFound = sourceFound || checkedJob == sourceJob
				fallbackFound = fallbackFound || checkedJob == fallbackJob
			}
			if valid && sourceFound && fallbackFound {
				return true
			}
		}
	}
	return false
}

func aggregateResultCheckJob(line string) string {
	const prefix = `test "${{ needs.`
	const suffix = `.result }}" = success`
	if !strings.HasPrefix(line, prefix) || !strings.HasSuffix(line, suffix) {
		return ""
	}
	job := strings.TrimSuffix(strings.TrimPrefix(line, prefix), suffix)
	if job == "" || strings.ContainsAny(job, " \t\r\n{}$\"'") {
		return ""
	}
	return job
}

func neededCandidates(job *yaml.Node, candidates map[string]bool) map[string]bool {
	result := make(map[string]bool)
	needs := mappingValue(job, "needs")
	if needs == nil {
		return result
	}
	if needs.Kind == yaml.ScalarNode && candidates[needs.Value] {
		result[needs.Value] = true
	}
	if needs.Kind == yaml.SequenceNode {
		for _, value := range needs.Content {
			if value.Kind == yaml.ScalarNode && candidates[value.Value] {
				result[value.Value] = true
			}
		}
	}
	return result
}

func aggregateStepEnforces(step *yaml.Node, licensedJob, preflightJob string) bool {
	if !affirmativeCondition(mappingValue(step, "if")) ||
		!criticalNodeFailurePropagates(step) {
		return false
	}
	run := mappingValue(step, "run")
	if run == nil || run.Kind != yaml.ScalarNode {
		return false
	}
	shell := mappingValue(step, "shell")
	if shell != nil && (shell.Kind != yaml.ScalarNode ||
		(shell.Value != "bash" && shell.Value != "sh")) {
		return false
	}
	lines := make([]string, 0, 2)
	for _, line := range strings.Split(run.Value, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) != 2 {
		return false
	}
	expected := map[string]bool{
		`test "${{ needs.` + licensedJob + `.result }}" = success`:  false,
		`test "${{ needs.` + preflightJob + `.result }}" = success`: false,
	}
	for _, line := range lines {
		if _, exists := expected[line]; !exists || expected[line] {
			return false
		}
		expected[line] = true
	}
	for _, found := range expected {
		if !found {
			return false
		}
	}
	return true
}

func sameRepositoryPullRequestGuard(condition *yaml.Node) bool {
	if condition == nil || condition.Kind != yaml.ScalarNode {
		return false
	}
	value := strings.ToLower(strings.Join(strings.Fields(condition.Value), ""))
	value = strings.TrimPrefix(value, "${{")
	value = strings.TrimSuffix(value, "}}")
	direct := "github.event.pull_request.head.repo.full_name==github.repository"
	reverse := "github.repository==github.event.pull_request.head.repo.full_name"
	eventGuard := "github.event_name!='pull_request'||"
	if value == direct || value == reverse ||
		value == eventGuard+direct || value == eventGuard+reverse {
		return true
	}
	conjuncts, topLevelOr := conditionTerms(value)
	if topLevelOr {
		return false
	}
	for _, conjunct := range conjuncts {
		conjunct = trimOuterParentheses(conjunct)
		if conjunct == direct || conjunct == reverse ||
			conjunct == eventGuard+direct || conjunct == eventGuard+reverse {
			return true
		}
	}
	return false
}

func fallbackConditionCoversSource(condition *yaml.Node, sourceJob string) bool {
	if condition == nil || condition.Kind != yaml.ScalarNode {
		return false
	}
	value := strings.ToLower(strings.Join(strings.Fields(condition.Value), ""))
	value = strings.TrimPrefix(value, "${{")
	value = strings.TrimSuffix(value, "}}")
	conjuncts, topLevelOr := conditionTerms(value)
	if topLevelOr || len(conjuncts) == 0 {
		return false
	}
	foundAlways := false
	for _, conjunct := range conjuncts {
		conjunct = trimOuterParentheses(conjunct)
		switch conjunct {
		case "always()":
			foundAlways = true
		case "needs." + strings.ToLower(sourceJob) + ".result!='skipped'",
			"github.actor!='dependabot[bot]'":
		default:
			direct := "github.event.pull_request.head.repo.full_name==github.repository"
			reverse := "github.repository==github.event.pull_request.head.repo.full_name"
			eventGuard := "github.event_name!='pull_request'||"
			if conjunct != eventGuard+direct && conjunct != eventGuard+reverse {
				return false
			}
		}
	}
	return foundAlways
}
