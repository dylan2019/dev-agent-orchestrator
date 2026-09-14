import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { OrchestratorError, wrapError } from "../../shared/errors.js";

export const LOG_EVENTS = [
  "task.created",
  "state.changed",
  "lease.acquired",
  "lease.released",
  "worker.started",
  "worker.finished",
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
  readonly message?: string;
  readonly toolEvents?: number;
  readonly capturedBytes?: number;
  readonly changedFiles?: number;
  readonly changedLines?: number;
}

interface PersistedLogEvent extends ProductionLogEvent {
  readonly timestamp: string;
}

function localIsoTimestamp(date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (absolute % 60).toString().padStart(2, "0");
  return `${date.getFullYear().toString().padStart(4, "0")}-${(date.getMonth() + 1)
    .toString()
    .padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")}T${date
    .getHours()
    .toString()
    .padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}:${date
    .getSeconds()
    .toString()
    .padStart(
      2,
      "0",
    )}.${date.getMilliseconds().toString().padStart(3, "0")}${sign}${hours}:${minutes}`;
}

function redactMessage(value: string): string {
  return value
    .replace(
      /(authorization|cookie|api[-_]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED_PRIVATE_KEY]")
    .slice(0, 500);
}

export class ProductionLogger {
  private readonly previousFile: string;
  private lastEventHash: string | undefined;

  public constructor(
    private readonly file: string,
    private readonly maxBytes: number,
  ) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1_024) {
      throw new OrchestratorError("INVALID_LOG_LIMIT", "Production log limit is invalid");
    }
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
    this.previousFile = `${file}.previous`;
  }

  public write(input: ProductionLogEvent, date = new Date()): boolean {
    if (!LOG_EVENTS.includes(input.event)) {
      throw new OrchestratorError("INVALID_LOG_EVENT", "Production log event is not allowed");
    }
    const record: PersistedLogEvent = {
      timestamp: localIsoTimestamp(date),
      level: input.level,
      event: input.event,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      ...(input.state ? { state: input.state } : {}),
      ...(input.operation ? { operation: input.operation } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      ...(input.outcome ? { outcome: input.outcome } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.message ? { message: redactMessage(input.message) } : {}),
      ...(input.toolEvents !== undefined ? { toolEvents: input.toolEvents } : {}),
      ...(input.capturedBytes !== undefined ? { capturedBytes: input.capturedBytes } : {}),
      ...(input.changedFiles !== undefined ? { changedFiles: input.changedFiles } : {}),
      ...(input.changedLines !== undefined ? { changedLines: input.changedLines } : {}),
    };
    const comparable = { ...record, timestamp: undefined };
    const hash = crypto.createHash("sha256").update(JSON.stringify(comparable)).digest("hex");
    if (hash === this.lastEventHash) {
      return false;
    }
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > Math.floor(this.maxBytes / 2)) {
      throw new OrchestratorError("LOG_EVENT_TOO_LARGE", "Production log event exceeds its limit", {
        event: input.event,
        bytes,
      });
    }
    try {
      this.rotateIfRequired(bytes);
      fs.appendFileSync(this.file, line, { encoding: "utf8", mode: 0o600 });
      this.lastEventHash = hash;
      return true;
    } catch (error) {
      throw wrapError("LOG_WRITE_FAILED", "Unable to write production log", error, {
        file: this.file,
        event: input.event,
      });
    }
  }

  private rotateIfRequired(incomingBytes: number): void {
    const segmentLimit = Math.floor(this.maxBytes / 2);
    const currentBytes = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    if (currentBytes + incomingBytes <= segmentLimit) {
      return;
    }
    if (fs.existsSync(this.previousFile)) {
      fs.unlinkSync(this.previousFile);
    }
    if (fs.existsSync(this.file)) {
      fs.renameSync(this.file, this.previousFile);
    }
  }
}
