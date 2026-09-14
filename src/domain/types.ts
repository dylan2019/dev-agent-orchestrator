export const TASK_STATES = [
  "CREATED",
  "SCOPING",
  "IMPLEMENTING",
  "SCOPE_APPROVAL_REQUIRED",
  "VERIFYING",
  "AWAITING_CONTROL_REVIEW",
  "INDEPENDENT_REVIEWING",
  "REWORK_REQUIRED",
  "AWAITING_FINAL_APPROVAL",
  "ACCEPTING",
  "EXTERNAL_BLOCKED",
  "COMMITTED",
  "CANCELLED",
] as const;

export type TaskState = (typeof TASK_STATES)[number];
export type RiskLevel = "normal" | "high" | "critical";
export type AttemptKind = "implementation" | "independent_review";
export type AttemptStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface ExecutionBudget {
  readonly maxWallClockMinutes: number;
  readonly maxAttempts: number;
  readonly maxWorkerRuns: number;
  readonly maxReviewerRuns: number;
  readonly maxToolEvents: number;
  readonly maxCapturedBytes: number;
  readonly maxNoCandidateChangeMinutes: number;
  readonly maxChangedFiles: number;
  readonly maxChangedLines: number;
}

export interface ScopeGrant {
  readonly revision: number;
  readonly paths: readonly string[];
  readonly approvedBy: "codex";
  readonly approvedAt: string;
  readonly reason: string;
  readonly candidateFingerprint?: string;
}

export interface ScopeRequest {
  readonly requestedPaths: readonly string[];
  readonly reason: string;
  readonly candidateFingerprint: string;
  readonly requestedAt: string;
}

export interface Attempt {
  readonly number: number;
  readonly kind: AttemptKind;
  readonly executorId: string;
  readonly model: string;
  readonly scopeRevision: number;
  readonly sessionId?: string;
  readonly status: AttemptStatus;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly errorCode?: string;
}

export interface CandidateSnapshot {
  readonly id: string;
  readonly baseCommit: string;
  readonly fingerprint: string;
  readonly changedFiles: readonly string[];
  readonly changedLines: number;
  readonly producedByAttempt: number;
  readonly createdAt: string;
}

export interface GateResult {
  readonly gateId: string;
  readonly inputHash: string;
  readonly status: "pass" | "fail";
  readonly durationMs: number;
  readonly errorCode?: string;
  readonly cachedFromRunId?: string;
}

export interface ControlReview {
  readonly candidateFingerprint: string;
  readonly decision: "approve" | "rework";
  readonly summary: string;
  readonly reviewedAt: string;
}

export interface IndependentReview {
  readonly candidateFingerprint: string;
  readonly executorId: string;
  readonly model: string;
  readonly verdict: "pass" | "fail";
  readonly summary: string;
  readonly findings: readonly string[];
  readonly reviewedAt: string;
}

export interface Delivery {
  readonly candidateFingerprint: string;
  readonly idempotencyKey: string;
  readonly commitMessage: string;
  readonly pushRequested: boolean;
  readonly status: "running" | "committed" | "failed";
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly commitHash?: string;
  readonly treeHash?: string;
  readonly pushed?: boolean;
  readonly errorCode?: string;
}

export interface ExternalBlock {
  readonly reason: "provider_capacity" | "provider_rate_limit" | "semantic_stall" | "process_lost";
  readonly message: string;
  readonly blockedAt: string;
  readonly resumeState: Exclude<TaskState, "EXTERNAL_BLOCKED" | "COMMITTED" | "CANCELLED">;
}

export interface TaskAggregate {
  readonly id: string;
  readonly projectId: string;
  readonly objective: string;
  readonly risk: RiskLevel;
  readonly executionProfileFingerprint: string;
  readonly implementationWorkerId: string;
  readonly reviewWorkerId: string;
  readonly state: TaskState;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly budget: ExecutionBudget;
  readonly scopeGrants: readonly ScopeGrant[];
  readonly attempts: readonly Attempt[];
  readonly candidate?: CandidateSnapshot | undefined;
  readonly scopeRequest?: ScopeRequest | undefined;
  readonly gateResults?: readonly GateResult[] | undefined;
  readonly controlReview?: ControlReview | undefined;
  readonly independentReview?: IndependentReview | undefined;
  readonly delivery?: Delivery | undefined;
  readonly externalBlock?: ExternalBlock | undefined;
  readonly reworkReason?: string | undefined;
  readonly lastWorkerSummary?: string | undefined;
}

export interface DomainEvent {
  readonly taskId: string;
  readonly revision: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface TransitionResult {
  readonly task: TaskAggregate;
  readonly event: DomainEvent;
}
