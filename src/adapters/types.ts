import type { ProjectProfile, WorkerAdapterId, WorkerProfile } from "../configuration/schema.js";
import type { TaskAggregate } from "../domain/types.js";

export interface WorkerProbeResult {
  readonly adapter: WorkerAdapterId;
  readonly version: string;
  readonly modelAvailable: boolean;
  readonly supportedFlags: readonly string[];
}

export interface WorkerExecutionRequest {
  readonly task: TaskAggregate;
  readonly project: ProjectProfile;
  readonly profile: WorkerProfile;
  readonly worktreePath: string;
  readonly runtimeDirectory: string;
  readonly timeoutMs: number;
  readonly maxCaptureBytes: number;
  readonly signal?: AbortSignal;
}

export interface ReviewExecutionRequest extends WorkerExecutionRequest {
  readonly candidatePatch: string;
}

export interface WorkerExecutionResult {
  readonly summary: string;
  readonly sessionId?: string;
  readonly toolEvents: number;
  readonly capturedBytes: number;
  readonly durationMs: number;
}

export interface ReviewExecutionResult extends WorkerExecutionResult {
  readonly verdict: "pass" | "fail";
  readonly findings: readonly string[];
}

export interface WorkerAdapter {
  readonly id: WorkerAdapterId;
  probe(profile: WorkerProfile, project: ProjectProfile): Promise<WorkerProbeResult>;
  implement(request: WorkerExecutionRequest): Promise<WorkerExecutionResult>;
  review(request: ReviewExecutionRequest): Promise<ReviewExecutionResult>;
}
