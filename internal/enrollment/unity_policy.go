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
	changeClassifierAction  = "classify-unity-changes"
	classifierCheckoutRef   = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
	cleanupClassifierAction = "classify-unity-cleanup-evidence"
	cleanupGateAction       = "require-confirmed-unity-cleanup"
	preflightAction         = "check-unity-runner-availability"
	releaseAction           = "release-build-lock"
	returnAction            = "return-unity-license"
	validationGateAction    = "require-unity-validation"

	UnityInventoryPaidSerial         = "paid-serial"
	UnityInventoryFallbackCleanup    = "fallback-cleanup"
	UnityInventoryControlledCanary   = "controlled-canary"
	UnityInventorySynthetic          = "synthetic"
	UnityInventoryDisabled           = "disabled"
	UnityInventoryNonLicensingStatic = "non-licensing-static"
)

// ValidUnityInventoryClassification is the shared artifact-schema allowlist
// used by both the analyzer and downstream consumers.
func ValidUnityInventoryClassification(value string) bool {
	switch value {
	case UnityInventoryPaidSerial,
		UnityInventoryFallbackCleanup,
		UnityInventoryControlledCanary,
		UnityInventorySynthetic,
		UnityInventoryDisabled,
		UnityInventoryNonLicensingStatic:
		return true
	default:
		return false
	}
}

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
	ApprovedReturnSHAs    []string               `json:"approvedReturnShas"`
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
	analyzer        *analyzer
	approved        map[string]bool
	approvedReturns map[string]bool
	exceptions      map[string]UnityPolicyException
	usedExceptions  map[string]bool
	now             time.Time
}

type flattenedUnityStep struct {
	node                *yaml.Node
	scope               string
	enclosingConditions []*yaml.Node
	enclosingSteps      []*yaml.Node
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
	approvedReturns := make(map[string]bool, len(policy.ApprovedReturnSHAs))
	for _, sha := range policy.ApprovedReturnSHAs {
		sha = strings.ToLower(strings.TrimSpace(sha))
		if !isSHA(sha) {
			return UnityEnrollmentResult{}, fmt.Errorf("approved return SHA must be a full immutable commit SHA")
		}
		if approvedReturns[sha] {
			return UnityEnrollmentResult{}, fmt.Errorf("approved return SHA list contains a duplicate")
		}
		if !approved[sha] {
			return UnityEnrollmentResult{}, fmt.Errorf("approved return SHA must also be an approved lock SHA")
		}
		approvedReturns[sha] = true
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
		if exception.Classification != UnityInventorySynthetic &&
			exception.Classification != UnityInventoryDisabled {
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
		analyzer:        base,
		approved:        approved,
		approvedReturns: approvedReturns,
		exceptions:      exceptions,
		usedExceptions:  make(map[string]bool),
		now:             now,
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

			classification := UnityInventoryNonLicensingStatic
			if fallbackCleanup {
				classification = UnityInventoryFallbackCleanup
			} else if paid {
				classification = UnityInventoryPaidSerial
				if workflowDispatchOnly(workflow) {
					classification = UnityInventoryControlledCanary
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
	if !a.hasFallbackAggregate(workflow, workflowPath, jobs, jobName, sourceJob) {
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
	firstAcquire, firstActivation, lastActivation, unityReturn := -1, -1, -1, -1
	acquireCount, returnActionCount := 0, 0
	acquireID, returnID, classifierID, releaseID := "", "", "", ""
	acquireScope, returnScope, classifierScope := "", "", ""
	returnAlways := false
	classifier, release, gate := -1, -1, -1
	classifierTyped, classifierAlways := false, false
	releaseAlways, releaseTyped, gateAlways, gateTyped := false, false, false, false
	jobFailurePropagates := criticalNodeFailurePropagates(job)
	for index, step := range steps {
		node := step.node
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
				acquireCount++
				if acquireCount == 1 && jobFailurePropagates && affirmativeStepRunnable(step) {
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
			case returnAction:
				returnActionCount++
				if !exactLockActionReference(uses, returnAction) ||
					!a.approvedReturns[strings.ToLower(actionRef(uses))] ||
					!jobFailurePropagates ||
					acquireID == "" ||
					!cleanupStepAfterAcquire(step, acquireID) ||
					!optionalTimeoutAtLeast(node, 5) ||
					!typedReturnInputs(node, job, steps, firstAcquire, index) {
					continue
				}
				unityReturn = index
				returnID = stepID(node)
				returnScope = step.scope
				returnAlways = true
			case cleanupClassifierAction:
				classifierCondition := cleanupStepAlways(step)
				if returnActionCount > 0 {
					classifierCondition = exactLockActionReference(uses, cleanupClassifierAction) &&
						a.approved[strings.ToLower(actionRef(uses))] &&
						acquireID != "" &&
						cleanupStepAfterAcquire(step, acquireID) &&
						optionalTimeoutAtLeast(node, 2) &&
						trustedLeafExecution(node)
				}
				if !jobFailurePropagates || !classifierCondition {
					a.analyzer.add("classifier-not-always", workflowPath, jobName)
					continue
				}
				classifier = index
				classifierID = stepID(node)
				classifierScope = step.scope
				classifierAlways = classifierCondition
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
		if stepActivatesUnity(node) {
			lastActivation = index
		}
	}
	if returnActionCount > 0 &&
		(!centralReturnExecutionIsolated(workflow, job) ||
			!windowsSelfHostedJob(job) ||
			!optionalTimeoutAtLeast(job, 5)) {
		a.analyzer.add("unsafe-return-execution-environment", workflowPath, jobName)
	}
	if acquireCount != 1 {
		firstAcquire = -1
		acquireID = ""
		acquireScope = ""
		if acquireCount > 1 {
			a.analyzer.add("ambiguous-lock-acquire", workflowPath, jobName)
		}
	}
	if returnActionCount > 1 {
		unityReturn = -1
		returnID = ""
		returnScope = ""
		returnAlways = false
	}
	if classifier >= 0 && unityReturn >= 0 &&
		returnID != "" && classifierScope == returnScope {
		classifierTyped = typedClassifierInputs(steps[classifier].node, returnID)
		if returnActionCount > 0 {
			classifierTyped = typedClassifierInputsWithDigest(steps[classifier].node, returnID)
		}
	}
	if release >= 0 && classifier >= 0 && classifierID != "" && firstAcquire >= 0 &&
		steps[release].scope == classifierScope {
		releaseTyped = typedReleaseInputs(
			steps[release].node,
			classifierID,
			steps[firstAcquire].node,
			returnActionCount > 0,
		)
	}
	if gate >= 0 && acquireID != "" && classifierID != "" && releaseID != "" &&
		steps[gate].scope == acquireScope && steps[gate].scope == classifierScope &&
		steps[gate].scope == steps[release].scope {
		gateTyped = typedGateInputs(steps[gate].node, acquireID, classifierID, releaseID)
	}
	if returnActionCount > 0 &&
		(unityReturn < 0 ||
			classifier != unityReturn+1 ||
			release != classifier+1 ||
			gate != release+1 ||
			gate != len(steps)-1) {
		a.analyzer.add("unsafe-central-return-suffix", workflowPath, jobName)
	}
	if firstAcquire < 0 {
		a.analyzer.add("missing-lock-acquire", workflowPath, jobName)
	}
	if firstActivation >= 0 && (firstAcquire < 0 || firstAcquire >= firstActivation) {
		a.analyzer.add("acquire-after-activation", workflowPath, jobName)
	}
	if unityReturn < 0 || returnID == "" || unityReturn <= lastActivation {
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
		if unityReturn >= 0 && classifier <= unityReturn {
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
	if !a.hasAggregate(workflow, workflowPath, jobs, jobName, job, preflightJobs) {
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
	}
	return result, nil
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
		if (!affirmativeCondition(mappingValue(job, "if")) &&
			!trustedRevisionGuard(mappingValue(job, "if"))) ||
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

func exactLockActionReference(uses, action string) bool {
	ref := actionRef(uses)
	return ref != "" && uses == lockActionPrefix+action+"@"+ref
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

func cleanupStepAfterAcquire(step flattenedUnityStep, acquireID string) bool {
	if acquireID == "" ||
		step.scope != "job" ||
		len(step.enclosingConditions) != 0 ||
		len(step.enclosingSteps) != 0 ||
		!criticalStepFailurePropagates(step) {
		return false
	}
	condition := mappingValue(step.node, "if")
	if condition == nil || condition.Kind != yaml.ScalarNode {
		return false
	}
	value := strings.Join(strings.Fields(condition.Value), "")
	return value == "${{always()&&steps."+acquireID+".outputs.acquired=='true'}}"
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

func typedReleaseInputs(
	step *yaml.Node,
	classifierID string,
	acquire *yaml.Node,
	requireAcquireIdentity bool,
) bool {
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
	if !requireAcquireIdentity {
		return true
	}
	acquireWith := mappingValue(acquire, "with")
	if acquireWith == nil || acquireWith.Kind != yaml.MappingNode {
		return false
	}
	return scalarValue(mappingValue(with, "lock-name")) == "wallstop-organization-builds" &&
		scalarValue(mappingValue(acquireWith, "lock-name")) == "wallstop-organization-builds" &&
		scalarValue(mappingValue(with, "holder-id-suffix")) != "" &&
		scalarValue(mappingValue(with, "holder-id-suffix")) ==
			scalarValue(mappingValue(acquireWith, "holder-id-suffix")) &&
		exactExpression(mappingValue(with, "runner-id"), "runner.name") &&
		exactExpression(mappingValue(acquireWith, "runner-id"), "runner.name") &&
		matchingOptionalInput(with, acquireWith, "lock-repository",
			"Ambiguous-Interactive/ambiguous-organization-build-lock") &&
		matchingOptionalInput(with, acquireWith, "state-branch", "lock-state")
}

func matchingOptionalInput(first, second *yaml.Node, input, defaultValue string) bool {
	firstValue := mappingValue(first, input)
	secondValue := mappingValue(second, input)
	if firstValue == nil && secondValue == nil {
		return true
	}
	firstText := defaultValue
	if firstValue != nil {
		firstText = scalarValue(firstValue)
	}
	secondText := defaultValue
	if secondValue != nil {
		secondText = scalarValue(secondValue)
	}
	return firstText == defaultValue && secondText == defaultValue
}

func typedClassifierInputsWithDigest(step *yaml.Node, returnID string) bool {
	return typedClassifierInputs(step, returnID) &&
		exactStepOutput(
			mappingValue(mappingValue(step, "with"), "return-log-digest"),
			returnID,
			"return-log-digest",
		)
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

func typedReturnInputs(
	step, job *yaml.Node,
	steps []flattenedUnityStep,
	acquireIndex, returnIndex int,
) bool {
	if stepID(step) == "" ||
		!trustedLeafExecution(step) {
		return false
	}
	with := mappingValue(step, "with")
	if !mappingHasOnlyKeys(with, map[string]bool{
		"unity-version":   true,
		"tool-cache":      true,
		"unity-email":     true,
		"unity-password":  true,
		"evidence-suffix": true,
		"editor-layout":   true,
	}) ||
		!exactExpression(mappingValue(with, "tool-cache"), "runner.tool_cache") ||
		!exactExpression(mappingValue(with, "unity-email"), "secrets.UNITY_EMAIL") ||
		!exactExpression(mappingValue(with, "unity-password"), "secrets.UNITY_PASSWORD") {
		return false
	}
	layout := mappingValue(with, "editor-layout")
	if layout != nil &&
		(layout.Kind != yaml.ScalarNode ||
			(scalarValue(layout) != "canonical" &&
				scalarValue(layout) != "ci-managed-alternate")) {
		return false
	}
	version := scalarValue(mappingValue(with, "unity-version"))
	if !validUnityVersion(version) &&
		(!exactExpression(mappingValue(with, "unity-version"), "matrix.unity-version") ||
			!staticUnityVersionMatrix(job, steps, acquireIndex, returnIndex)) {
		return false
	}
	suffix := mappingValue(with, "evidence-suffix")
	return suffix == nil || literalEvidenceSuffix(scalarValue(suffix))
}

func staticUnityVersionMatrix(
	job *yaml.Node,
	steps []flattenedUnityStep,
	acquireIndex, returnIndex int,
) bool {
	strategy := mappingValue(job, "strategy")
	matrix := mappingValue(strategy, "matrix")
	if matrix == nil || matrix.Kind != yaml.MappingNode ||
		mappingValue(matrix, "include") != nil ||
		mappingValue(matrix, "exclude") != nil ||
		acquireIndex < 0 || acquireIndex >= len(steps) ||
		returnIndex <= acquireIndex || returnIndex > len(steps) {
		return false
	}
	acquireWith := mappingValue(steps[acquireIndex].node, "with")
	suffix := scalarValue(mappingValue(acquireWith, "holder-id-suffix"))
	if suffix == "" || strings.ContainsAny(suffix, "\r\n") {
		return false
	}
	foundVersionAxis := false
	axes := make([][]string, 0, len(matrix.Content)/2)
	keys := make([]string, 0, len(matrix.Content)/2)
	cellCount := 1
	for index := 0; index < len(matrix.Content); index += 2 {
		key := scalarValue(matrix.Content[index])
		values := matrix.Content[index+1]
		if matrix.Content[index].Kind != yaml.ScalarNode || key == "" ||
			values.Kind != yaml.SequenceNode || len(values.Content) == 0 ||
			!strings.Contains(suffix, "${{ matrix."+key+" }}") {
			return false
		}
		seen := make(map[string]bool, len(values.Content))
		axis := make([]string, 0, len(values.Content))
		for _, valueNode := range values.Content {
			value := scalarValue(valueNode)
			identity := strings.ToLower(value)
			if valueNode.Kind != yaml.ScalarNode || value == "" ||
				strings.Contains(value, "${{") || strings.ContainsAny(value, "\r\n") ||
				seen[identity] {
				return false
			}
			if key == "unity-version" && !validUnityVersion(value) {
				return false
			}
			seen[identity] = true
			axis = append(axis, value)
		}
		if cellCount > 256/len(axis) {
			return false
		}
		cellCount *= len(axis)
		keys = append(keys, key)
		axes = append(axes, axis)
		foundVersionAxis = foundVersionAxis || key == "unity-version"
	}
	if !foundVersionAxis {
		return false
	}

	identities := make(map[string]bool, cellCount)
	var render func(int, string) bool
	render = func(axisIndex int, rendered string) bool {
		if axisIndex == len(axes) {
			identity := strings.ToLower(rendered)
			if !literalHolderSuffix(rendered) || identities[identity] {
				return false
			}
			identities[identity] = true
			return true
		}
		token := "${{ matrix." + keys[axisIndex] + " }}"
		for _, value := range axes[axisIndex] {
			if !render(axisIndex+1, strings.ReplaceAll(rendered, token, value)) {
				return false
			}
		}
		return true
	}
	return render(0, suffix)
}

func trustedLeafExecution(step *yaml.Node) bool {
	return mappingValue(step, "env") == nil &&
		mappingValue(step, "run") == nil &&
		mappingValue(step, "shell") == nil &&
		mappingValue(step, "working-directory") == nil
}

func validUnityVersion(value string) bool {
	parts := strings.Split(value, ".")
	if len(parts) != 3 || len(parts[0]) != 4 {
		return false
	}
	for _, character := range parts[0] + parts[1] {
		if character < '0' || character > '9' {
			return false
		}
	}
	patch := parts[2]
	marker := strings.IndexAny(strings.ToLower(patch), "abfp")
	if marker <= 0 || marker == len(patch)-1 {
		return false
	}
	for _, character := range patch[:marker] + patch[marker+1:] {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}

func literalEvidenceSuffix(value string) bool {
	if value == "" || len(value) > 64 {
		return false
	}
	for index, character := range value {
		if (character >= 'A' && character <= 'Z') ||
			(character >= 'a' && character <= 'z') ||
			(character >= '0' && character <= '9') ||
			(index > 0 && (character == '.' || character == '_' || character == '-')) {
			continue
		}
		return false
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

func (a *unityPolicyAnalyzer) hasAggregate(
	workflow *yaml.Node,
	workflowPath string,
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
					(aggregateStepEnforces(step, licensedJob, preflight) ||
						trustedSkipAggregateEnforces(
							workflow,
							job,
							step,
							licensedJob,
							preflight,
						) ||
						a.typedValidationGateEnforces(
							workflow,
							jobs,
							job,
							step,
							licensedJob,
							preflight,
							"",
							workflowPath,
						)) {
					return true
				}
			}
		}
	}
	return false
}

func (a *unityPolicyAnalyzer) hasFallbackAggregate(
	workflow *yaml.Node,
	workflowPath string,
	jobs *yaml.Node,
	fallbackJob, sourceJob string,
) bool {
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
			if a.typedValidationGateEnforces(
				workflow,
				jobs,
				job,
				step,
				sourceJob,
				"",
				fallbackJob,
				workflowPath,
			) {
				return true
			}
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

type validationGateReferences struct {
	classifier string
	preflight  string
	unity      string
	fallback   string
}

func (a *unityPolicyAnalyzer) typedValidationGateEnforces(
	workflow *yaml.Node,
	jobs, aggregateJob, step *yaml.Node,
	licensedJob, preflightJob, fallbackJob string,
	workflowPath string,
) bool {
	unsafeFailFast, matrixErr := unsafeMatrixFailFast(aggregateJob)
	steps := sequenceValues(mappingValue(aggregateJob, "steps"))
	uses := stepUses(step)
	if len(steps) != 1 ||
		steps[0] != step ||
		lockActionName(uses) != validationGateAction ||
		!a.approved[strings.ToLower(actionRef(uses))] ||
		!affirmativeCondition(mappingValue(step, "if")) ||
		!criticalStepFailurePropagates(flattenedUnityStep{node: step}) ||
		scalarValue(mappingValue(aggregateJob, "runs-on")) != "ubuntu-latest" ||
		!validationJobIsolationSafe(workflow, aggregateJob) ||
		mappingValue(aggregateJob, "environment") != nil ||
		mappingValue(step, "env") != nil ||
		unsafeConcurrency(mappingValue(aggregateJob, "concurrency")) ||
		matrixErr != nil ||
		unsafeFailFast {
		return false
	}
	with := mappingValue(step, "with")
	if with == nil || with.Kind != yaml.MappingNode ||
		!mappingHasOnlyKeys(with, map[string]bool{
			"classifier-result":       true,
			"unity-required":          true,
			"trusted-revision":        true,
			"preflight-result":        true,
			"unity-result":            true,
			"fallback-result":         true,
			"fallback-cleanup-result": true,
		}) ||
		!trustedRevisionExpression(mappingValue(with, "trusted-revision")) {
		return false
	}
	references := validationGateReferences{
		classifier: needsResultReference(mappingValue(with, "classifier-result")),
		preflight:  needsResultReference(mappingValue(with, "preflight-result")),
		unity:      needsResultReference(mappingValue(with, "unity-result")),
		fallback:   needsResultReference(mappingValue(with, "fallback-result")),
	}
	if references.classifier == "" ||
		references.preflight == "" ||
		references.unity != licensedJob ||
		references.fallback == "" ||
		(preflightJob != "" && references.preflight != preflightJob) ||
		(fallbackJob != "" && references.fallback != fallbackJob) ||
		needsOutputReference(mappingValue(with, "unity-required"), "unity-required") != references.classifier ||
		needsOutputReference(
			mappingValue(with, "fallback-cleanup-result"),
			"cleanup-result",
		) != references.fallback {
		return false
	}
	distinctReferences := map[string]bool{
		references.classifier: true,
		references.preflight:  true,
		references.unity:      true,
		references.fallback:   true,
	}
	if len(distinctReferences) != 4 ||
		!a.validationClassifierMatches(workflow, jobs, references.classifier) ||
		!a.validationPreflightMatches(workflow, jobs, references.preflight) ||
		!validationJobIsolationSafe(workflow, mappingValue(jobs, references.unity)) ||
		!a.validationLockActionEnvironmentsSafe(mappingValue(jobs, references.unity)) {
		return false
	}
	for _, reference := range []string{
		references.classifier,
		references.preflight,
		references.unity,
		references.fallback,
	} {
		if mappingValue(jobs, reference) == nil ||
			!needsAny(aggregateJob, map[string]bool{reference: true}) {
			return false
		}
	}
	if !a.validationFallbackMatches(
		workflow,
		workflowPath,
		jobs,
		references.fallback,
		licensedJob,
	) {
		return false
	}
	return true
}

func (a *unityPolicyAnalyzer) validationClassifierMatches(
	workflow *yaml.Node,
	jobs *yaml.Node,
	classifierJob string,
) bool {
	job := mappingValue(jobs, classifierJob)
	if job == nil {
		return false
	}
	unsafeFailFast, matrixErr := unsafeMatrixFailFast(job)
	if scalarValue(mappingValue(job, "runs-on")) != "ubuntu-latest" ||
		!validationJobIsolationSafe(workflow, job) ||
		mappingValue(job, "if") != nil ||
		mappingValue(job, "needs") != nil ||
		mappingValue(job, "environment") != nil ||
		unsafeConcurrency(mappingValue(job, "concurrency")) ||
		!criticalNodeFailurePropagates(job) ||
		matrixErr != nil ||
		unsafeFailFast {
		return false
	}
	steps := sequenceValues(mappingValue(job, "steps"))
	if len(steps) != 2 {
		return false
	}
	checkout, classify := steps[0], steps[1]
	checkoutUses := stepUses(checkout)
	checkoutWith := mappingValue(checkout, "with")
	if checkoutUses != classifierCheckoutRef ||
		mappingValue(checkout, "if") != nil ||
		mappingValue(checkout, "env") != nil ||
		!criticalNodeFailurePropagates(checkout) ||
		checkoutWith == nil ||
		!mappingHasOnlyKeys(checkoutWith, map[string]bool{
			"fetch-depth":         true,
			"persist-credentials": true,
		}) ||
		scalarValue(mappingValue(checkoutWith, "fetch-depth")) != "0" ||
		scalarValue(mappingValue(checkoutWith, "persist-credentials")) != "false" {
		return false
	}
	classifyUses := stepUses(classify)
	classifyWith := mappingValue(classify, "with")
	classifyID := stepID(classify)
	if classifyID == "" ||
		lockActionName(classifyUses) != changeClassifierAction ||
		!a.approved[strings.ToLower(actionRef(classifyUses))] ||
		mappingValue(classify, "if") != nil ||
		mappingValue(classify, "env") != nil ||
		!criticalNodeFailurePropagates(classify) ||
		classifyWith == nil ||
		!mappingHasOnlyKeys(classifyWith, map[string]bool{
			"event-name": true,
			"base-sha":   true,
			"head-sha":   true,
		}) ||
		!exactExpression(mappingValue(classifyWith, "event-name"), "github.event_name") ||
		!exactExpression(
			mappingValue(classifyWith, "base-sha"),
			"github.event.pull_request.base.sha",
		) ||
		!exactExpression(
			mappingValue(classifyWith, "head-sha"),
			"github.event.pull_request.head.sha",
		) {
		return false
	}
	outputs := mappingValue(job, "outputs")
	return outputs != nil &&
		mappingHasOnlyKeys(outputs, map[string]bool{"unity-required": true}) &&
		exactStepOutput(
			mappingValue(outputs, "unity-required"),
			classifyID,
			"unity-required",
		)
}

func (a *unityPolicyAnalyzer) validationPreflightMatches(
	workflow, jobs *yaml.Node,
	preflightJob string,
) bool {
	job := mappingValue(jobs, preflightJob)
	if job == nil {
		return false
	}
	unsafeFailFast, matrixErr := unsafeMatrixFailFast(job)
	if scalarValue(mappingValue(job, "runs-on")) != "ubuntu-latest" ||
		!validationJobIsolationSafe(workflow, job) ||
		!trustedRevisionGuard(mappingValue(job, "if")) ||
		mappingValue(job, "needs") != nil ||
		mappingValue(job, "environment") != nil ||
		unsafeConcurrency(mappingValue(job, "concurrency")) ||
		!criticalNodeFailurePropagates(job) ||
		matrixErr != nil ||
		unsafeFailFast {
		return false
	}
	steps := sequenceValues(mappingValue(job, "steps"))
	if len(steps) != 1 {
		return false
	}
	step := steps[0]
	uses := stepUses(step)
	return lockActionName(uses) == preflightAction &&
		a.approved[strings.ToLower(actionRef(uses))] &&
		mappingValue(step, "if") == nil &&
		mappingValue(step, "env") == nil &&
		criticalNodeFailurePropagates(step)
}

func validationJobIsolationSafe(workflow, job *yaml.Node) bool {
	if workflow == nil || job == nil {
		return false
	}
	for _, key := range []string{"env", "defaults"} {
		if mappingValue(workflow, key) != nil {
			return false
		}
	}
	for _, key := range []string{"env", "defaults", "container", "services"} {
		if mappingValue(job, key) != nil {
			return false
		}
	}
	if mappingValue(mappingValue(job, "strategy"), "matrix") != nil {
		return false
	}
	return true
}

func centralReturnExecutionIsolated(workflow, job *yaml.Node) bool {
	if workflow == nil || job == nil {
		return false
	}
	for _, key := range []string{"env", "defaults"} {
		if mappingValue(workflow, key) != nil {
			return false
		}
	}
	for _, key := range []string{"env", "defaults", "container", "services"} {
		if mappingValue(job, key) != nil {
			return false
		}
	}
	return true
}

func windowsSelfHostedJob(job *yaml.Node) bool {
	runsOn := mappingValue(job, "runs-on")
	if runsOn == nil || runsOn.Kind != yaml.SequenceNode {
		return false
	}
	selfHosted, windows := false, false
	for _, label := range runsOn.Content {
		if label.Kind != yaml.ScalarNode {
			return false
		}
		switch strings.ToLower(label.Value) {
		case "self-hosted":
			selfHosted = true
		case "windows":
			windows = true
		}
	}
	return selfHosted && windows
}

func (a *unityPolicyAnalyzer) validationLockActionEnvironmentsSafe(job *yaml.Node) bool {
	if job == nil {
		return false
	}
	steps, err := a.flattenedSteps(
		sequenceValues(mappingValue(job, "steps")),
		make(map[string]bool),
		"validation",
		nil,
		nil,
	)
	if err != nil {
		return false
	}
	for _, step := range steps {
		if lockActionName(stepUses(step.node)) == "" {
			continue
		}
		for _, enclosing := range step.enclosingSteps {
			if mappingValue(enclosing, "env") != nil {
				return false
			}
		}
		env := mappingValue(step.node, "env")
		if env == nil {
			continue
		}
		if env.Kind != yaml.MappingNode ||
			len(env.Content) != 4 ||
			!mappingHasOnlyKeys(env, map[string]bool{
				"BUILD_LOCK_APP_ID":          true,
				"BUILD_LOCK_APP_PRIVATE_KEY": true,
			}) ||
			!exactExpression(
				mappingValue(env, "BUILD_LOCK_APP_ID"),
				"secrets.BUILD_LOCK_APP_ID",
			) ||
			!exactExpression(
				mappingValue(env, "BUILD_LOCK_APP_PRIVATE_KEY"),
				"secrets.BUILD_LOCK_APP_PRIVATE_KEY",
			) {
			return false
		}
	}
	return true
}

func (a *unityPolicyAnalyzer) validationFallbackMatches(
	workflow *yaml.Node,
	workflowPath string,
	jobs *yaml.Node,
	fallbackJob, sourceJob string,
) bool {
	job := mappingValue(jobs, fallbackJob)
	if job == nil ||
		scalarValue(mappingValue(job, "runs-on")) != "ubuntu-latest" ||
		!validationJobIsolationSafe(workflow, job) ||
		!needsAny(job, map[string]bool{sourceJob: true}) ||
		!fallbackConditionCoversSource(mappingValue(job, "if"), sourceJob) ||
		!criticalNodeFailurePropagates(job) {
		return false
	}
	steps := sequenceValues(mappingValue(job, "steps"))
	if len(steps) != 1 ||
		lockActionName(stepUses(steps[0])) != releaseAction ||
		stepID(steps[0]) == "" ||
		!a.approved[strings.ToLower(actionRef(stepUses(steps[0])))] ||
		!conditionIsSafeAlways(mappingValue(steps[0], "if")) ||
		!criticalNodeFailurePropagates(steps[0]) {
		return false
	}
	outputs := mappingValue(job, "outputs")
	if outputs == nil || outputs.Kind != yaml.MappingNode ||
		!exactStepOutput(
			mappingValue(outputs, "cleanup-result"),
			stepID(steps[0]),
			"cleanup-result",
		) {
		return false
	}
	referencedSource, suffix, typed := fallbackReleaseSource(steps[0], job)
	return typed &&
		referencedSource == sourceJob &&
		a.sourceAcquireMatches(workflowPath, sourceJob, suffix)
}

func needsResultReference(value *yaml.Node) string {
	return needsReference(value, ".result")
}

func needsOutputReference(value *yaml.Node, output string) string {
	return needsReference(value, ".outputs."+output)
}

func needsReference(value *yaml.Node, suffix string) string {
	if value == nil || value.Kind != yaml.ScalarNode {
		return ""
	}
	expression := strings.Join(strings.Fields(value.Value), "")
	expression = strings.TrimPrefix(expression, "${{")
	expression = strings.TrimSuffix(expression, "}}")
	const prefix = "needs."
	if !strings.HasPrefix(expression, prefix) || !strings.HasSuffix(expression, suffix) {
		return ""
	}
	job := strings.TrimSuffix(strings.TrimPrefix(expression, prefix), suffix)
	if job == "" || strings.ContainsAny(job, " \t\r\n{}$\"'") {
		return ""
	}
	return job
}

func exactExpression(value *yaml.Node, expression string) bool {
	return value != nil &&
		value.Kind == yaml.ScalarNode &&
		strings.Join(strings.Fields(value.Value), "") == "${{"+expression+"}}"
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

func trustedSkipAggregateEnforces(
	workflow, job, step *yaml.Node,
	licensedJob, preflightJob string,
) bool {
	steps := sequenceValues(mappingValue(job, "steps"))
	if len(steps) != 1 || steps[0] != step ||
		scalarValue(mappingValue(job, "runs-on")) != "ubuntu-latest" ||
		!validationJobIsolationSafe(workflow, job) ||
		mappingValue(job, "environment") != nil ||
		unsafeConcurrency(mappingValue(job, "concurrency")) ||
		!affirmativeCondition(mappingValue(step, "if")) ||
		!criticalNodeFailurePropagates(step) ||
		scalarValue(mappingValue(step, "shell")) != "bash" {
		return false
	}
	env := mappingValue(step, "env")
	if !mappingHasOnlyKeys(env, map[string]bool{
		"RUNNER_PREFLIGHT_RESULT": true,
		"UNITY_TESTS_RESULT":      true,
		"FORK_PR":                 true,
		"DEPENDABOT_PR":           true,
	}) ||
		!exactExpression(
			mappingValue(env, "RUNNER_PREFLIGHT_RESULT"),
			"needs."+preflightJob+".result",
		) ||
		!exactExpression(
			mappingValue(env, "UNITY_TESTS_RESULT"),
			"needs."+licensedJob+".result",
		) ||
		!exactExpression(
			mappingValue(env, "FORK_PR"),
			"github.event_name=='pull_request'&&"+
				"github.event.pull_request.head.repo.full_name!=github.repository",
		) ||
		!exactExpression(
			mappingValue(env, "DEPENDABOT_PR"),
			"github.event_name=='pull_request'&&"+
				"github.event.pull_request.user.login=='dependabot[bot]'",
		) {
		return false
	}
	run := mappingValue(step, "run")
	if run == nil || run.Kind != yaml.ScalarNode {
		return false
	}
	lines := make([]string, 0, 8)
	for _, line := range strings.Split(run.Value, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			lines = append(lines, line)
		}
	}
	expected := []string{
		"set -euo pipefail",
		`if [ "${FORK_PR}" = "true" ] || [ "${DEPENDABOT_PR}" = "true" ]; then`,
		`test "${RUNNER_PREFLIGHT_RESULT}" = skipped`,
		`test "${UNITY_TESTS_RESULT}" = skipped`,
		"else",
		`test "${RUNNER_PREFLIGHT_RESULT}" = success`,
		`test "${UNITY_TESTS_RESULT}" = success`,
		"fi",
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
	dependabotGuards := []string{
		"github.event.pull_request.user.login!='dependabot[bot]'",
	}
	for _, dependabotGuard := range dependabotGuards {
		if value == eventGuard+"("+dependabotGuard+"&&"+direct+")" ||
			value == eventGuard+"("+dependabotGuard+"&&"+reverse+")" {
			return true
		}
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
		for _, dependabotGuard := range dependabotGuards {
			if conjunct == eventGuard+"("+dependabotGuard+"&&"+direct+")" ||
				conjunct == eventGuard+"("+dependabotGuard+"&&"+reverse+")" {
				return true
			}
		}
	}
	return false
}

func trustedRevisionGuard(condition *yaml.Node) bool {
	return trustedRevisionExpression(condition)
}

func trustedRevisionExpression(value *yaml.Node) bool {
	if value == nil || value.Kind != yaml.ScalarNode {
		return false
	}
	expression := strings.ToLower(strings.Join(strings.Fields(value.Value), ""))
	expression = strings.TrimPrefix(expression, "${{")
	expression = strings.TrimSuffix(expression, "}}")
	direct := "(github.event_name!='pull_request'||github.event.pull_request.head.repo.full_name==github.repository)"
	reverse := "(github.event_name!='pull_request'||github.repository==github.event.pull_request.head.repo.full_name)"
	for _, dependabotGuard := range []string{
		"github.event.pull_request.user.login!='dependabot[bot]'",
	} {
		scopedDirect := "github.event_name!='pull_request'||(" + dependabotGuard +
			"&&github.event.pull_request.head.repo.full_name==github.repository)"
		scopedReverse := "github.event_name!='pull_request'||(" + dependabotGuard +
			"&&github.repository==github.event.pull_request.head.repo.full_name)"
		if expression == scopedDirect || expression == scopedReverse {
			return true
		}
		for _, repositoryGuard := range []string{direct, reverse} {
			if expression == dependabotGuard+"&&"+repositoryGuard ||
				expression == repositoryGuard+"&&"+dependabotGuard {
				return true
			}
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
			"github.event.pull_request.user.login!='dependabot[bot]'":
		default:
			direct := "github.event.pull_request.head.repo.full_name==github.repository"
			reverse := "github.repository==github.event.pull_request.head.repo.full_name"
			eventGuard := "github.event_name!='pull_request'||"
			scoped := false
			for _, dependabotGuard := range []string{
				"github.event.pull_request.user.login!='dependabot[bot]'",
			} {
				if conjunct == eventGuard+"("+dependabotGuard+"&&"+direct+")" ||
					conjunct == eventGuard+"("+dependabotGuard+"&&"+reverse+")" {
					scoped = true
					break
				}
			}
			if conjunct != eventGuard+direct && conjunct != eventGuard+reverse && !scoped {
				return false
			}
		}
	}
	return foundAlways
}
