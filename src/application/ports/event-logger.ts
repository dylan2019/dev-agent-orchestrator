export const LOG_EVENTS = [
  "task.created",
  "state.changed",
  "lease.acquired",
  "lease.reclaimed",
  "lease.released",
  "worker.started",
  "worker.finished",
  "runner.launched",
  "runner.exited",
  "scope.requested",
  "scope.approved",
  "candidate.created",
  "gate.started",
  "gate.finished",
  "control_review.recorded",
  "independent_review.started",
  "independent_review.finished",
  "delivery.started",
  "delivery.finished",
  "process.terminated",
  "error",
] as const;

export type LogEventName = (typeof LOG_EVENTS)[number];
export type LogLevel = "info" | "warn" | "error";

export interface ProductionLogEvent {
  readonly level: LogLevel;
  readonly event: LogEventName;
  readonly taskId?: string;
  readonly projectId?: string;
  readonly attempt?: number;
  readonly state?: string;
  readonly operation?: string;
  readonly durationMs?: number;
  readonly outcome?: "started" | "pass" | "fail" | "blocked" | "cancelled" | "committed";
  readonly errorCode?: string;
  readonly exitCode?: number;
  readonly message?: string;
  readonly toolEvents?: number;
  readonly capturedBytes?: number;
  readonly changedFiles?: number;
  readonly changedLines?: number;
}

export interface EventLogger {
  write(input: ProductionLogEvent, date?: Date): boolean;
}
