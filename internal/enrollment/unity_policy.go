package enrollment

import (
	"fmt"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"go.yaml.in/yaml/v4"
)

const (
	changeClassifierAction  = "classify-unity-changes"
	classifierCheckoutRef   = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
	cleanupClassifierAction = "classify-unity-cleanup-evidence"
	cleanupGateAction       = "require-confirmed-unity-cleanup"
	currentHeadAction       = "require-current-pr-head"
	preflightAction         = "check-unity-runner-availability"
	releaseAction           = "release-build-lock"
	returnAction            = "return-unity-license"
	trustedEditorCheckout   = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
	trustedEditorPath       = ".ci/unity-helpers/scripts/unity/ensure-editor.ps1"
	trustedEditorRepository = "Ambiguous-Interactive/unity-helpers"
	trustedEditorRevision   = "76712db791093a9c6b2eccdd9c7bd1b4f1cdb24d"
	trustedEditorRoot       = ".ci/unity-helpers"
	validationGateAction    = "require-unity-validation"
	validationLicenseAction = "validate-unity-license"

	UnityInventoryPaidSerial         = "paid-serial"
	UnityInventoryFallbackCleanup    = "fallback-cleanup"
	UnityInventoryControlledCanary   = "controlled-canary"
	UnityInventorySynthetic          = "synthetic"
	UnityInventoryDisabled           = "disabled"
	UnityInventoryNonLicensingStatic = "non-licensing-static"
)

const trustedEditorBootstrapRun = `$workspace = [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE).TrimEnd('\', '/')
$parent = [IO.Path]::GetFullPath((Join-Path $workspace '.ci'))
$target = [IO.Path]::GetFullPath((Join-Path $parent 'unity-helpers'))
if (-not $target.StartsWith("$workspace\", [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Validator checkout path escaped the workspace.'
}
if (Test-Path -LiteralPath $parent) {
  $parentItem = Get-Item -LiteralPath $parent -Force
  if (($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Validator checkout parent is a reparse point.'
  }
}
if (Test-Path -LiteralPath $target) {
  $targetItem = Get-Item -LiteralPath $target -Force
  if (($targetItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    $targetItem.Delete()
  } else {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
}
if (Test-Path -LiteralPath $target) {
  throw 'Validator checkout directory could not be removed.'
}`

const (
	trustedEditorBootstrapShell = `pwsh -NoProfile -Command ". '{0}'"`
	trustedEditorGatePrefix     = `& "$env:GITHUB_WORKSPACE/.ci/unity-helpers/scripts/unity/ensure-editor.ps1" -UnityVersion '`
	trustedEditorGateMiddle     = `' -InstallRoot "$env:RUNNER_TOOL_CACHE\u6-v3" -ProvisioningProfile `
	trustedEditorGateSuffix     = ` -DiagnosticsPath unity-editor-check.json -CiManagedOnly -RequireHealthyExisting`
	trustedEditorMatrixProfile  = `${{ fromJSON('{"editmode":"EditorOnly","playmode":"EditorOnly","standalone":"StandaloneWindowsIl2Cpp"}')[matrix.test-mode] }}`
	trustedEditorShell          = `pwsh -NoProfile -NonInteractive -Command ". '{0}'"`
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
	a.auditUnityEditorCheck(workflowPath, jobName, workflow, job, steps)
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
				if acquireCount == 1 &&
					jobFailurePropagates &&
					successDependentStepRunnable(step) {
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

const maxUnityEditorCheckTimeoutMinutes = 10

var unityEditorProvisioningControls = []string{
	"uh_ensure_editor_provisioning_budget_seconds",
	"uh_ensure_editor_install_timeout_seconds",
}

func (a *unityPolicyAnalyzer) auditUnityEditorCheck(
	workflowPath, jobName string,
	workflow, job *yaml.Node,
	steps []flattenedUnityStep,
) {
	credentialsAvailableBeforeSteps := containsUnityCredentialReference(strings.ToLower(
		nodeScalarText(mappingValue(workflow, "env")) +
			nodeScalarText(mappingValue(job, "env")),
	))
	jobText := strings.ToLower(
		nodeScalarText(mappingValue(workflow, "env")) +
			nodeScalarText(mappingValue(job, "env")),
	)
	workflowRunDefaults := mappingValue(mappingValue(workflow, "defaults"), "run")
	jobRunDefaults := mappingValue(mappingValue(job, "defaults"), "run")
	for _, control := range unityEditorProvisioningControls {
		if strings.Contains(jobText, control) {
			a.analyzer.add("unity-editor-provisioning-control", workflowPath, jobName)
		}
	}

	gateIndex := -1
	acquireIndex := -1
	credentialIndex := -1
	for index, step := range steps {
		if acquire, _ := acquireReference(stepUses(step.node)); acquire && acquireIndex < 0 {
			acquireIndex = index
		}
		stepText := nodeScalarText(step.node)
		for _, enclosing := range step.enclosingSteps {
			stepText += nodeScalarText(enclosing)
		}
		if credentialIndex < 0 && unityStepContainsCredential(step) {
			credentialIndex = index
		}
		for _, control := range unityEditorProvisioningControls {
			if strings.Contains(strings.ToLower(stepText), control) {
				a.analyzer.add("unity-editor-provisioning-control", workflowPath, jobName)
			}
		}

		run := scalarValue(mappingValue(step.node, "run"))
		if run == "" {
			continue
		}
		workingDirectory := mappingValue(step.node, "working-directory") != nil ||
			mappingValue(workflowRunDefaults, "working-directory") != nil ||
			mappingValue(jobRunDefaults, "working-directory") != nil
		direct := auditEnsureEditorSource(run)
		// A checked-in wrapper can hide the actual invocation behind arbitrary
		// PowerShell control flow. Audit every statically reachable wrapper for
		// prohibited provisioning, but require the mandatory gate to be a
		// direct workflow invocation whose execution conditions are visible in
		// the workflow AST.
		candidate := direct.topLevel &&
			a.trustedEditorGate(run, workflow, job, steps, index) &&
			step.scope == "job" &&
			len(step.enclosingSteps) == 0
		delegated := editorSourceAudit{}
		if !candidate {
			delegated = a.delegatedEditorAudit(run)
		}
		unresolved := hasUnresolvedPowerShellEditorInvocation(run)
		if step.scope == "job" {
			unresolved = hasUnresolvedPowerShellWorkflowInvocation(run)
		}
		// A working-directory is security-relevant when this run step invokes a
		// repository-relative PowerShell script: the script is resolved from the
		// redirected directory, so auditing only the repository-root spelling can
		// inspect a decoy while the runner executes a different file. It must not
		// make unrelated commands fail, and the exact trusted gate uses an absolute
		// workspace path even when job defaults set a directory.
		workingDirectoryUnsafe := workingDirectory && !candidate &&
			(direct.found || delegated.found || unresolved ||
				hasRepositoryRelativePowerShellScriptInvocation(run))
		if direct.unsafe || delegated.unsafe || unresolved || workingDirectoryUnsafe {
			a.analyzer.add("unsafe-unity-editor-provisioning", workflowPath, jobName)
		}
		if direct.provisioningControl || delegated.provisioningControl {
			a.analyzer.add("unity-editor-provisioning-control", workflowPath, jobName)
		}
		if !candidate || gateIndex >= 0 {
			continue
		}

		if !successDependentStepRunnable(step) {
			a.analyzer.add("unsafe-unity-editor-check", workflowPath, jobName)
			continue
		}
		if !requiredBoundedTimeout(step.node, maxUnityEditorCheckTimeoutMinutes) {
			a.analyzer.add("unbounded-unity-editor-check", workflowPath, jobName)
		}
		if !criticalStepFailurePropagates(step) {
			a.analyzer.add("unsafe-unity-editor-check", workflowPath, jobName)
		}
		gateIndex = index
	}

	if gateIndex < 0 {
		a.analyzer.add("missing-unity-editor-check", workflowPath, jobName)
		return
	}
	if acquireIndex >= 0 && gateIndex >= acquireIndex {
		a.analyzer.add("unity-editor-check-after-lock", workflowPath, jobName)
	}
	if credentialsAvailableBeforeSteps ||
		(credentialIndex >= 0 && gateIndex >= credentialIndex) {
		a.analyzer.add("unity-editor-check-after-credentials", workflowPath, jobName)
	}
}

func (a *unityPolicyAnalyzer) trustedEditorGate(
	run string,
	workflow *yaml.Node,
	job *yaml.Node,
	steps []flattenedUnityStep,
	gateIndex int,
) bool {
	gate := steps[gateIndex]
	// This body is deliberately exact. A merely present trusted-looking
	// invocation could be skipped by a custom shell or preceded by a write
	// that replaces the freshly checked-out validator.
	gateVersion, gateProfile, validGateBody := trustedEditorGateBody(run)
	if !validGateBody ||
		!trustedEditorGateProfile(gateProfile, job) ||
		!trustedEditorGateMatchesReturn(
			gateVersion,
			job,
			steps,
			gateIndex,
		) ||
		scalarValue(mappingValue(gate.node, "shell")) != trustedEditorShell ||
		mappingValue(gate.node, "env") != nil {
		return false
	}
	bootstrapIndex := 0
	switch gateIndex {
	case 2:
	case 3:
		if !a.trustedCurrentHeadGuard(steps[0]) {
			return false
		}
		bootstrapIndex = 1
	default:
		return false
	}
	if !trustedEditorBootstrap(steps[bootstrapIndex]) {
		return false
	}
	// The bootstrap itself is PowerShell running on .NET. Any inherited
	// workflow/job environment would let a consumer preload that runtime (for
	// example with DOTNET_STARTUP_HOOKS or CoreCLR profiler variables) before
	// the exact bootstrap body can enforce provenance. Keep this contract
	// closed: values needed by later steps must be step-local.
	if mappingValue(workflow, "env") != nil || mappingValue(job, "env") != nil {
		return false
	}
	checkout := steps[gateIndex-1]
	if checkout.scope != "job" || len(checkout.enclosingSteps) != 0 ||
		stepUses(checkout.node) != trustedEditorCheckout ||
		!successDependentStepRunnable(checkout) ||
		!safeCheckoutGitEnvironment(checkout.node) {
		return false
	}
	with := mappingValue(checkout.node, "with")
	if with == nil || with.Kind != yaml.MappingNode ||
		len(with.Content) != 12 {
		return false
	}
	allowedCheckoutInputs := map[string]bool{
		"repository":          true,
		"ref":                 true,
		"path":                true,
		"persist-credentials": true,
		"clean":               true,
	}
	allowedCheckoutInputs["set-safe-directory"] = true
	// actions/checkout otherwise attempts a global safe.directory write. Under
	// the intentionally isolated Git configuration that write is both noisy
	// and impossible, so the checkout must explicitly disable that behavior.
	// No expression or additional input is accepted.
	if scalarValue(mappingValue(with, "set-safe-directory")) != "false" {
		return false
	}
	if !mappingHasOnlyKeys(with, allowedCheckoutInputs) {
		return false
	}
	return scalarValue(mappingValue(with, "repository")) == trustedEditorRepository &&
		scalarValue(mappingValue(with, "ref")) == trustedEditorRevision &&
		scalarValue(mappingValue(with, "path")) == trustedEditorRoot &&
		strings.EqualFold(
			scalarValue(mappingValue(with, "persist-credentials")),
			"false",
		) &&
		strings.EqualFold(scalarValue(mappingValue(with, "clean")), "true")
}

func (a *unityPolicyAnalyzer) trustedCurrentHeadGuard(
	step flattenedUnityStep,
) bool {
	if step.scope != "job" ||
		len(step.enclosingSteps) != 0 ||
		!successDependentStepRunnable(step) ||
		!requiredBoundedTimeout(step.node, 2) ||
		!exactLockActionReference(stepUses(step.node), currentHeadAction) ||
		!a.approved[strings.ToLower(actionRef(stepUses(step.node)))] ||
		!trustedLeafExecution(step.node) {
		return false
	}
	with := mappingValue(step.node, "with")
	return mappingHasOnlyKeys(with, map[string]bool{
		"github-token":        true,
		"pull-request-number": true,
		"expected-head-sha":   true,
	}) &&
		exactExpression(mappingValue(with, "github-token"), "github.token") &&
		exactExpression(
			mappingValue(with, "pull-request-number"),
			"github.event.pull_request.number",
		) &&
		exactExpression(
			mappingValue(with, "expected-head-sha"),
			"github.event.pull_request.head.sha",
		)
}

func trustedEditorGateBody(run string) (string, string, bool) {
	body := strings.TrimSpace(run)
	if !strings.HasPrefix(body, trustedEditorGatePrefix) ||
		!strings.HasSuffix(body, trustedEditorGateSuffix) {
		return "", "", false
	}
	remainder := strings.TrimSuffix(
		strings.TrimPrefix(body, trustedEditorGatePrefix),
		trustedEditorGateSuffix,
	)
	middle := strings.Index(remainder, trustedEditorGateMiddle)
	if middle < 0 {
		return "", "", false
	}
	version := remainder[:middle]
	profile := remainder[middle+len(trustedEditorGateMiddle):]
	if profile != "EditorOnly" && profile != trustedEditorMatrixProfile {
		return "", "", false
	}
	if version == "${{ matrix.unity-version }}" {
		return version, profile, true
	}
	if !validUnityVersion(version) {
		return "", "", false
	}
	return version, profile, validUnityEditorRelease(version)
}

func trustedEditorGateCommand(version string) string {
	return trustedEditorGateCommandWithProfile(version, "EditorOnly")
}

func trustedEditorGateCommandWithProfile(version, profile string) string {
	return trustedEditorGatePrefix + version + trustedEditorGateMiddle +
		profile + trustedEditorGateSuffix
}

func trustedEditorGateProfile(profile string, job *yaml.Node) bool {
	strategy := mappingValue(job, "strategy")
	matrix := mappingValue(strategy, "matrix")
	if matrix == nil {
		return profile == "EditorOnly"
	}
	if matrix.Kind != yaml.MappingNode ||
		mappingValue(matrix, "include") != nil ||
		mappingValue(matrix, "exclude") != nil {
		return false
	}
	modes := mappingValue(matrix, "test-mode")
	if modes == nil {
		return profile == "EditorOnly"
	}
	if profile != "EditorOnly" && profile != trustedEditorMatrixProfile {
		return false
	}
	if modes.Kind != yaml.SequenceNode ||
		len(modes.Content) == 0 {
		return false
	}
	seen := make(map[string]bool, len(modes.Content))
	for _, mode := range modes.Content {
		value := scalarValue(mode)
		if mode.Kind != yaml.ScalarNode ||
			(value != "editmode" &&
				value != "playmode" &&
				value != "standalone") ||
			seen[value] {
			return false
		}
		seen[value] = true
	}
	return profile == trustedEditorMatrixProfile || !seen["standalone"]
}

func trustedEditorGateMatchesReturn(
	gateVersion string,
	job *yaml.Node,
	steps []flattenedUnityStep,
	gateIndex int,
) bool {
	acquireIndex := -1
	returnIndex := -1
	var returnVersion *yaml.Node
	for index := gateIndex + 1; index < len(steps); index++ {
		if acquire, _ := acquireReference(stepUses(steps[index].node)); acquire &&
			acquireIndex < 0 {
			acquireIndex = index
		}
		if lockActionName(stepUses(steps[index].node)) == returnAction {
			if returnIndex >= 0 {
				return false
			}
			returnIndex = index
			returnVersion = mappingValue(
				mappingValue(steps[index].node, "with"),
				"unity-version",
			)
		}
	}
	if acquireIndex < 0 || returnIndex <= acquireIndex || returnVersion == nil {
		return false
	}
	if validUnityVersion(gateVersion) {
		return scalarValue(returnVersion) == gateVersion
	}
	return gateVersion == "${{ matrix.unity-version }}" &&
		exactExpression(returnVersion, "matrix.unity-version") &&
		staticUnityVersionMatrix(job, steps, acquireIndex, returnIndex)
}

func trustedEditorBootstrap(step flattenedUnityStep) bool {
	return step.scope == "job" &&
		len(step.enclosingSteps) == 0 &&
		successDependentStepRunnable(step) &&
		requiredBoundedTimeout(step.node, 2) &&
		scalarValue(mappingValue(step.node, "shell")) ==
			trustedEditorBootstrapShell &&
		strings.TrimSpace(scalarValue(mappingValue(step.node, "run"))) ==
			trustedEditorBootstrapRun &&
		mappingValue(step.node, "env") == nil
}

func safeCheckoutGitEnvironment(node *yaml.Node) bool {
	env := mappingValue(node, "env")
	if env == nil || env.Kind != yaml.MappingNode || len(env.Content) != 10 {
		return false
	}
	expected := map[string]string{
		"GIT_CONFIG_COUNT":    "1",
		"GIT_CONFIG_KEY_0":    "core.hooksPath",
		"GIT_CONFIG_VALUE_0":  "/dev/null",
		"GIT_CONFIG_NOSYSTEM": "1",
		"GIT_CONFIG_GLOBAL":   "/dev/null",
	}
	for key, value := range expected {
		if scalarValue(mappingValue(env, key)) != value {
			return false
		}
	}
	return true
}

func unityStepContainsCredential(step flattenedUnityStep) bool {
	if containsUnityCredentialReference(strings.ToLower(nodeScalarText(step.node))) {
		return true
	}
	for _, enclosing := range step.enclosingSteps {
		if containsUnityCredentialReference(strings.ToLower(nodeScalarText(enclosing))) {
			return true
		}
	}
	return false
}

type editorSourceAudit struct {
	found               bool
	topLevel            bool
	unsafe              bool
	provisioningControl bool
}

type powerShellPathReference struct {
	path               string
	start              int
	end                int
	repositoryRelative bool
	scriptRelative     bool
	hazardous          bool
}

func auditEnsureEditorSource(text string) editorSourceAudit {
	clean := stripPowerShellComments(text)
	result := editorSourceAudit{}
	lower := strings.ToLower(clean)
	for _, control := range unityEditorProvisioningControls {
		if strings.Contains(lower, control) {
			result.provisioningControl = true
		}
	}

	for _, command := range powerShellCommands(clean) {
		references := powerShellPathReferences(command)
		for index, reference := range references {
			if !strings.EqualFold(path.Base(reference.path), "ensure-editor.ps1") {
				continue
			}
			invoked := powerShellCommandInvokesReference(command, reference)
			if !invoked {
				if !inertPowerShellReference(command) {
					result.found = true
					result.unsafe = true
				}
				continue
			}
			result.found = true
			end := len(command)
			if index+1 < len(references) {
				end = references[index+1].start
			}
			arguments := strings.TrimLeft(command[reference.end:end], `"'`)
			if !reference.repositoryRelative ||
				!enabledPowerShellSwitch(arguments, "cimanagedonly") ||
				!enabledPowerShellSwitch(arguments, "requirehealthyexisting") {
				result.unsafe = true
			}
		}
	}
	result.topLevel = topLevelEnsureEditorInvocation(clean)
	return result
}

func hasRepositoryRelativePowerShellScriptInvocation(text string) bool {
	for _, command := range powerShellCommands(text) {
		for _, reference := range powerShellPathReferences(command) {
			if reference.repositoryRelative &&
				powerShellCommandInvokesReference(command, reference) {
				return true
			}
		}
	}
	return false
}

func topLevelEnsureEditorInvocation(text string) bool {
	depth := 0
	var prior strings.Builder
	for _, line := range strings.Split(stripPowerShellComments(text), "\n") {
		invocations := make(map[int]powerShellPathReference)
		for _, reference := range powerShellPathReferences(line) {
			if strings.EqualFold(path.Base(reference.path), "ensure-editor.ps1") &&
				powerShellCommandInvokesReference(line, reference) {
				invocations[reference.start] = reference
			}
		}
		inSingleQuote := false
		inDoubleQuote := false
		for index := 0; index < len(line); index++ {
			if reference, invoked := invocations[index]; invoked &&
				depth == 0 &&
				simplePowerShellInvocation(line, reference) &&
				!powerShellContainsFlowTermination(prior.String()) {
				return true
			}
			char := line[index]
			if char == '`' && !inSingleQuote && index+1 < len(line) {
				index++
				continue
			}
			if char == '\'' && !inDoubleQuote {
				if inSingleQuote && index+1 < len(line) && line[index+1] == '\'' {
					index++
					continue
				}
				inSingleQuote = !inSingleQuote
				continue
			}
			if char == '"' && !inSingleQuote {
				inDoubleQuote = !inDoubleQuote
				continue
			}
			if inSingleQuote || inDoubleQuote {
				continue
			}
			switch char {
			case '{':
				depth++
			case '}':
				if depth > 0 {
					depth--
				}
			}
		}
		prior.WriteString(line)
		prior.WriteByte('\n')
	}
	return false
}

func simplePowerShellInvocation(
	command string,
	reference powerShellPathReference,
) bool {
	prefix := strings.TrimSpace(command[:reference.start])
	quotedReference := reference.start > 0 &&
		(command[reference.start-1] == '\'' || command[reference.start-1] == '"')
	prefix = strings.TrimSpace(strings.TrimRight(prefix, `"'`))
	if quotedReference && (prefix == "" || strings.HasSuffix(prefix, "(")) {
		return false
	}
	if prefix == "" || prefix == "&" {
		return true
	}
	assignment := strings.LastIndex(prefix, "=")
	if assignment < 0 || strings.TrimSpace(prefix[assignment+1:]) != "&" {
		return false
	}
	variable := strings.TrimSpace(prefix[:assignment])
	if !strings.HasPrefix(variable, "$") || len(variable) == 1 {
		return false
	}
	for _, char := range variable[1:] {
		if !unicode.IsLetter(char) &&
			!unicode.IsDigit(char) &&
			!strings.ContainsRune("_:-{}", char) {
			return false
		}
	}
	return true
}

func powerShellContainsFlowTermination(text string) bool {
	outside := powerShellUnquotedText(text)
	for _, token := range strings.FieldsFunc(
		strings.ToLower(outside),
		func(char rune) bool {
			return !unicode.IsLetter(char) && !unicode.IsDigit(char) && char != '-'
		},
	) {
		switch token {
		case "break", "continue", "exit", "return":
			return true
		}
	}
	return false
}

func powerShellUnquotedText(text string) string {
	clean := stripPowerShellComments(text)
	var outside strings.Builder
	inSingleQuote := false
	inDoubleQuote := false
	for index := 0; index < len(clean); index++ {
		char := clean[index]
		if char == '`' && !inSingleQuote && index+1 < len(clean) {
			outside.WriteByte(' ')
			index++
			outside.WriteByte(' ')
			continue
		}
		if char == '\'' && !inDoubleQuote {
			if inSingleQuote && index+1 < len(clean) && clean[index+1] == '\'' {
				outside.WriteString("  ")
				index++
				continue
			}
			inSingleQuote = !inSingleQuote
			outside.WriteByte(' ')
			continue
		}
		if char == '"' && !inSingleQuote {
			inDoubleQuote = !inDoubleQuote
			outside.WriteByte(' ')
			continue
		}
		if inSingleQuote || inDoubleQuote {
			outside.WriteByte(' ')
			continue
		}
		outside.WriteByte(char)
	}
	return outside.String()
}

func stripPowerShellComments(text string) string {
	var builder strings.Builder
	text = strings.ReplaceAll(text, "\r\n", "\n")
	inSingleQuote := false
	inDoubleQuote := false
	inBlockComment := false
	for index := 0; index < len(text); index++ {
		char := text[index]
		if inBlockComment {
			if char == '#' && index+1 < len(text) && text[index+1] == '>' {
				inBlockComment = false
				builder.WriteByte(' ')
				index++
			} else if char == '\n' {
				builder.WriteByte('\n')
			}
			continue
		}
		if !inSingleQuote && !inDoubleQuote &&
			char == '<' && index+1 < len(text) && text[index+1] == '#' {
			inBlockComment = true
			builder.WriteByte(' ')
			index++
			continue
		}
		if !inSingleQuote && !inDoubleQuote && char == '#' {
			for index < len(text) && text[index] != '\n' {
				index++
			}
			if index < len(text) {
				builder.WriteByte('\n')
			}
			continue
		}
		if char == '`' && !inSingleQuote && index+1 < len(text) {
			builder.WriteByte(char)
			index++
			builder.WriteByte(text[index])
			continue
		}
		if char == '\'' && !inDoubleQuote {
			if inSingleQuote && index+1 < len(text) && text[index+1] == '\'' {
				builder.WriteString("''")
				index++
				continue
			}
			inSingleQuote = !inSingleQuote
		}
		if char == '"' && !inSingleQuote {
			inDoubleQuote = !inDoubleQuote
		}
		builder.WriteByte(char)
	}
	return builder.String()
}

func powerShellCommands(text string) []string {
	result := make([]string, 0)
	var continued strings.Builder
	for _, line := range strings.Split(stripPowerShellComments(text), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if strings.HasSuffix(trimmed, "`") {
			continued.WriteString(trimmed)
			continued.WriteByte('\n')
			continue
		}
		continued.WriteString(trimmed)
		if !balancedPowerShellQuotes(continued.String()) ||
			!balancedPowerShellParentheses(continued.String()) {
			continued.WriteByte('\n')
			continue
		}
		for _, command := range splitPowerShellCommands(continued.String()) {
			if command = strings.TrimSpace(command); command != "" {
				result = append(result, command)
			}
		}
		continued.Reset()
	}
	if command := strings.TrimSpace(continued.String()); command != "" {
		result = append(result, command)
	}
	return result
}

func balancedPowerShellQuotes(text string) bool {
	inSingleQuote := false
	inDoubleQuote := false
	for index := 0; index < len(text); index++ {
		char := text[index]
		if char == '`' && !inSingleQuote && index+1 < len(text) {
			index++
			continue
		}
		if char == '\'' && !inDoubleQuote {
			if inSingleQuote && index+1 < len(text) && text[index+1] == '\'' {
				index++
				continue
			}
			inSingleQuote = !inSingleQuote
		}
		if char == '"' && !inSingleQuote {
			inDoubleQuote = !inDoubleQuote
		}
	}
	return !inSingleQuote && !inDoubleQuote
}

func balancedPowerShellParentheses(text string) bool {
	depth := 0
	inSingleQuote := false
	inDoubleQuote := false
	for index := 0; index < len(text); index++ {
		char := text[index]
		if char == '`' && !inSingleQuote && index+1 < len(text) {
			index++
			continue
		}
		if char == '\'' && !inDoubleQuote {
			if inSingleQuote && index+1 < len(text) && text[index+1] == '\'' {
				index++
				continue
			}
			inSingleQuote = !inSingleQuote
			continue
		}
		if char == '"' && !inSingleQuote {
			inDoubleQuote = !inDoubleQuote
			continue
		}
		if inSingleQuote || inDoubleQuote {
			continue
		}
		switch char {
		case '(':
			depth++
		case ')':
			if depth == 0 {
				return false
			}
			depth--
		}
	}
	return depth == 0
}

func splitPowerShellCommands(line string) []string {
	result := make([]string, 0)
	start := 0
	inSingleQuote := false
	inDoubleQuote := false
	bracedVariableDepth := 0
	for index := 0; index < len(line); index++ {
		char := line[index]
		if !inSingleQuote && !inDoubleQuote &&
			strings.HasPrefix(line[index:], "${{") {
			if closing := strings.Index(line[index+3:], "}}"); closing >= 0 {
				index += closing + 4
				continue
			}
		}
		if char == '`' && !inSingleQuote && index+1 < len(line) {
			index++
			continue
		}
		if char == '\'' && !inDoubleQuote {
			if inSingleQuote && index+1 < len(line) && line[index+1] == '\'' {
				index++
				continue
			}
			inSingleQuote = !inSingleQuote
			continue
		}
		if char == '"' && !inSingleQuote {
			inDoubleQuote = !inDoubleQuote
			continue
		}
		if inSingleQuote || inDoubleQuote {
			continue
		}
		if char == '{' && index > 0 && line[index-1] == '$' {
			bracedVariableDepth++
			continue
		}
		if char == '}' && bracedVariableDepth > 0 {
			bracedVariableDepth--
			continue
		}
		separatorLength := 0
		switch {
		case char == ';':
			separatorLength = 1
		case char == '|':
			separatorLength = 1
		case char == '}' ||
			(char == '{' && (index == 0 || line[index-1] != '$')):
			separatorLength = 1
		case char == '(' &&
			powerShellHostInvocation(
				powerShellCommandTokens(strings.TrimSpace(line[index+1:])),
			):
			separatorLength = 1
		case index+1 < len(line) &&
			char == '&' && line[index+1] == '&':
			separatorLength = 2
		}
		if separatorLength == 0 {
			continue
		}
		result = append(result, line[start:index])
		index += separatorLength - 1
		start = index + 1
	}
	result = append(result, line[start:])
	return result
}

func (a *unityPolicyAnalyzer) delegatedEditorAudit(run string) editorSourceAudit {
	type scriptNode struct {
		path       string
		source     string
		terminal   bool
		missing    bool
		local      editorSourceAudit
		references []powerShellPathReference
	}

	nodes := make(map[string]*scriptNode)
	roots := make(map[string]bool)
	var collect func(string)
	collect = func(scriptPath string) {
		if _, seen := nodes[scriptPath]; seen {
			return
		}
		node := &scriptNode{path: scriptPath}
		nodes[scriptPath] = node
		content, ok := a.analyzer.snapshot.Files[scriptPath]
		if !ok {
			node.missing = true
			return
		}
		node.source = string(content)
		node.terminal = strings.EqualFold(
			path.Clean(scriptPath),
			"scripts/unity/ensure-editor.ps1",
		)
		node.local = auditEnsureEditorSource(node.source)
		if node.terminal {
			// The terminal helper can retain manual-mode controls. Only controls in
			// its CI caller and reachable wrappers are CI policy.
			node.local.provisioningControl = false
		}
		for _, reference := range invokedPowerShellReferences(node.source) {
			candidate := reference.path
			if reference.scriptRelative {
				candidate = path.Clean(path.Join(path.Dir(scriptPath), candidate))
			}
			reference.path = candidate
			node.references = append(node.references, reference)
			collect(candidate)
		}
	}

	for _, reference := range invokedPowerShellReferences(run) {
		roots[reference.path] = true
		collect(reference.path)
	}

	// Relevance is a graph property, not a DFS return value: shared descendants
	// and cycles must produce the same answer regardless of traversal order.
	relevant := make(map[string]bool)
	for scriptPath, node := range nodes {
		if node.local.found || node.local.provisioningControl {
			relevant[scriptPath] = true
		}
	}
	changed := true
	for changed {
		changed = false
		for scriptPath, node := range nodes {
			if relevant[scriptPath] {
				continue
			}
			for _, reference := range node.references {
				if relevant[reference.path] {
					relevant[scriptPath] = true
					changed = true
					break
				}
			}
		}
	}

	result := editorSourceAudit{}
	for scriptPath, node := range nodes {
		// The terminal helper is the manually maintained implementation invoked by
		// the reviewed CI gate. Its local provisioning controls and self-reference
		// patterns are intentionally outside the caller/wrapper audit boundary.
		if !node.terminal {
			result.merge(node.local)
		}
		if node.missing {
			if roots[scriptPath] {
				result.unsafe = true
			}
			continue
		}
		if !relevant[scriptPath] || node.terminal {
			continue
		}
		if unsupportedDelegatedPowerShellProgram(node.source) ||
			hasUnresolvedPowerShellScriptInvocation(node.source) {
			result.unsafe = true
		}
		for _, reference := range node.references {
			if reference.hazardous || nodes[reference.path].missing {
				result.unsafe = true
			}
		}
	}
	return result
}

func unsupportedDelegatedPowerShellProgram(text string) bool {
	clean := stripPowerShellComments(text)
	if !balancedPowerShellQuotes(clean) || !balancedPowerShellParentheses(clean) ||
		!balancedPowerShellBraces(clean) {
		return true
	}
	stage := 0
	invocations := 0
	for _, command := range powerShellCommands(clean) {
		command = strings.TrimSpace(command)
		lower := strings.ToLower(command)
		if strings.HasPrefix(lower, "param(") {
			if stage != 0 {
				return true
			}
			if strings.ToLower(normalizePowerShellPathExpression(command)) !=
				"param[string]$operation" {
				return true
			}
			stage = 1
			continue
		}
		if strings.ToLower(normalizePowerShellPathExpression(command)) ==
			"if$operation-eqrequireeditor" {
			if stage > 1 {
				return true
			}
			stage = 2
			continue
		}
		if stage >= 3 {
			return true
		}
		references := invokedPowerShellReferences(command)
		if len(references) != 1 ||
			!simplePowerShellInvocation(command, references[0]) ||
			!safeDelegatedPowerShellArguments(command[references[0].end:]) {
			return true
		}
		stage = 3
		invocations++
	}
	return invocations != 1
}

func balancedPowerShellBraces(text string) bool {
	depth := 0
	inSingleQuote := false
	inDoubleQuote := false
	for index := 0; index < len(text); index++ {
		char := text[index]
		if char == '`' && !inSingleQuote && index+1 < len(text) {
			index++
			continue
		}
		if char == '\'' && !inDoubleQuote {
			if inSingleQuote && index+1 < len(text) && text[index+1] == '\'' {
				index++
				continue
			}
			inSingleQuote = !inSingleQuote
			continue
		}
		if char == '"' && !inSingleQuote {
			inDoubleQuote = !inDoubleQuote
			continue
		}
		if inSingleQuote || inDoubleQuote {
			continue
		}
		switch char {
		case '{':
			depth++
		case '}':
			depth--
			if depth < 0 {
				return false
			}
		}
	}
	return depth == 0
}

func safeDelegatedPowerShellArguments(arguments string) bool {
	subexpressions, malformed := powerShellExpandableSubexpressions(arguments)
	if malformed || len(subexpressions) != 0 {
		return false
	}
	inSingleQuote := false
	inDoubleQuote := false
	for index := 0; index < len(arguments); index++ {
		char := arguments[index]
		if char == '`' && !inSingleQuote && index+1 < len(arguments) {
			index++
			continue
		}
		if char == '\'' && !inDoubleQuote {
			if inSingleQuote && index+1 < len(arguments) && arguments[index+1] == '\'' {
				index++
				continue
			}
			inSingleQuote = !inSingleQuote
			continue
		}
		if char == '"' && !inSingleQuote {
			inDoubleQuote = !inDoubleQuote
			continue
		}
		if inSingleQuote || inDoubleQuote {
			continue
		}
		if strings.ContainsRune(";|&<>{}()", rune(char)) ||
			((char == '$' || char == '@') &&
				index+1 < len(arguments) && arguments[index+1] == '(') {
			return false
		}
	}
	return !inSingleQuote && !inDoubleQuote
}

func hasUnresolvedPowerShellScriptInvocation(text string) bool {
	if powerShellMutatesDelegatedScriptTarget(text) {
		return true
	}
	return hasUnresolvedPowerShellInvocation(
		text,
		func(_ string, variable string) bool {
			return strings.TrimSpace(variable) != ""
		},
		true,
	)
}

func powerShellMutatesDelegatedScriptTarget(text string) bool {
	mutators := map[string]bool{
		"add-content": true, "clear-content": true, "copy": true, "copy-item": true,
		"cp": true, "cpi": true, "curl": true, "expand-archive": true,
		"invoke-webrequest": true, "iwr": true, "move-item": true, "mi": true,
		"mv": true, "new-item": true, "ni": true, "out-file": true,
		"rename-item": true, "ren": true, "rni": true, "set-content": true,
		"sp": true, "wget": true,
	}
	for _, command := range powerShellCommands(text) {
		tokens := powerShellCommandTokens(command)
		for _, token := range tokens {
			if mutators[powerShellCommandBase(powerShellSemanticToken(token))] {
				return true
			}
		}
		lower := strings.ToLower(powerShellUnquotedText(command))
		if strings.Contains(lower, "[io.file]") ||
			strings.Contains(lower, "[system.io.file]") ||
			strings.Contains(lower, "[io.directory]") ||
			strings.Contains(lower, "[system.io.directory]") {
			return true
		}
	}
	return false
}

func hasUnresolvedPowerShellWorkflowInvocation(text string) bool {
	return hasUnresolvedPowerShellInvocation(
		text,
		func(_ string, variable string) bool {
			return strings.TrimSpace(variable) != ""
		},
		true,
	)
}

func hasUnresolvedPowerShellEditorInvocation(text string) bool {
	return hasUnresolvedPowerShellInvocation(
		text,
		powerShellVariableMayReferenceEditorScript,
		false,
	)
}

func hasUnresolvedPowerShellInvocation(
	text string,
	mayReference func(string, string) bool,
	rejectExpression bool,
) bool {
	clean := stripPowerShellComments(text)
	if powerShellMutatesTrustedPathContext(clean) {
		return true
	}
	if powerShellContainsHereString(clean) {
		return true
	}
	subexpressions, malformed := powerShellExpandableSubexpressions(
		clean,
	)
	if malformed {
		return true
	}
	for _, subexpression := range subexpressions {
		if hasUnresolvedPowerShellInvocation(
			subexpression,
			mayReference,
			rejectExpression,
		) {
			return true
		}
	}
	for _, command := range powerShellCommands(text) {
		if dynamicPowerShellEvaluation(command) {
			return true
		}
		executionTokens := powerShellCommandTokens(command)
		for index, token := range executionTokens {
			name := powerShellCommandBase(powerShellSemanticToken(token))
			if name != "start-job" && name != "invoke-command" {
				continue
			}
			for _, option := range executionTokens[index+1:] {
				option = strings.TrimLeft(
					strings.ToLower(powerShellSemanticToken(option)),
					"-",
				)
				if option == "filepath" || option == "literalpath" || option == "pspath" {
					return true
				}
			}
		}
		inSingleQuote := false
		inDoubleQuote := false
		for index := 0; index < len(command); index++ {
			char := command[index]
			if char == '`' && !inSingleQuote && index+1 < len(command) {
				index++
				continue
			}
			if char == '\'' && !inDoubleQuote {
				if inSingleQuote && index+1 < len(command) &&
					command[index+1] == '\'' {
					index++
					continue
				}
				inSingleQuote = !inSingleQuote
				continue
			}
			if char == '"' && !inSingleQuote {
				inDoubleQuote = !inDoubleQuote
				continue
			}
			if inSingleQuote || inDoubleQuote {
				continue
			}
			operator := (char == '&' &&
				powerShellCallOperator(command, index)) ||
				(char == '.' && powerShellDotOperator(command, index))
			if !operator {
				continue
			}
			next := skipPowerShellTrivia(command, index+1)
			if next < len(command) &&
				(command[next] == '\'' || command[next] == '"') &&
				quotedDynamicPowerShellTarget(command, next) {
				return true
			}
			targetText := command[next:]
			target := powerShellDirectTargetToken(targetText)
			if len(target) < len(targetText) && strings.HasSuffix(target, "$") &&
				targetText[len(target)] == '(' {
				return true
			}
			if target != "" &&
				dynamicPowerShellCommandTarget(
					text,
					target,
					mayReference,
				) {
				return true
			}
			if target == "" && next < len(command) && command[next] == '$' {
				end := next + 1
				for end < len(command) &&
					(unicode.IsLetter(rune(command[end])) ||
						unicode.IsDigit(rune(command[end])) ||
						strings.ContainsRune("_:{}-", rune(command[end]))) {
					end++
				}
				if mayReference(
					text,
					command[next:end],
				) {
					return true
				}
			} else if next < len(command) && command[next] == '(' {
				expression := strings.ToLower(command[next:])
				if (rejectExpression &&
					!safeLiteralPowerShellJoinPathInvocation(expression)) ||
					strings.Contains(
						normalizePowerShellPathExpression(expression),
						"ensure-editor.ps1",
					) {
					return true
				}
			}
		}

		tokens := powerShellCommandTokens(command)
		hostIndex := powerShellHostInvocationIndex(tokens)
		if hostIndex < 0 {
			continue
		}
		tokens = tokens[hostIndex:]
		stopParsing := false
	fileOptions:
		for index, token := range tokens {
			singleQuotedOption := singleQuotedPowerShellToken(token)
			rawOption := strings.Trim(token, `"'(){}[]`)
			option := powerShellSemanticToken(token)
			if token == "--%" {
				stopParsing = true
				continue
			}
			optionName := strings.TrimLeft(strings.ToLower(option), "-")
			if optionName == "?" ||
				(optionName != "" &&
					(strings.HasPrefix("help", optionName) ||
						strings.HasPrefix("version", optionName))) {
				break fileOptions
			}
			argument := ""
			if separator := strings.Index(rawOption, ":"); separator >= 0 {
				argument = rawOption[separator+1:]
				option = powerShellSemanticToken(rawOption[:separator])
				if singleQuotedOption {
					argument = "'" + argument + "'"
				}
			} else if index+1 < len(tokens) {
				argument = tokens[index+1]
			}
			if (strings.EqualFold(option, "-file") ||
				strings.EqualFold(option, "-f")) &&
				argument != "" {
				if index+2 < len(tokens) && tokens[index+1] == "--%" {
					argument = tokens[index+2]
					stopParsing = true
				}
				if dynamicPowerShellFileArgument(
					text,
					argument,
					stopParsing,
					mayReference,
				) {
					return true
				}
				break
			}
		}
	}
	return false
}

func powerShellMutatesTrustedPathContext(text string) bool {
	if strings.Contains(strings.ToLower(powerShellUnquotedText(text)), "$executioncontext") {
		return true
	}
	assignments := powerShellVariableAssignments(text)
	if _, ok := assignments["psscriptroot"]; ok {
		return true
	}
	if _, ok := assignments["env:github_workspace"]; ok {
		return true
	}
	locationCommands := map[string]bool{
		"cd": true, "chdir": true, "pop-location": true, "popd": true,
		"push-location": true, "pushd": true, "set-location": true, "sl": true,
	}
	variableCommands := map[string]bool{
		"clear-variable": true, "cv": true, "new-variable": true, "nv": true,
		"remove-variable": true, "rv": true, "set-variable": true, "sv": true,
	}
	providerCommands := map[string]bool{
		"clear-item": true, "new-item": true, "ni": true, "remove-item": true,
		"rename-item": true, "ri": true, "set-item": true, "si": true,
	}
	for _, command := range powerShellCommands(text) {
		if assignment := strings.Index(command, "="); assignment >= 0 {
			left := strings.TrimSpace(command[:assignment])
			left = strings.TrimRight(left, "+-*/%")
			left = strings.ToLower(strings.Trim(left, " ${}"))
			if strings.HasSuffix(left, "psscriptroot") ||
				strings.HasSuffix(left, "env:github_workspace") {
				return true
			}
		}
		tokens := powerShellCommandTokens(command)
		if len(tokens) == 0 {
			continue
		}
		name := powerShellCommandBase(powerShellSemanticToken(tokens[0]))
		if name == "&" && len(tokens) > 1 {
			name = powerShellCommandBase(powerShellSemanticToken(tokens[1]))
			tokens = tokens[1:]
		}
		if (name == "function" || name == "filter") && len(tokens) > 1 {
			definition := strings.ToLower(powerShellSemanticToken(tokens[1]))
			if separator := strings.LastIndex(definition, ":"); separator >= 0 {
				definition = definition[separator+1:]
			}
			if definition == "join-path" {
				return true
			}
		}
		if name == "set-alias" || name == "new-alias" || name == "sal" {
			return true
		}
		if locationCommands[name] {
			return true
		}
		if strings.HasPrefix(name, "[environment]::setenvironmentvariable") &&
			strings.Contains(strings.ToLower(command), "github_workspace") {
			return true
		}
		if variableCommands[name] {
			return true
		}
		if providerCommands[name] {
			for _, token := range tokens[1:] {
				target := strings.ToLower(strings.ReplaceAll(
					powerShellSemanticToken(token),
					"\\",
					"/",
				))
				if (strings.Contains(target, "variable:") &&
					strings.Contains(target, "psscriptroot")) ||
					(strings.Contains(target, "env:") &&
						strings.Contains(target, "github_workspace")) {
					return true
				}
			}
		}
	}
	return false
}

func powerShellCommandBase(command string) string {
	command = strings.ToLower(strings.ReplaceAll(command, "/", "\\"))
	if separator := strings.LastIndex(command, "\\"); separator >= 0 {
		command = command[separator+1:]
	}
	return command
}

func powerShellContainsHereString(text string) bool {
	inSingleQuote := false
	inDoubleQuote := false
	for index := 0; index < len(text); index++ {
		char := text[index]
		if char == '`' && !inSingleQuote && index+1 < len(text) {
			index++
			continue
		}
		if !inSingleQuote && !inDoubleQuote && char == '@' &&
			index+1 < len(text) &&
			(text[index+1] == '\'' || text[index+1] == '"') {
			return true
		}
		if char == '\'' && !inDoubleQuote {
			if inSingleQuote && index+1 < len(text) && text[index+1] == '\'' {
				index++
				continue
			}
			inSingleQuote = !inSingleQuote
			continue
		}
		if char == '"' && !inSingleQuote {
			inDoubleQuote = !inDoubleQuote
		}
	}
	return false
}

func powerShellExpandableSubexpressions(text string) ([]string, bool) {
	result := make([]string, 0)
	inSingleQuote := false
	inDoubleQuote := false
	for index := 0; index < len(text); index++ {
		char := text[index]
		if char == '`' && !inSingleQuote && index+1 < len(text) {
			index++
			continue
		}
		if char == '\'' && !inDoubleQuote {
			if inSingleQuote && index+1 < len(text) && text[index+1] == '\'' {
				index++
				continue
			}
			inSingleQuote = !inSingleQuote
			continue
		}
		if char == '"' && !inSingleQuote {
			inDoubleQuote = !inDoubleQuote
			continue
		}
		if !inDoubleQuote || char != '$' ||
			index+1 >= len(text) || text[index+1] != '(' {
			continue
		}
		end, ok := powerShellParenthesizedExpressionEnd(text, index+1)
		if !ok {
			return nil, true
		}
		result = append(result, text[index+2:end])
		index = end
	}
	return result, false
}

func powerShellParenthesizedExpressionEnd(text string, open int) (int, bool) {
	depth := 1
	inSingleQuote := false
	inDoubleQuote := false
	for index := open + 1; index < len(text); index++ {
		char := text[index]
		if char == '`' && !inSingleQuote && index+1 < len(text) {
			index++
			continue
		}
		if char == '\'' && !inDoubleQuote {
			if inSingleQuote && index+1 < len(text) && text[index+1] == '\'' {
				index++
				continue
			}
			inSingleQuote = !inSingleQuote
			continue
		}
		if char == '"' && !inSingleQuote {
			inDoubleQuote = !inDoubleQuote
			continue
		}
		if inSingleQuote || inDoubleQuote {
			continue
		}
		switch char {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return index, true
			}
		}
	}
	return 0, false
}

func powerShellCallOperator(command string, index int) bool {
	prefix := strings.TrimSpace(command[:index])
	if prefix == "" {
		return true
	}
	if strings.EqualFold(prefix, "return") {
		return true
	}
	for _, suffix := range []string{"=", "(", "{", ";", "|", "&&"} {
		if strings.HasSuffix(prefix, suffix) {
			return true
		}
	}
	return false
}

func powerShellCommandTokens(command string) []string {
	result := make([]string, 0)
	var token strings.Builder
	inSingleQuote := false
	inDoubleQuote := false
	flush := func() {
		if token.Len() == 0 {
			return
		}
		result = append(result, token.String())
		token.Reset()
	}
	for index := 0; index < len(command); index++ {
		char := command[index]
		if char == '`' && !inSingleQuote && index+1 < len(command) {
			token.WriteByte(char)
			index++
			token.WriteByte(command[index])
			continue
		}
		if char == '\'' && !inDoubleQuote {
			if inSingleQuote && index+1 < len(command) &&
				command[index+1] == '\'' {
				token.WriteString("''")
				index++
				continue
			}
			inSingleQuote = !inSingleQuote
			token.WriteByte(char)
			continue
		}
		if char == '"' && !inSingleQuote {
			inDoubleQuote = !inDoubleQuote
			token.WriteByte(char)
			continue
		}
		if !inSingleQuote && !inDoubleQuote {
			space, size := utf8.DecodeRuneInString(command[index:])
			if unicode.IsSpace(space) {
				flush()
				index += size - 1
				continue
			}
		}
		if char == '=' && !inSingleQuote && !inDoubleQuote {
			current := token.String()
			assignment := len(result) == 0 &&
				powerShellAssignmentTarget(current)
			if !assignment && len(result) > 0 &&
				(current == "" || strings.Contains("+-*/%?", current)) &&
				powerShellAssignmentTokens(result) {
				assignment = true
			}
			if assignment {
				flush()
				result = append(result, "=")
			} else {
				token.WriteString("`=")
			}
			continue
		}
		token.WriteByte(char)
	}
	flush()
	return result
}

func powerShellAssignmentTarget(token string) bool {
	token = strings.TrimSpace(token)
	var ok bool
	token, ok = trimLeadingPowerShellTypeConstraints(token)
	if !ok {
		return false
	}
	return len(token) > 1 && strings.HasPrefix(token, "$")
}

func trimLeadingPowerShellTypeConstraints(token string) (string, bool) {
	for strings.HasPrefix(token, "[") {
		depth := 0
		closing := -1
		inSingleQuote := false
		inDoubleQuote := false
		for index := 0; index < len(token); index++ {
			char := token[index]
			if char == '`' && !inSingleQuote && index+1 < len(token) {
				index++
				continue
			}
			if char == '\'' && !inDoubleQuote {
				if inSingleQuote && index+1 < len(token) &&
					token[index+1] == '\'' {
					index++
					continue
				}
				inSingleQuote = !inSingleQuote
				continue
			}
			if char == '"' && !inSingleQuote {
				inDoubleQuote = !inDoubleQuote
				continue
			}
			if inSingleQuote || inDoubleQuote {
				continue
			}
			switch char {
			case '[':
				depth++
			case ']':
				depth--
				if depth == 0 {
					closing = index
				}
			}
			if closing >= 0 {
				break
			}
		}
		if closing < 0 || depth != 0 || inSingleQuote || inDoubleQuote {
			return token, false
		}
		token = token[closing+1:]
	}
	return token, true
}

func powerShellAssignmentTokens(tokens []string) bool {
	if len(tokens) == 0 ||
		!powerShellAssignmentTarget(tokens[len(tokens)-1]) {
		return false
	}
	for _, token := range tokens[:len(tokens)-1] {
		var ok bool
		token, ok = trimLeadingPowerShellTypeConstraints(token)
		if !ok || token != "" {
			return false
		}
	}
	return true
}

func dynamicPowerShellFileArgument(
	text, argument string,
	stopParsing bool,
	mayReference func(string, string) bool,
) bool {
	if strings.Contains(argument, "${{") {
		return true
	}
	if stopParsing {
		return windowsEnvironmentExpansion(argument)
	}
	trimmed := strings.TrimSpace(argument)
	if strings.HasPrefix(trimmed, "(") ||
		strings.HasPrefix(trimmed, "@") {
		return true
	}
	_, dynamic := powerShellTokenSemantics(argument)
	if !dynamic {
		return false
	}
	variables, expression := powerShellDynamicReferences(argument)
	if expression {
		return true
	}
	for _, variable := range variables {
		if mayReference(text, variable) {
			return true
		}
	}
	return false
}

func powerShellUnescapeToken(token string) string {
	var result strings.Builder
	for index := 0; index < len(token); index++ {
		if token[index] == '`' && index+1 < len(token) {
			index++
		}
		result.WriteByte(token[index])
	}
	return result.String()
}

func powerShellSemanticToken(token string) string {
	value, _ := powerShellTokenSemantics(token)
	return value
}

func powerShellTokenSemantics(token string) (string, bool) {
	var value strings.Builder
	inSingleQuote := false
	inDoubleQuote := false
	dynamic := false
	for index := 0; index < len(token); index++ {
		char := token[index]
		if inSingleQuote {
			if char == '\'' {
				if index+1 < len(token) && token[index+1] == '\'' {
					value.WriteByte('\'')
					index++
				} else {
					inSingleQuote = false
				}
				continue
			}
			value.WriteByte(char)
			continue
		}
		if char == '`' && index+1 < len(token) {
			index++
			value.WriteByte(token[index])
			continue
		}
		if char == '\'' && !inDoubleQuote {
			inSingleQuote = true
			continue
		}
		if char == '"' {
			inDoubleQuote = !inDoubleQuote
			continue
		}
		if char == '$' && powerShellVariableStartsAt(token, index) {
			dynamic = true
		}
		value.WriteByte(char)
	}
	return value.String(), dynamic
}

func powerShellVariableStartsAt(text string, index int) bool {
	next := index + 1
	if next >= len(text) {
		return false
	}
	char, _ := utf8.DecodeRuneInString(text[next:])
	return unicode.IsLetter(char) || unicode.IsDigit(char) ||
		strings.ContainsRune("_:{(?^$", char)
}

func powerShellDynamicReferences(token string) ([]string, bool) {
	var variables []string
	inSingleQuote := false
	inDoubleQuote := false
	for index := 0; index < len(token); index++ {
		char := token[index]
		if inSingleQuote {
			if char == '\'' {
				if index+1 < len(token) && token[index+1] == '\'' {
					index++
				} else {
					inSingleQuote = false
				}
			}
			continue
		}
		if char == '`' && index+1 < len(token) {
			index++
			continue
		}
		if char == '\'' && !inDoubleQuote {
			inSingleQuote = true
			continue
		}
		if char == '"' {
			inDoubleQuote = !inDoubleQuote
			continue
		}
		if char != '$' || index+1 >= len(token) {
			continue
		}
		next := token[index+1]
		if strings.ContainsRune("(?$^", rune(next)) {
			return variables, true
		}
		end := index + 1
		if next == '{' {
			closing := strings.IndexByte(token[end+1:], '}')
			if closing < 0 {
				return variables, true
			}
			end += closing + 2
		} else {
			for end < len(token) {
				char, size := utf8.DecodeRuneInString(token[end:])
				if !unicode.IsLetter(char) && !unicode.IsDigit(char) &&
					!strings.ContainsRune("_:-", char) {
					break
				}
				end += size
			}
		}
		if end > index+1 {
			variables = append(variables, token[index:end])
			index = end - 1
		}
	}
	return variables, false
}

func dynamicPowerShellCommandTarget(
	text, token string,
	mayReference func(string, string) bool,
) bool {
	value, dynamic := powerShellTokenSemantics(token)
	if !dynamic {
		return false
	}
	variables, expression := powerShellDynamicReferences(token)
	if expression {
		return true
	}
	if safeInterpolatedPowerShellPath(value, variables) {
		return false
	}
	for _, variable := range variables {
		if mayReference(text, variable) {
			return true
		}
	}
	return false
}

func windowsEnvironmentExpansion(text string) bool {
	start := strings.Index(text, "%")
	if start < 0 {
		return false
	}
	end := strings.Index(text[start+1:], "%")
	return end > 0
}

func powerShellHostInvocation(tokens []string) bool {
	if len(tokens) == 0 {
		return false
	}
	index := 0
	if tokens[index] == "&" {
		index++
	}
	if index >= len(tokens) {
		return false
	}
	executable := powerShellSemanticToken(tokens[index])
	executable = path.Base(strings.ReplaceAll(executable, "\\", "/"))
	executable = strings.TrimSuffix(strings.ToLower(executable), ".exe")
	return executable == "pwsh" || executable == "powershell"
}

func powerShellHostInvocationIndex(tokens []string) int {
	if powerShellHostInvocation(tokens) {
		return 0
	}
	if len(tokens) > 1 &&
		strings.EqualFold(tokens[0], "return") &&
		powerShellHostInvocation(tokens[1:]) {
		return 1
	}
	for index, token := range tokens {
		if token == "&" && powerShellHostInvocation(tokens[index:]) {
			return index
		}
		if index > 0 && tokens[index-1] == "=" &&
			powerShellHostInvocation(tokens[index:]) {
			return index
		}
	}
	return -1
}

func singleQuotedPowerShellToken(token string) bool {
	return len(token) >= 2 && token[0] == '\'' && token[len(token)-1] == '\''
}

func safeLiteralPowerShellJoinPathInvocation(expression string) bool {
	return false
}

func quotedDynamicPowerShellTarget(command string, start int) bool {
	quote := command[start]
	var target strings.Builder
	interpolated := false
	end := start + 1
	for end < len(command) {
		char := command[end]
		if quote == '\'' && char == '\'' &&
			end+1 < len(command) && command[end+1] == '\'' {
			target.WriteByte('\'')
			end += 2
			continue
		}
		if quote == '"' && char == '`' && end+1 < len(command) {
			target.WriteByte(command[end+1])
			end += 2
			continue
		}
		if quote == '"' && char == '$' {
			interpolated = true
		}
		if char == quote {
			break
		}
		target.WriteByte(char)
		end++
	}
	if end >= len(command) {
		return true
	}
	if interpolated {
		variables, expression := powerShellDynamicReferences(target.String())
		if expression ||
			!safeInterpolatedPowerShellPath(target.String(), variables) {
			return true
		}
	}
	name := strings.ToLower(
		path.Base(strings.ReplaceAll(target.String(), "\\", "/")),
	)
	name = strings.TrimSuffix(name, ".exe")
	if name == "iex" || name == "invoke-expression" {
		return true
	}
	if name != "pwsh" && name != "powershell" {
		return false
	}
	for _, token := range strings.FieldsFunc(
		strings.ToLower(powerShellUnquotedText(command[end+1:])),
		func(char rune) bool {
			return !unicode.IsLetter(char) && !unicode.IsDigit(char) && char != '-'
		},
	) {
		if token == "-c" || token == "-command" {
			return true
		}
	}
	return false
}

func safeInterpolatedPowerShellPath(target string, variables []string) bool {
	if len(variables) != 1 {
		return false
	}
	variable := strings.ToLower(variables[0])
	if strings.HasPrefix(variable, "${") && strings.HasSuffix(variable, "}") {
		variable = "$" + variable[2:len(variable)-1]
	}
	if variable != "$env:github_workspace" && variable != "$psscriptroot" {
		return false
	}
	lower := strings.ToLower(strings.ReplaceAll(target, "\\", "/"))
	for _, prefix := range []string{
		"$env:github_workspace/",
		"${env:github_workspace}/",
		"$psscriptroot/",
		"${psscriptroot}/",
	} {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	return false
}

func dynamicPowerShellEvaluation(command string) bool {
	lower := strings.ToLower(powerShellUnquotedText(command))
	if strings.Contains(lower, "[scriptblock]::create") ||
		strings.Contains(lower, "-encodedcommand") {
		return true
	}
	shell := false
	dynamicArgument := false
	for _, token := range strings.FieldsFunc(lower, func(char rune) bool {
		return !unicode.IsLetter(char) && !unicode.IsDigit(char) && char != '-'
	}) {
		if token == "iex" || token == "invoke-expression" {
			return true
		}
		if token == "pwsh" || token == "powershell" {
			shell = true
		}
		if token == "-c" || token == "-command" {
			dynamicArgument = true
		}
	}
	return shell && dynamicArgument
}

func powerShellVariableMayReferenceEditorScript(text, variable string) bool {
	variable = strings.ToLower(strings.TrimSpace(variable))
	variable = strings.TrimSuffix(strings.TrimPrefix(variable, "${"), "}")
	variable = strings.TrimPrefix(variable, "$")
	if strings.Contains(
		strings.NewReplacer("-", "", "_", "").Replace(variable),
		"ensureeditor",
	) {
		return true
	}
	needle := "$" + variable
	for _, command := range powerShellCommands(text) {
		lower := strings.ToLower(command)
		variableIndex := strings.Index(lower, needle)
		assignmentIndex := strings.Index(lower, "=")
		if variableIndex < 0 || assignmentIndex <= variableIndex {
			continue
		}
		if strings.Contains(
			normalizePowerShellPathExpression(lower[assignmentIndex+1:]),
			"ensure-editor.ps1",
		) {
			return true
		}
	}
	return false
}

func powerShellVariableAssignments(text string) map[string]string {
	result := make(map[string]string)
	for _, command := range powerShellCommands(text) {
		assignment := strings.Index(command, "=")
		if assignment < 0 {
			continue
		}
		left := strings.TrimSpace(command[:assignment])
		if !strings.HasPrefix(left, "$") || len(left) == 1 {
			continue
		}
		name := strings.ToLower(
			strings.TrimSuffix(strings.TrimPrefix(left, "${"), "}"),
		)
		name = strings.TrimPrefix(name, "$")
		valid := name != ""
		for _, char := range name {
			if !unicode.IsLetter(char) &&
				!unicode.IsDigit(char) &&
				!strings.ContainsRune("_:-", char) {
				valid = false
				break
			}
		}
		if valid {
			result[name] = command[assignment+1:]
		}
	}
	return result
}

func expandPowerShellVariables(
	expression string,
	assignments map[string]string,
	visiting map[string]bool,
) string {
	var result strings.Builder
	for index := 0; index < len(expression); {
		if expression[index] != '$' {
			result.WriteByte(expression[index])
			index++
			continue
		}
		end := index + 1
		braced := end < len(expression) && expression[end] == '{'
		if braced {
			end++
		}
		for end < len(expression) &&
			(unicode.IsLetter(rune(expression[end])) ||
				unicode.IsDigit(rune(expression[end])) ||
				strings.ContainsRune("_:-", rune(expression[end]))) {
			end++
		}
		if braced && end < len(expression) && expression[end] == '}' {
			end++
		}
		name := strings.ToLower(strings.Trim(expression[index:end], "${}"))
		value, ok := assignments[name]
		if !ok || visiting[name] {
			result.WriteString(expression[index:end])
			index = end
			continue
		}
		visiting[name] = true
		result.WriteString(expandPowerShellVariables(value, assignments, visiting))
		delete(visiting, name)
		index = end
	}
	return result.String()
}

func normalizePowerShellPathExpression(expression string) string {
	return strings.Map(func(char rune) rune {
		if unicode.IsSpace(char) ||
			strings.ContainsRune("`'\"+()", char) {
			return -1
		}
		return char
	}, expression)
}

func (result *editorSourceAudit) merge(other editorSourceAudit) {
	result.found = result.found || other.found
	result.topLevel = result.topLevel || other.topLevel
	result.unsafe = result.unsafe || other.unsafe
	result.provisioningControl = result.provisioningControl || other.provisioningControl
}

func invokedPowerShellReferences(text string) []powerShellPathReference {
	seen := make(map[string]bool)
	result := make([]powerShellPathReference, 0)
	for _, command := range powerShellCommands(text) {
		directReferences := directInvokedPowerShellReferences(command)
		references := append([]powerShellPathReference{}, directReferences...)
		for _, reference := range powerShellPathReferences(command) {
			overlapped := false
			for _, direct := range directReferences {
				if reference.start < direct.end && direct.start < reference.end {
					overlapped = true
					break
				}
			}
			if !overlapped {
				references = append(references, reference)
			}
		}
		for _, reference := range references {
			if !powerShellCommandInvokesReference(command, reference) {
				continue
			}
			scriptRelative, joinPathCall := powerShellJoinPathCall(
				command[:reference.start],
			)
			if joinPathCall {
				reference.scriptRelative = scriptRelative
				reference.hazardous = true
			}
			key := reference.path + "\x00" + strconv.FormatBool(reference.scriptRelative) +
				"\x00" + strconv.FormatBool(reference.hazardous)
			if seen[key] {
				continue
			}
			seen[key] = true
			result = append(result, reference)
		}
	}
	return result
}

func directInvokedPowerShellReferences(command string) []powerShellPathReference {
	result := make([]powerShellPathReference, 0)
	inSingleQuote := false
	inDoubleQuote := false
	for index := 0; index < len(command); index++ {
		char := command[index]
		if char == '`' && !inSingleQuote && index+1 < len(command) {
			index++
			continue
		}
		if char == '\'' && !inDoubleQuote {
			if inSingleQuote && index+1 < len(command) && command[index+1] == '\'' {
				index++
				continue
			}
			inSingleQuote = !inSingleQuote
			continue
		}
		if char == '"' && !inSingleQuote {
			inDoubleQuote = !inDoubleQuote
			continue
		}
		if inSingleQuote || inDoubleQuote {
			continue
		}
		operator := (char == '&' && powerShellCallOperator(command, index)) ||
			(char == '.' && powerShellDotOperator(command, index))
		if !operator {
			continue
		}
		next := skipPowerShellTrivia(command, index+1)
		if char == '.' && next == index+1 &&
			(next >= len(command) || command[next] != '(') {
			continue
		}
		target := powerShellDirectTargetToken(command[next:])
		if target == "" || strings.HasPrefix(target, "(") {
			continue
		}
		if reference, ok := powerShellScriptTokenReference(target); ok {
			reference.start = next
			reference.end = next + len(target)
			result = append(result, reference)
		}
	}
	return result
}

func powerShellDirectTargetToken(text string) string {
	inSingleQuote := false
	inDoubleQuote := false
	for index := 0; index < len(text); index++ {
		char := text[index]
		if char == '`' && !inSingleQuote && index+1 < len(text) {
			index++
			continue
		}
		if char == '\'' && !inDoubleQuote {
			if inSingleQuote && index+1 < len(text) && text[index+1] == '\'' {
				index++
				continue
			}
			inSingleQuote = !inSingleQuote
			continue
		}
		if char == '"' && !inSingleQuote {
			inDoubleQuote = !inDoubleQuote
			continue
		}
		if !inSingleQuote && !inDoubleQuote && char == '$' &&
			index+1 < len(text) && text[index+1] == '{' {
			if closing := strings.IndexByte(text[index+2:], '}'); closing >= 0 {
				index += closing + 2
				continue
			}
		}
		if !inSingleQuote && !inDoubleQuote {
			space, _ := utf8.DecodeRuneInString(text[index:])
			if unicode.IsSpace(space) || strings.ContainsRune(",;(){}|&<>", rune(char)) {
				return text[:index]
			}
		}
	}
	return text
}

func powerShellScriptTokenReference(token string) (powerShellPathReference, bool) {
	candidate, dynamic := powerShellTokenSemantics(token)
	candidate = strings.ReplaceAll(candidate, "\\", "/")
	candidateLower := strings.ToLower(candidate)
	scriptRelative := false
	for _, prefix := range []string{
		"$env:github_workspace/",
		"${env:github_workspace}/",
		"${{github.workspace}}/",
		"./",
	} {
		if strings.HasPrefix(candidateLower, prefix) &&
			(prefix == "./" || dynamic) {
			candidate = candidate[len(prefix):]
			candidateLower = candidateLower[len(prefix):]
			break
		}
	}
	for _, prefix := range []string{"$psscriptroot/", "${psscriptroot}/"} {
		if dynamic && strings.HasPrefix(candidateLower, prefix) {
			candidate = candidate[len(prefix):]
			candidateLower = candidateLower[len(prefix):]
			scriptRelative = true
			break
		}
	}
	candidate = path.Clean(candidate)
	if !strings.EqualFold(path.Ext(candidate), ".ps1") {
		return powerShellPathReference{}, false
	}
	clean, err := cleanRepositoryPath(candidate)
	repositoryRelative := err == nil && clean == candidate &&
		!strings.Contains(candidate, ":") && !strings.Contains(candidate, "$")
	return powerShellPathReference{
		path:               candidate,
		repositoryRelative: repositoryRelative,
		scriptRelative:     scriptRelative && repositoryRelative,
	}, true
}

func powerShellPathReferences(text string) []powerShellPathReference {
	normalized := strings.ReplaceAll(text, "\\", "/")
	lower := strings.ToLower(normalized)
	result := make([]powerShellPathReference, 0)
	for offset := 0; ; {
		index := strings.Index(lower[offset:], ".ps1")
		if index < 0 {
			break
		}
		end := offset + index + len(".ps1")
		start := end - len(".ps1")
		for start > 0 && !powerShellPathDelimiter(rune(normalized[start-1])) {
			start--
		}
		candidate := strings.TrimSpace(normalized[start:end])
		quote := byte(0)
		if start > 0 && (normalized[start-1] == '\'' || normalized[start-1] == '"') {
			quote = normalized[start-1]
		}
		token := candidate
		if quote != 0 {
			token = string(quote) + candidate + string(quote)
		}
		candidate, dynamic := powerShellTokenSemantics(token)
		candidateLower := strings.ToLower(candidate)
		scriptRelative := false
		for _, prefix := range []string{
			"$env:github_workspace/",
			"${env:github_workspace}/",
			"${{github.workspace}}/",
			"./",
		} {
			if strings.HasPrefix(candidateLower, prefix) &&
				(prefix == "./" || dynamic) {
				candidate = candidate[len(prefix):]
				candidateLower = candidateLower[len(prefix):]
				break
			}
		}
		for _, prefix := range []string{
			"$psscriptroot/",
			"${psscriptroot}/",
		} {
			if dynamic && strings.HasPrefix(candidateLower, prefix) {
				candidate = candidate[len(prefix):]
				candidateLower = candidateLower[len(prefix):]
				scriptRelative = true
				break
			}
		}
		candidate = path.Clean(candidate)
		if strings.EqualFold(path.Ext(candidate), ".ps1") {
			clean, err := cleanRepositoryPath(candidate)
			repositoryRelative := err == nil &&
				clean == candidate &&
				!strings.Contains(candidate, ":") &&
				!strings.Contains(candidate, "$")
			result = append(result, powerShellPathReference{
				path:               candidate,
				start:              start,
				end:                end,
				repositoryRelative: repositoryRelative,
				scriptRelative:     scriptRelative && repositoryRelative,
			})
		}
		offset = end
	}
	return result
}

func powerShellCommandInvokesReference(
	command string,
	reference powerShellPathReference,
) bool {
	if reference.start < 0 || reference.start > len(command) {
		return false
	}
	prefix := strings.TrimSpace(command[:reference.start])
	quotedReference := reference.start > 0 &&
		(command[reference.start-1] == '\'' || command[reference.start-1] == '"')
	prefix = strings.TrimSpace(strings.TrimRight(prefix, `"'`))
	if quotedReference && (prefix == "" || strings.HasSuffix(prefix, "(")) {
		return false
	}
	if prefix == "" {
		return true
	}
	lowerPrefix := strings.ToLower(prefix)
	if powerShellJoinPathCallPrefix(lowerPrefix) {
		return true
	}
	last := prefix[len(prefix)-1]
	if strings.ContainsRune("&.{(", rune(last)) {
		return true
	}
	fields := strings.Fields(strings.ToLower(prefix))
	return len(fields) > 0 && fields[len(fields)-1] == "-file"
}

func powerShellJoinPathCallPrefix(prefix string) bool {
	_, found := powerShellJoinPathCall(prefix)
	return found
}

func powerShellJoinPathCall(prefix string) (bool, bool) {
	inSingleQuote := false
	inDoubleQuote := false
	expandableDepth := 0
	for index := 0; index < len(prefix); index++ {
		char := prefix[index]
		if char == '`' && !inSingleQuote && index+1 < len(prefix) {
			index++
			continue
		}
		if inDoubleQuote && expandableDepth == 0 {
			if char == '$' && index+1 < len(prefix) && prefix[index+1] == '(' {
				expandableDepth = 1
				index++
				continue
			}
			if char == '"' {
				inDoubleQuote = false
			}
			continue
		}
		if char == '\'' && !inDoubleQuote {
			if inSingleQuote && index+1 < len(prefix) && prefix[index+1] == '\'' {
				index++
				continue
			}
			inSingleQuote = !inSingleQuote
			continue
		}
		if char == '"' && !inSingleQuote {
			inDoubleQuote = !inDoubleQuote
			continue
		}
		if inSingleQuote || (inDoubleQuote && expandableDepth == 0) {
			continue
		}
		if expandableDepth > 0 {
			switch char {
			case '(':
				expandableDepth++
			case ')':
				expandableDepth--
			}
		}
		operator := (char == '&' && powerShellCallOperator(prefix, index)) ||
			(char == '.' && powerShellDotOperator(prefix, index))
		if !operator {
			continue
		}
		next := skipPowerShellTrivia(prefix, index+1)
		if next >= len(prefix) || prefix[next] != '(' {
			continue
		}
		commandEnd, ok := powerShellJoinPathCommandEnd(prefix, next+1)
		if !ok {
			continue
		}
		if !balancedPowerShellParentheses(prefix[index+1:]) {
			scriptRelative, _ := powerShellJoinPathRoot(prefix[commandEnd:])
			return scriptRelative, true
		}
	}
	return false, false
}

func powerShellJoinPathRoot(text string) (bool, bool) {
	text = strings.TrimRight(strings.TrimSpace(text), "'\"")
	for {
		trimmed := strings.TrimRightFunc(text, unicode.IsSpace)
		trivia := text[len(trimmed):]
		if strings.Contains(trivia, "\n") && strings.HasSuffix(trimmed, "`") {
			text = strings.TrimSuffix(trimmed, "`")
			continue
		}
		text = trimmed
		break
	}
	start := skipPowerShellTrivia(text, 0)
	text = text[start:]
	tokens := powerShellCommandTokens(text)
	if len(tokens) != 1 {
		return false, false
	}
	switch strings.ToLower(tokens[0]) {
	case "$psscriptroot", "${psscriptroot}",
		"\"$psscriptroot\"", "\"${psscriptroot}\"":
		return true, true
	case "$env:github_workspace", "${env:github_workspace}",
		"\"$env:github_workspace\"", "\"${env:github_workspace}\"":
		return false, true
	default:
		return false, false
	}
}

func powerShellDotOperator(command string, index int) bool {
	prefix := strings.TrimSpace(command[:index])
	return prefix == "" || strings.ContainsRune("{(", rune(prefix[len(prefix)-1]))
}

func powerShellJoinPathCommandEnd(text string, start int) (int, bool) {
	start = skipPowerShellTrivia(text, start)
	for _, command := range []string{
		`microsoft.powershell.management\join-path`,
		"join-path",
	} {
		if end, ok := powerShellCommandNameEnd(text, start, command); ok {
			return end, true
		}
	}
	return 0, false
}

func powerShellCommandNameEnd(text string, start int, command string) (int, bool) {
	index := start
	for expected := 0; expected < len(command); expected++ {
		for index < len(text) && text[index] == '`' {
			if index+1 >= len(text) {
				return 0, false
			}
			if text[index+1] == '\n' {
				return 0, false
			}
			index++
			break
		}
		if index >= len(text) ||
			!strings.EqualFold(text[index:index+1], command[expected:expected+1]) {
			return 0, false
		}
		index++
	}
	if index >= len(text) {
		return index, true
	}
	char, _ := utf8.DecodeRuneInString(text[index:])
	if !unicode.IsSpace(char) && !(text[index] == '`' &&
		index+1 < len(text) && text[index+1] == '\n') {
		return 0, false
	}
	return index, true
}

func skipPowerShellTrivia(text string, index int) int {
	for {
		index = skipPowerShellWhitespace(text, index)
		if index+1 >= len(text) || text[index] != '`' || text[index+1] != '\n' {
			return index
		}
		index += 2
	}
}

func skipPowerShellWhitespace(text string, index int) int {
	for index < len(text) {
		char, size := utf8.DecodeRuneInString(text[index:])
		if !unicode.IsSpace(char) {
			break
		}
		index += size
	}
	return index
}

func inertPowerShellReference(command string) bool {
	lower := strings.ToLower(strings.TrimSpace(command))
	for _, commandName := range []string{
		"throw ", "write-debug ", "write-error ", "write-host ",
		"write-information ", "write-output ", "write-verbose ", "write-warning ",
	} {
		if strings.HasPrefix(lower, commandName) {
			return true
		}
	}
	return false
}

func enabledPowerShellSwitch(arguments, name string) bool {
	if strings.Contains(arguments, "$(") {
		return false
	}
	var token strings.Builder
	inSingleQuote := false
	inDoubleQuote := false
	flush := func() bool {
		value := strings.ToLower(token.String())
		token.Reset()
		return value == "-"+name || value == "-"+name+":$true"
	}
	for index := 0; index <= len(arguments); index++ {
		var char byte
		if index < len(arguments) {
			char = arguments[index]
		}
		if index < len(arguments) && char == '`' && !inSingleQuote && index+1 < len(arguments) {
			index++
			continue
		}
		if index < len(arguments) && char == '\'' && !inDoubleQuote {
			if inSingleQuote && index+1 < len(arguments) && arguments[index+1] == '\'' {
				index++
				continue
			}
			inSingleQuote = !inSingleQuote
			continue
		}
		if index < len(arguments) && char == '"' && !inSingleQuote {
			inDoubleQuote = !inDoubleQuote
			continue
		}
		if inSingleQuote || inDoubleQuote {
			continue
		}
		if index == len(arguments) || unicode.IsSpace(rune(char)) ||
			strings.ContainsRune(";,|(){}[]", rune(char)) {
			if flush() {
				return true
			}
			continue
		}
		token.WriteByte(char)
	}
	return false
}

func powerShellPathDelimiter(char rune) bool {
	return unicode.IsSpace(char) ||
		strings.ContainsRune(`"'&(){}[]|;=,`, char)
}

func requiredBoundedTimeout(node *yaml.Node, maximum int) bool {
	timeout := mappingValue(node, "timeout-minutes")
	if timeout == nil || timeout.Kind != yaml.ScalarNode {
		return false
	}
	value, err := strconv.Atoi(timeout.Value)
	return err == nil && value > 0 && value <= maximum
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

// successDependentStepRunnable is stricter than affirmativeStepRunnable:
// security setup and acquisition must inherit GitHub's implicit success()
// dependency. An explicit always() is affirmative but would continue after a
// failed provenance bootstrap.
func successDependentStepRunnable(step flattenedUnityStep) bool {
	return mappingValue(step.node, "if") == nil &&
		len(step.enclosingConditions) == 0 &&
		criticalStepFailurePropagates(step)
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
			if key == "unity-version" && !validUnityEditorRelease(value) {
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
	if len(parts) != 3 || len(parts[0]) != 4 || len(parts[1]) == 0 {
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

func validUnityEditorRelease(value string) bool {
	if !validUnityVersion(value) {
		return false
	}
	return strings.Count(strings.Split(value, ".")[2], "f") == 1
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
	editorAudit := auditEnsureEditorSource(run.Value)
	if editorAudit.found && !editorAudit.unsafe {
		hasEditorExecution := false
		for _, command := range powerShellCommands(run.Value) {
			text := strings.ToLower(command)
			if commandInvokesUnityExecutable(command) ||
				strings.Contains(text, "-batchmode") ||
				strings.Contains(text, "-serial") ||
				strings.Contains(text, "-manuallicensefile") ||
				strings.Contains(text, "-executemethod") ||
				strings.Contains(text, "-runtests") {
				hasEditorExecution = true
				break
			}
		}
		if !hasEditorExecution {
			return false
		}
	}
	for _, command := range powerShellCommands(run.Value) {
		if commandInvokesUnityExecutable(command) &&
			(!commandHasExactPowerShellArgument(command, "-returnlicense") ||
				commandHasUnityActivationArgument(command)) {
			return true
		}
	}
	return false
}

func commandInvokesUnityExecutable(command string) bool {
	return commandInvokesNamedExecutable(command, "unity.exe") ||
		commandInvokesNamedExecutable(command, "unity-editor")
}

func commandInvokesNamedExecutable(command, executable string) bool {
	tokens := powerShellCommandTokens(command)
	semantic := make([]string, len(tokens))
	for index, token := range tokens {
		semantic[index] = powerShellCommandSemanticToken(token)
	}
	if powerShellStartProcessInvokesExecutable(tokens, semantic, executable) {
		return true
	}
	for index, raw := range tokens {
		attachedCall := false
		subexpressionCall := false
		switch {
		case strings.HasPrefix(raw, "$(&"):
			raw = strings.TrimPrefix(raw, "$(&")
			attachedCall = true
		case strings.HasPrefix(raw, "$("):
			raw = strings.TrimPrefix(raw, "$(")
			subexpressionCall = true
		case strings.HasPrefix(raw, "&"):
			raw = strings.TrimPrefix(raw, "&")
			attachedCall = true
		}
		quoted := strings.HasPrefix(raw, "'") ||
			strings.HasPrefix(raw, `"`)
		value := powerShellSemanticToken(raw)
		value = strings.Trim(value, "(){}")
		name := strings.ToLower(
			path.Base(strings.ReplaceAll(value, "\\", "/")),
		)
		if name != executable {
			continue
		}
		if attachedCall ||
			(subexpressionCall && !quoted) ||
			(index == 0 && !quoted) ||
			(index > 0 && semantic[index-1] == "&") ||
			(index > 0 && semantic[index-1] == "$(&") ||
			(index > 0 && semantic[index-1] == "=" && !quoted) ||
			(index == 1 && semantic[0] == "return" && !quoted) {
			return true
		}
	}
	return false
}

func powerShellCommandSemanticToken(token string) string {
	value := strings.ToLower(
		strings.Trim(
			powerShellSemanticToken(token),
			"(){}[]",
		),
	)
	for _, prefix := range []string{"$(&", "$("} {
		if strings.HasPrefix(value, prefix) && len(value) > len(prefix) {
			return strings.TrimPrefix(value, prefix)
		}
	}
	return value
}

func powerShellStartProcessInvokesExecutable(
	raw, semantic []string,
	executable string,
) bool {
	for index, token := range semantic {
		if !powerShellStartProcessCommand(token) ||
			!powerShellTokenAtCommandPosition(semantic, index) {
			continue
		}
		for argument := index + 1; argument < len(raw); argument++ {
			option := semantic[argument]
			name, attached, recognized := startProcessParameter(option)
			if name != "filepath" || !recognized {
				continue
			}
			if attached != "" {
				return powerShellExecutableName(attached) == executable
			}
			if argument+1 < len(raw) {
				return powerShellExecutableName(raw[argument+1]) == executable
			}
			return false
		}
		for argument := index + 1; argument < len(raw); argument++ {
			option := semantic[argument]
			if strings.HasPrefix(option, "-") {
				_, attached, recognized := startProcessParameter(option)
				if !recognized {
					return false
				}
				if startProcessParameterTakesValue(option) &&
					attached == "" &&
					argument+1 < len(raw) {
					argument++
				}
				continue
			}
			return powerShellExecutableName(raw[argument]) == executable
		}
	}
	return false
}

func powerShellStartProcessCommand(token string) bool {
	if token == "start-process" || token == "saps" || token == "start" {
		return true
	}
	if strings.Contains(token, ":") ||
		strings.Contains(token, "/") ||
		strings.Count(token, "\\") != 1 {
		return false
	}
	parts := strings.SplitN(token, "\\", 2)
	if parts[0] == "" || parts[0] == "." || parts[0] == ".." ||
		parts[1] != "start-process" {
		return false
	}
	for _, char := range parts[0] {
		if !unicode.IsLetter(char) &&
			!unicode.IsDigit(char) &&
			!strings.ContainsRune("._-", char) {
			return false
		}
	}
	return true
}

func startProcessParameter(option string) (string, string, bool) {
	option = strings.TrimPrefix(strings.ToLower(option), "-")
	attached := ""
	if separator := strings.IndexByte(option, ':'); separator >= 0 {
		attached = option[separator+1:]
		option = option[:separator]
	}
	parameters := []string{
		"argumentlist",
		"confirm",
		"credential",
		"debug",
		"environment",
		"erroraction",
		"errorvariable",
		"filepath",
		"informationaction",
		"informationvariable",
		"loaduserprofile",
		"nonewwindow",
		"outbuffer",
		"outvariable",
		"passthru",
		"pipelinevariable",
		"progressaction",
		"redirectstandarderror",
		"redirectstandardinput",
		"redirectstandardoutput",
		"usenewenvironment",
		"verb",
		"verbose",
		"wait",
		"warningaction",
		"warningvariable",
		"whatif",
		"windowstyle",
		"workingdirectory",
	}
	match := ""
	for _, parameter := range parameters {
		if parameter == option {
			return parameter, attached, true
		}
		if strings.HasPrefix(parameter, option) {
			if match != "" {
				return "", attached, false
			}
			match = parameter
		}
	}
	return match, attached, match != ""
}

func startProcessParameterTakesValue(option string) bool {
	parameter, _, recognized := startProcessParameter(option)
	if !recognized {
		return false
	}
	switch parameter {
	case "confirm",
		"debug",
		"loaduserprofile",
		"nonewwindow",
		"passthru",
		"usenewenvironment",
		"verbose",
		"wait",
		"whatif":
		return false
	default:
		return true
	}
}

func powerShellExecutableName(token string) string {
	value := powerShellSemanticToken(token)
	value = strings.Trim(value, "(){}")
	return strings.ToLower(
		path.Base(strings.ReplaceAll(value, "\\", "/")),
	)
}

func powerShellTokenAtCommandPosition(tokens []string, index int) bool {
	return index == 0 ||
		(index > 0 &&
			(tokens[index-1] == "=" ||
				tokens[index-1] == "&" ||
				tokens[index-1] == "$(&")) ||
		(index == 1 && tokens[0] == "return")
}

func commandHasExactPowerShellArgument(command, argument string) bool {
	for _, token := range powerShellCommandTokens(command) {
		if strings.EqualFold(powerShellSemanticToken(token), argument) {
			return true
		}
	}
	return false
}

func commandHasUnityActivationArgument(command string) bool {
	for _, argument := range []string{
		"-serial",
		"-manuallicensefile",
		"-executemethod",
		"-runtests",
	} {
		if commandHasExactPowerShellArgument(command, argument) {
			return true
		}
	}
	return false
}

func stepReturnsUnity(step *yaml.Node) bool {
	run := mappingValue(step, "run")
	if run == nil || run.Kind != yaml.ScalarNode {
		return false
	}
	for _, command := range powerShellCommands(run.Value) {
		if commandInvokesUnityExecutable(command) &&
			commandHasExactPowerShellArgument(command, "-returnlicense") {
			return true
		}
	}
	text := strings.ToLower(run.Value)
	return strings.Contains(text, "& $") && strings.Contains(text, "@return") &&
		commandHasExactPowerShellArgument(run.Value, "-returnlicense")
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
	static     string
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
			"static-validation-result": true,
			"classifier-result":        true,
			"unity-required":           true,
			"trusted-revision":         true,
			"preflight-result":         true,
			"unity-result":             true,
			"fallback-result":          true,
			"fallback-cleanup-result":  true,
		}) ||
		!trustedRevisionExpression(mappingValue(with, "trusted-revision")) {
		return false
	}
	references := validationGateReferences{
		static:     needsResultReference(mappingValue(with, "static-validation-result")),
		classifier: needsResultReference(mappingValue(with, "classifier-result")),
		preflight:  needsResultReference(mappingValue(with, "preflight-result")),
		unity:      needsResultReference(mappingValue(with, "unity-result")),
		fallback:   needsResultReference(mappingValue(with, "fallback-result")),
	}
	if references.static != "static-validation" ||
		references.classifier == "" ||
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
		references.static:     true,
		references.classifier: true,
		references.preflight:  true,
		references.unity:      true,
		references.fallback:   true,
	}
	if len(distinctReferences) != 5 ||
		!a.validationClassifierMatches(workflow, jobs, references.classifier) ||
		!a.validationPreflightMatches(workflow, jobs, references.preflight) ||
		!validationJobIsolationSafe(workflow, mappingValue(jobs, references.unity)) ||
		!a.validationLockActionEnvironmentsSafe(mappingValue(jobs, references.unity)) {
		return false
	}
	for _, reference := range []string{
		references.static,
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
		action := lockActionName(stepUses(step.node))
		if action == "" {
			continue
		}
		for _, enclosing := range step.enclosingSteps {
			if mappingValue(enclosing, "env") != nil {
				return false
			}
		}
		env := mappingValue(step.node, "env")
		if action == validationLicenseAction {
			if !exactUnityLicenseValidationEnvironment(env) {
				return false
			}
			continue
		}
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

func exactUnityLicenseValidationEnvironment(env *yaml.Node) bool {
	return env != nil &&
		env.Kind == yaml.MappingNode &&
		len(env.Content) == 8 &&
		mappingHasOnlyKeys(env, map[string]bool{
			"UNITY_SERIAL":           true,
			"UNITY_EMAIL":            true,
			"UNITY_PASSWORD":         true,
			"UNITY_LICENSING_SERVER": true,
		}) &&
		exactExpression(mappingValue(env, "UNITY_SERIAL"), "secrets.UNITY_SERIAL") &&
		exactExpression(mappingValue(env, "UNITY_EMAIL"), "secrets.UNITY_EMAIL") &&
		exactExpression(mappingValue(env, "UNITY_PASSWORD"), "secrets.UNITY_PASSWORD") &&
		exactExpression(
			mappingValue(env, "UNITY_LICENSING_SERVER"),
			"secrets.UNITY_LICENSING_SERVER",
		)
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
