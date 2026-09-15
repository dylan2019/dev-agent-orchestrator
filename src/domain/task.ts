import crypto from "node:crypto";

import { assertDomain } from "./errors.js";
import { normalizeAuthorizedPaths, pathIsCovered, scopePreservesAndExpands } from "./scope.js";
import type {
  Attempt,
  CandidateSnapshot,
  Delivery,
  DomainEvent,
  ExecutionBudget,
  ExternalBlock,
  GateResult,
  IndependentReview,
  RiskLevel,
  ScopeGrant,
  TaskAggregate,
  TaskState,
  TransitionResult,
} from "./types.js";

function event(
  task: TaskAggregate,
  type: string,
  occurredAt: string,
  payload: Readonly<Record<string, unknown>> = {},
): DomainEvent {
  return { taskId: task.id, revision: task.revision, type, occurredAt, payload };
}

function transitioned(
  current: TaskAggregate,
  state: TaskState,
  occurredAt: string,
  type: string,
  changes: Partial<
    Omit<
      TaskAggregate,
      | "id"
      | "projectId"
      | "objective"
      | "risk"
      | "budget"
      | "executionProfileFingerprint"
      | "implementationWorkerId"
      | "reviewWorkerId"
    >
  >,
  payload: Readonly<Record<string, unknown>> = {},
): TransitionResult {
  const task: TaskAggregate = {
    ...current,
    ...changes,
    state,
    revision: current.revision + 1,
    updatedAt: occurredAt,
  };
  return { task, event: event(task, type, occurredAt, payload) };
}

function requireState(task: TaskAggregate, states: readonly TaskState[], action: string): void {
  assertDomain(states.includes(task.state), "ILLEGAL_TASK_TRANSITION", `${action} is not legal`, {
    taskId: task.id,
    state: task.state,
    allowedStates: states,
  });
}

function requireFingerprint(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  assertDomain(/^[a-f0-9]{64}$/.test(normalized), "INVALID_FINGERPRINT", `${field} is invalid`);
  return normalized;
}

export function createTask(input: {
  readonly id: string;
  readonly projectId: string;
  readonly objective: string;
  readonly risk: RiskLevel;
  readonly executionProfileFingerprint: string;
  readonly implementationWorkerId: string;
  readonly reviewWorkerId: string;
  readonly budget: ExecutionBudget;
  readonly initialScope: readonly string[];
  readonly occurredAt: string;
}): TransitionResult {
  assertDomain(/^[a-z][a-z0-9-]{7,79}$/.test(input.id), "INVALID_TASK_ID", "Task ID is invalid");
  assertDomain(
    /^[a-z][a-z0-9_-]{0,63}$/.test(input.projectId),
    "INVALID_PROJECT_ID",
    "Project ID is invalid",
  );
  const objective = input.objective.trim();
  assertDomain(objective.length >= 8, "INVALID_OBJECTIVE", "Objective is too short");
  const executionProfileFingerprint = requireFingerprint(
    input.executionProfileFingerprint,
    "Execution Profile fingerprint",
  );
  assertDomain(
    input.implementationWorkerId !== input.reviewWorkerId,
    "INDEPENDENT_REVIEWER_REQUIRED",
    "Implementation and review Worker IDs must be different",
  );
  const paths = normalizeAuthorizedPaths(input.initialScope);
  const initialGrant: ScopeGrant = {
    revision: 1,
    paths,
    approvedBy: "codex",
    approvedAt: input.occurredAt,
    reason: "initial task authorization",
  };
  const task: TaskAggregate = {
    id: input.id,
    projectId: input.projectId,
    objective,
    risk: input.risk,
    executionProfileFingerprint,
    implementationWorkerId: input.implementationWorkerId,
    reviewWorkerId: input.reviewWorkerId,
    state: "CREATED",
    revision: 1,
    createdAt: input.occurredAt,
    updatedAt: input.occurredAt,
    budget: input.budget,
    scopeGrants: [initialGrant],
    attempts: [],
  };
  return { task, event: event(task, "task.created", input.occurredAt, { risk: input.risk }) };
}

export function startScoping(task: TaskAggregate, occurredAt: string): TransitionResult {
  requireState(task, ["CREATED"], "start scoping");
  return transitioned(task, "SCOPING", occurredAt, "task.scoping_started", {});
}

export function startImplementation(
  task: TaskAggregate,
  input: { readonly executorId: string; readonly model: string; readonly occurredAt: string },
): TransitionResult {
  requireState(task, ["CREATED", "SCOPING", "REWORK_REQUIRED"], "start implementation");
  const implementationRuns = task.attempts.filter(
    (attempt) => attempt.kind === "implementation",
  ).length;
  if (
    implementationRuns >= task.budget.maxAttempts ||
    implementationRuns >= task.budget.maxWorkerRuns
  ) {
    return transitioned(
      task,
      "EXHAUSTED",
      input.occurredAt,
      "budget.exhausted",
      { reworkReason: "Implementation attempt budget exhausted" },
      { kind: "implementation" },
    );
  }
  const scopeRevision = task.scopeGrants.at(-1)?.revision;
  assertDomain(scopeRevision !== undefined, "SCOPE_MISSING", "Task has no ScopeGrant");
  const attempt: Attempt = {
    number: task.attempts.length + 1,
    kind: "implementation",
    executorId: input.executorId,
    model: input.model,
    scopeRevision,
    status: "running",
    startedAt: input.occurredAt,
  };
  return transitioned(
    task,
    "IMPLEMENTING",
    input.occurredAt,
    "implementation.started",
    {
      attempts: [...task.attempts, attempt],
      scopeRequest: undefined,
      gateResults: undefined,
      controlReview: undefined,
      independentReview: undefined,
      delivery: undefined,
      externalBlock: undefined,
      reworkReason: undefined,
    },
    { attempt: attempt.number, executorId: input.executorId, model: input.model },
  );
}

export function requestScopeApproval(
  task: TaskAggregate,
  input: {
    readonly requestedPaths: readonly string[];
    readonly reason: string;
    readonly candidateFingerprint: string;
    readonly occurredAt: string;
  },
): TransitionResult {
  requireState(task, ["IMPLEMENTING"], "request scope approval");
  const current = task.scopeGrants.at(-1);
  assertDomain(current !== undefined, "SCOPE_MISSING", "Task has no ScopeGrant");
  const requestedPaths = normalizeAuthorizedPaths(input.requestedPaths);
  assertDomain(
    scopePreservesAndExpands(current.paths, requestedPaths),
    "SCOPE_NOT_EXPANDED",
    "Requested scope must preserve and expand the current grant",
  );
  const fingerprint = requireFingerprint(input.candidateFingerprint, "Candidate fingerprint");
  return transitioned(
    task,
    "SCOPE_APPROVAL_REQUIRED",
    input.occurredAt,
    "scope.requested",
    {
      scopeRequest: {
        requestedPaths,
        reason: input.reason.trim(),
        candidateFingerprint: fingerprint,
        requestedAt: input.occurredAt,
      },
      attempts: finishCurrentAttempt(task.attempts, input.occurredAt, "failed", "SCOPE_REQUIRED"),
    },
    { requestedPaths, candidateFingerprint: fingerprint },
  );
}

export function approveScope(
  task: TaskAggregate,
  input: {
    readonly paths: readonly string[];
    readonly expectedCandidateFingerprint: string;
    readonly reason: string;
    readonly occurredAt: string;
  },
): TransitionResult {
  requireState(task, ["SCOPE_APPROVAL_REQUIRED"], "approve scope");
  const request = task.scopeRequest;
  const previous = task.scopeGrants.at(-1);
  assertDomain(
    request !== undefined && previous !== undefined,
    "SCOPE_REQUEST_MISSING",
    "Scope request is missing",
  );
  const paths = normalizeAuthorizedPaths(input.paths);
  assertDomain(
    scopePreservesAndExpands(previous.paths, paths),
    "SCOPE_NOT_EXPANDED",
    "Approved scope must preserve and expand the current grant",
  );
  assertDomain(
    request.requestedPaths.every((path) => pathIsCovered(path, paths)),
    "SCOPE_REQUEST_NOT_COVERED",
    "Approved scope does not cover the requested paths",
  );
  const fingerprint = requireFingerprint(
    input.expectedCandidateFingerprint,
    "Expected Candidate fingerprint",
  );
  assertDomain(
    fingerprint === request.candidateFingerprint,
    "STALE_CANDIDATE_DECISION",
    "Candidate changed after the scope request",
  );
  const grant: ScopeGrant = {
    revision: previous.revision + 1,
    paths,
    approvedBy: "codex",
    approvedAt: input.occurredAt,
    reason: input.reason.trim(),
    candidateFingerprint: fingerprint,
  };
  return transitioned(
    task,
    "REWORK_REQUIRED",
    input.occurredAt,
    "scope.approved",
    {
      scopeGrants: [...task.scopeGrants, grant],
      scopeRequest: undefined,
      reworkReason: input.reason.trim(),
    },
    { scopeRevision: grant.revision, candidateFingerprint: fingerprint },
  );
}

export function recordCandidate(
  task: TaskAggregate,
  input: Omit<CandidateSnapshot, "id" | "createdAt" | "producedByAttempt"> & {
    readonly occurredAt: string;
    readonly sessionId?: string;
    readonly workerSummary?: string;
  },
): TransitionResult {
  requireState(task, ["IMPLEMENTING"], "record candidate");
  const fingerprint = requireFingerprint(input.fingerprint, "Candidate fingerprint");
  assertDomain(input.changedFiles.length > 0, "EMPTY_CANDIDATE", "Candidate has no changes");
  const currentGrant = task.scopeGrants.at(-1);
  assertDomain(currentGrant !== undefined, "SCOPE_MISSING", "Task has no ScopeGrant");
  const violations = input.changedFiles.filter((file) => !pathIsCovered(file, currentGrant.paths));
  assertDomain(
    violations.length === 0,
    "CANDIDATE_SCOPE_VIOLATION",
    "Candidate exceeds its ScopeGrant",
    {
      violations,
    },
  );
  const attempt = task.attempts.at(-1);
  assertDomain(
    attempt?.kind === "implementation",
    "IMPLEMENTATION_ATTEMPT_MISSING",
    "Implementation Attempt is missing",
  );
  const candidate: CandidateSnapshot = {
    id: crypto.randomUUID(),
    baseCommit: input.baseCommit,
    fingerprint,
    changedFiles: [...input.changedFiles].sort(),
    changedLines: input.changedLines,
    producedByAttempt: attempt.number,
    createdAt: input.occurredAt,
  };
  return transitioned(
    task,
    "VERIFYING",
    input.occurredAt,
    "candidate.created",
    {
      candidate,
      attempts: finishCurrentAttempt(
        task.attempts,
        input.occurredAt,
        "succeeded",
        undefined,
        input.sessionId,
      ),
      gateResults: undefined,
      controlReview: undefined,
      independentReview: undefined,
      delivery: undefined,
      ...(input.workerSummary ? { lastWorkerSummary: input.workerSummary.slice(0, 20_000) } : {}),
    },
    { candidateId: candidate.id, fingerprint, changedFiles: candidate.changedFiles.length },
  );
}

export function completeVerification(
  task: TaskAggregate,
  gateResults: readonly GateResult[],
  occurredAt: string,
): TransitionResult {
  requireState(task, ["VERIFYING"], "complete verification");
  assertDomain(
    gateResults.length > 0,
    "GATE_RESULTS_MISSING",
    "Verification requires Gate results",
  );
  const failed = gateResults.find((gate) => gate.status === "fail");
  return transitioned(
    task,
    failed ? "REWORK_REQUIRED" : "AWAITING_CONTROL_REVIEW",
    occurredAt,
    "verification.finished",
    {
      gateResults: [...gateResults],
      ...(failed ? { reworkReason: `Gate failed: ${failed.gateId}` } : {}),
    },
    { outcome: failed ? "fail" : "pass", gateCount: gateResults.length },
  );
}

export function recordControlReview(
  task: TaskAggregate,
  input: {
    readonly expectedCandidateFingerprint: string;
    readonly decision: "approve" | "rework";
    readonly summary: string;
    readonly occurredAt: string;
  },
): TransitionResult {
  requireState(task, ["AWAITING_CONTROL_REVIEW"], "record control review");
  const candidate = requireCurrentCandidate(task, input.expectedCandidateFingerprint);
  const review = {
    candidateFingerprint: candidate.fingerprint,
    decision: input.decision,
    summary: input.summary.trim(),
    reviewedAt: input.occurredAt,
  } as const;
  return transitioned(
    task,
    input.decision === "approve" ? "INDEPENDENT_REVIEWING" : "REWORK_REQUIRED",
    input.occurredAt,
    "control_review.recorded",
    {
      controlReview: review,
      ...(input.decision === "rework" ? { reworkReason: review.summary } : {}),
    },
    { decision: input.decision, candidateFingerprint: candidate.fingerprint },
  );
}

export function recordIndependentReview(
  task: TaskAggregate,
  input: Omit<IndependentReview, "reviewedAt"> & { readonly reviewedAt: string },
): TransitionResult {
  requireState(task, ["INDEPENDENT_REVIEWING"], "record independent review");
  const candidate = requireCurrentCandidate(task, input.candidateFingerprint);
  const attempt = task.attempts.at(-1);
  assertDomain(
    attempt?.kind === "independent_review" && attempt.status === "running",
    "REVIEW_ATTEMPT_MISSING",
    "Running independent-review Attempt is missing",
  );
  const review: IndependentReview = {
    ...input,
    candidateFingerprint: candidate.fingerprint,
    findings: [...input.findings],
  };
  return transitioned(
    task,
    review.verdict === "pass" ? "AWAITING_FINAL_APPROVAL" : "REWORK_REQUIRED",
    input.reviewedAt,
    "independent_review.finished",
    {
      independentReview: review,
      attempts: finishCurrentAttempt(task.attempts, input.reviewedAt, "succeeded"),
      ...(review.verdict === "fail" ? { reworkReason: review.summary } : {}),
    },
    { verdict: review.verdict, candidateFingerprint: candidate.fingerprint },
  );
}

export function startIndependentReviewAttempt(
  task: TaskAggregate,
  input: { readonly executorId: string; readonly model: string; readonly occurredAt: string },
): TransitionResult {
  requireState(task, ["INDEPENDENT_REVIEWING"], "start independent review");
  const reviewRuns = task.attempts.filter(
    (attempt) => attempt.kind === "independent_review",
  ).length;
  if (reviewRuns >= task.budget.maxReviewerRuns) {
    return transitioned(
      task,
      "EXHAUSTED",
      input.occurredAt,
      "budget.exhausted",
      { reworkReason: "Independent review budget exhausted" },
      { kind: "independent_review" },
    );
  }
  const scopeRevision = task.scopeGrants.at(-1)?.revision;
  assertDomain(scopeRevision !== undefined, "SCOPE_MISSING", "Task has no ScopeGrant");
  const attempt: Attempt = {
    number: task.attempts.length + 1,
    kind: "independent_review",
    executorId: input.executorId,
    model: input.model,
    scopeRevision,
    status: "running",
    startedAt: input.occurredAt,
  };
  return transitioned(
    task,
    "INDEPENDENT_REVIEWING",
    input.occurredAt,
    "independent_review.started",
    { attempts: [...task.attempts, attempt] },
    { attempt: attempt.number, executorId: input.executorId, model: input.model },
  );
}

export function requireRework(
  task: TaskAggregate,
  input: { readonly reason: string; readonly errorCode: string; readonly occurredAt: string },
): TransitionResult {
  requireState(
    task,
    [
      "IMPLEMENTING",
      "VERIFYING",
      "AWAITING_CONTROL_REVIEW",
      "INDEPENDENT_REVIEWING",
      "AWAITING_FINAL_APPROVAL",
      "ACCEPTING",
    ],
    "require rework",
  );
  const reason = input.reason.trim();
  assertDomain(reason.length > 0, "REWORK_REASON_REQUIRED", "Rework reason is required");
  return transitioned(
    task,
    "REWORK_REQUIRED",
    input.occurredAt,
    "rework.required",
    {
      attempts: finishCurrentAttempt(task.attempts, input.occurredAt, "failed", input.errorCode),
      reworkReason: reason,
      externalBlock: undefined,
      ...(task.state === "ACCEPTING" && task.delivery?.status === "running"
        ? {
            delivery: {
              ...task.delivery,
              status: "failed" as const,
              finishedAt: input.occurredAt,
              errorCode: input.errorCode,
            },
          }
        : {}),
    },
    { errorCode: input.errorCode },
  );
}

export function confirmRework(
  task: TaskAggregate,
  reason: string,
  occurredAt: string,
): TransitionResult {
  requireState(task, ["REWORK_REQUIRED"], "confirm rework");
  const normalized = reason.trim();
  assertDomain(normalized.length > 0, "REWORK_REASON_REQUIRED", "Rework reason is required");
  return transitioned(
    task,
    "REWORK_REQUIRED",
    occurredAt,
    "rework.confirmed",
    { reworkReason: normalized },
    {},
  );
}

export function approveDelivery(
  task: TaskAggregate,
  input: {
    readonly expectedCandidateFingerprint: string;
    readonly idempotencyKey: string;
    readonly commitMessage: string;
    readonly push: boolean;
    readonly occurredAt: string;
  },
): TransitionResult {
  requireState(task, ["AWAITING_FINAL_APPROVAL"], "approve delivery");
  const candidate = requireCurrentCandidate(task, input.expectedCandidateFingerprint);
  assertDomain(
    task.independentReview?.verdict === "pass" &&
      task.independentReview.candidateFingerprint === candidate.fingerprint,
    "PASSING_REVIEW_REQUIRED",
    "Delivery requires a passing independent review for the current Candidate",
  );
  assertDomain(
    /^[a-zA-Z0-9._:-]{8,128}$/.test(input.idempotencyKey),
    "INVALID_IDEMPOTENCY_KEY",
    "Delivery idempotency key is invalid",
  );
  const commitMessage = input.commitMessage.trim();
  assertDomain(commitMessage.length >= 3, "INVALID_COMMIT_MESSAGE", "Commit message is invalid");
  const delivery: Delivery = {
    candidateFingerprint: candidate.fingerprint,
    idempotencyKey: input.idempotencyKey,
    commitMessage,
    pushRequested: input.push,
    status: "running",
    startedAt: input.occurredAt,
  };
  return transitioned(
    task,
    "ACCEPTING",
    input.occurredAt,
    "delivery.started",
    { delivery },
    {
      candidateFingerprint: candidate.fingerprint,
      idempotencyKey: input.idempotencyKey,
      push: input.push,
    },
  );
}

export function completeDelivery(
  task: TaskAggregate,
  input: {
    readonly candidateFingerprint: string;
    readonly commitHash: string;
    readonly treeHash: string;
    readonly pushed: boolean;
    readonly occurredAt: string;
  },
): TransitionResult {
  requireState(task, ["ACCEPTING"], "complete delivery");
  const candidate = requireCurrentCandidate(task, input.candidateFingerprint);
  assertDomain(
    task.delivery?.status === "running",
    "DELIVERY_NOT_RUNNING",
    "Delivery is not running",
  );
  const delivery: Delivery = {
    ...task.delivery,
    candidateFingerprint: candidate.fingerprint,
    status: "committed",
    finishedAt: input.occurredAt,
    commitHash: input.commitHash,
    treeHash: input.treeHash,
    pushed: input.pushed,
  };
  return transitioned(
    task,
    "COMMITTED",
    input.occurredAt,
    "delivery.finished",
    { delivery },
    { commitHash: input.commitHash, treeHash: input.treeHash, pushed: input.pushed },
  );
}

export function blockExternally(task: TaskAggregate, block: ExternalBlock): TransitionResult {
  requireState(
    task,
    ["CREATED", "SCOPING", "IMPLEMENTING", "VERIFYING", "INDEPENDENT_REVIEWING", "ACCEPTING"],
    "block task",
  );
  assertDomain(
    block.resumeState === task.state,
    "INVALID_RESUME_STATE",
    "External block resume state is invalid",
  );
  return transitioned(
    task,
    "EXTERNAL_BLOCKED",
    block.blockedAt,
    "task.external_blocked",
    {
      externalBlock: block,
      attempts: finishCurrentAttempt(task.attempts, block.blockedAt, "failed", block.reason),
    },
    { reason: block.reason },
  );
}

export function resumeExternalBlock(
  task: TaskAggregate,
  input: {
    readonly occurredAt: string;
    readonly targetState: "REWORK_REQUIRED" | "INDEPENDENT_REVIEWING" | "ACCEPTING";
    readonly verifiedCandidateFingerprint?: string;
    readonly verifiedTargetHead?: string;
  },
): TransitionResult {
  requireState(task, ["EXTERNAL_BLOCKED"], "resume external block");
  const block = task.externalBlock;
  assertDomain(block !== undefined, "EXTERNAL_BLOCK_MISSING", "External block evidence is missing");
  if (input.targetState !== "REWORK_REQUIRED") {
    const candidate = task.candidate;
    assertDomain(
      block.resumeState === input.targetState &&
        candidate !== undefined &&
        input.verifiedCandidateFingerprint === candidate.fingerprint,
      "UNSAFE_EXTERNAL_RESUME",
      "Resume requires the unchanged Candidate and original stage",
    );
    if (input.targetState === "INDEPENDENT_REVIEWING") {
      assertDomain(
        task.controlReview?.decision === "approve" &&
          task.controlReview.candidateFingerprint === candidate.fingerprint,
        "UNSAFE_EXTERNAL_RESUME",
        "Independent review can only resume after Candidate control approval",
      );
    } else {
      assertDomain(
        task.delivery?.status === "running" &&
          task.delivery.candidateFingerprint === candidate.fingerprint &&
          task.independentReview?.verdict === "pass" &&
          task.independentReview.candidateFingerprint === candidate.fingerprint &&
          input.verifiedTargetHead === candidate.baseCommit,
        "DELIVERY_OUTCOME_UNKNOWN",
        "Delivery cannot resume without an unchanged Candidate and target base",
      );
    }
  }
  return transitioned(
    task,
    input.targetState,
    input.occurredAt,
    "task.external_resumed",
    {
      externalBlock: undefined,
      reworkReason: input.targetState === "REWORK_REQUIRED" ? block.message : undefined,
    },
    { previousReason: block.reason, resumedState: input.targetState },
  );
}

export function cancelTask(
  task: TaskAggregate,
  occurredAt: string,
  reason: string,
): TransitionResult {
  assertDomain(
    task.state !== "COMMITTED" && task.state !== "CANCELLED" && task.state !== "EXHAUSTED",
    "TASK_NOT_CANCELLABLE",
    "Terminal Task cannot be cancelled",
  );
  return transitioned(
    task,
    "CANCELLED",
    occurredAt,
    "task.cancelled",
    {
      attempts: finishCurrentAttempt(task.attempts, occurredAt, "cancelled"),
      externalBlock: undefined,
      reworkReason: reason.trim(),
    },
    { reason: reason.trim() },
  );
}

function finishCurrentAttempt(
  attempts: readonly Attempt[],
  finishedAt: string,
  status: Attempt["status"],
  errorCode?: string,
  sessionId?: string,
): readonly Attempt[] {
  const last = attempts.at(-1);
  if (last?.status !== "running") {
    return attempts;
  }
  return [
    ...attempts.slice(0, -1),
    {
      ...last,
      status,
      finishedAt,
      ...(errorCode ? { errorCode } : {}),
      ...(sessionId ? { sessionId } : {}),
    },
  ];
}

function requireCurrentCandidate(
  task: TaskAggregate,
  expectedFingerprint: string,
): CandidateSnapshot {
  const candidate = task.candidate;
  assertDomain(candidate !== undefined, "CANDIDATE_MISSING", "Task has no CandidateSnapshot");
  const expected = requireFingerprint(expectedFingerprint, "Expected Candidate fingerprint");
  assertDomain(
    expected === candidate.fingerprint,
    "STALE_CANDIDATE_DECISION",
    "Decision targets a stale CandidateSnapshot",
    { expected, actual: candidate.fingerprint },
  );
  return candidate;
}
