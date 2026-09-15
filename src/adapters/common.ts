import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import type { ProjectProfile, WorkerAdapterId, WorkerProfile } from "../configuration/schema.js";
import type { TaskAggregate } from "../domain/types.js";
import type { ProcessRunner, ProcessRunResult } from "../application/ports/process-runner.js";
import type { ReviewExecutionResult, WorkerExecutionResult, WorkerProbeResult } from "./types.js";
import { OrchestratorError } from "../shared/errors.js";

export const ReviewSchema = z
  .object({
    verdict: z.enum(["PASS", "FAIL", "pass", "fail"]),
    summary: z.string().min(1).max(20_000),
    findings: z.array(z.string().min(1).max(4_000)).max(100),
  })
  .strict();

export function reviewJsonSchema(): string {
  return JSON.stringify({
    type: "object",
    additionalProperties: false,
    properties: {
      verdict: { type: "string", enum: ["PASS", "FAIL"] },
      summary: { type: "string" },
      findings: { type: "array", items: { type: "string" } },
    },
    required: ["verdict", "summary", "findings"],
  });
}

export function implementationPrompt(task: TaskAggregate, project: ProjectProfile): string {
  const scope = task.scopeGrants.at(-1);
  if (!scope) {
    throw new OrchestratorError("SCOPE_MISSING", "Task has no ScopeGrant");
  }
  return [
    "You are the fixed implementation Worker for an isolated Candidate Worktree.",
    `Task: ${task.id}`,
    `Risk: ${task.risk}`,
    `Objective: ${task.objective}`,
    `Scope revision: ${String(scope.revision)}`,
    `Authorized paths:\n${scope.paths.map((item) => `- ${item}`).join("\n")}`,
    project.instructionFiles.length > 0
      ? `Read these project instructions in order:\n${project.instructionFiles.map((item) => `- ${item}`).join("\n")}`
      : "No project instruction files are configured.",
    task.reworkReason ? `Focused rework instruction: ${task.reworkReason}` : "",
    "Do not commit, push, reset, checkout, modify .git, read credentials, or access files outside the repository.",
    "If a necessary file is outside the authorized paths, stop before modifying it and report the exact required paths.",
    "Run only focused checks needed for the implementation. The orchestrator owns configured Gates and final acceptance.",
    "Return a concise final summary with verification performed and any blocking risk.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function reviewPrompt(
  task: TaskAggregate,
  project: ProjectProfile,
  patchFile: string,
): string {
  const candidate = task.candidate;
  if (!candidate) {
    throw new OrchestratorError("CANDIDATE_MISSING", "Task has no CandidateSnapshot");
  }
  return [
    "You are the fixed independent read-only Reviewer. You must not modify files or execute state-changing commands.",
    `Task: ${task.id}`,
    `Risk: ${task.risk}`,
    `Candidate fingerprint: ${candidate.fingerprint}`,
    `Candidate context file: ${patchFile}`,
    project.instructionFiles.length > 0
      ? `Read these project instructions in order:\n${project.instructionFiles.map((item) => `- ${item}`).join("\n")}`
      : "No project instruction files are configured.",
    "Inspect the real Candidate and its context. Check correctness, ownership, security, concurrency, error semantics, missing consumers, test validity, and scope drift.",
    "Return only the required JSON object. Evidence gaps are FAIL.",
    reviewJsonSchema(),
  ].join("\n\n");
}

export async function withEphemeralFiles<T>(
  runtimeDirectory: string,
  files: Readonly<Record<string, string>>,
  action: (paths: Readonly<Record<string, string>>) => Promise<T>,
): Promise<T> {
  const directory = path.join(runtimeDirectory, `input-${crypto.randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const paths: Record<string, string> = {};
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(directory, name);
      fs.writeFileSync(target, content, { encoding: "utf8", mode: 0o600 });
      paths[name] = target;
    }
    return await action(paths);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function parseJsonLines(stdout: string): readonly Record<string, unknown>[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const normalized = line.trim();
    if (!normalized) {
      return [];
    }
    try {
      const value: unknown = JSON.parse(normalized);
      const record = asRecord(value);
      return record ? [record] : [];
    } catch {
      return [];
    }
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  for (const key of ["result", "response", "message", "text", "content", "output"]) {
    const nested = text(record[key]);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function sessionId(record: Record<string, unknown>): string | undefined {
  const result = asRecord(record.result);
  for (const value of [
    record.session_id,
    record.conversation_id,
    record.sessionId,
    record.conversationId,
    result?.session_id,
    result?.conversation_id,
  ]) {
    if (typeof value === "string" && value.length <= 200) {
      return value;
    }
  }
  return undefined;
}

function lowerToken(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.toLowerCase() : fallback;
}

export function parseExecutionResult(
  adapter: WorkerAdapterId,
  processResult: ProcessRunResult,
): WorkerExecutionResult & { readonly structured?: unknown } {
  if (processResult.timedOut) {
    throw new OrchestratorError("WORKER_TIMEOUT", "Worker exceeded its execution budget");
  }
  if (processResult.cancelled) {
    throw new OrchestratorError("WORKER_CANCELLED", "Worker execution was cancelled");
  }
  if (processResult.outputLimitExceeded) {
    throw new OrchestratorError("WORKER_OUTPUT_LIMIT", "Worker exceeded its output budget");
  }
  const records = parseJsonLines(processResult.stdout);
  const final = [...records].reverse().find((record) => {
    const type = lowerToken(record.type ?? record.event);
    return type === "result" || record.status === "success" || record.status === "SUCCESS";
  });
  if (processResult.exitCode !== 0 || !final) {
    throw new OrchestratorError(
      "WORKER_EXECUTION_FAILED",
      "Worker did not return a successful result",
      {
        adapter,
        exitCode: processResult.exitCode,
      },
    );
  }
  const nested = asRecord(final.result);
  const status = lowerToken(nested?.status ?? final.status, "success");
  if (status === "error") {
    throw new OrchestratorError("WORKER_RESULT_ERROR", "Worker returned an error result", {
      adapter,
      status,
    });
  }
  if (status === "failed" || final.is_error === true || nested?.is_error === true) {
    throw new OrchestratorError("WORKER_RESULT_FAILED", "Worker returned a failed result", {
      adapter,
      status,
    });
  }
  const summary = text(nested?.response ?? final.result ?? final.response);
  if (!summary) {
    throw new OrchestratorError("WORKER_RESULT_INVALID", "Worker result has no final summary", {
      adapter,
    });
  }
  const structured = nested?.structured_output ?? final.structured_output;
  const resolvedSessionId = sessionId(final);
  return {
    summary: summary.slice(0, 20_000),
    ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
    toolEvents: records.filter((record) =>
      ["tool_call", "tool_use"].includes(lowerToken(record.type ?? record.event)),
    ).length,
    capturedBytes: processResult.stdoutBytes + processResult.stderrBytes,
    durationMs: processResult.durationMs,
    ...(structured !== undefined ? { structured } : {}),
  };
}

export function parseReviewResult(
  adapter: WorkerAdapterId,
  processResult: ProcessRunResult,
): ReviewExecutionResult {
  const result = parseExecutionResult(adapter, processResult);
  let value: unknown = result.structured;
  if (value === undefined) {
    try {
      value = JSON.parse(result.summary) as unknown;
    } catch {
      throw new OrchestratorError("REVIEW_RESULT_INVALID", "Reviewer did not return JSON");
    }
  }
  const parsed = ReviewSchema.safeParse(value);
  if (!parsed.success) {
    throw new OrchestratorError(
      "REVIEW_RESULT_INVALID",
      "Reviewer result does not match its schema",
    );
  }
  const review = parsed.data;
  return {
    summary: review.summary,
    verdict: review.verdict.toLowerCase() as "pass" | "fail",
    findings: review.findings,
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    toolEvents: result.toolEvents,
    capturedBytes: result.capturedBytes,
    durationMs: result.durationMs,
  };
}

export async function probeCli(
  adapter: WorkerAdapterId,
  profile: WorkerProfile,
  project: ProjectProfile,
  processes: ProcessRunner,
  requiredFlags: readonly string[],
  modelCommand: readonly string[] = ["models"],
): Promise<WorkerProbeResult> {
  const baseArgs = [...profile.args];
  const [version, help, models] = await Promise.all([
    processes.run(profile.command, [...baseArgs, "--version"], {
      cwd: project.repository,
      timeoutMs: 30_000,
      maxCaptureBytes: 100_000,
    }),
    processes.run(profile.command, [...baseArgs, "--help"], {
      cwd: project.repository,
      timeoutMs: 30_000,
      maxCaptureBytes: 500_000,
    }),
    processes.run(profile.command, [...baseArgs, ...modelCommand], {
      cwd: project.repository,
      timeoutMs: 45_000,
      maxCaptureBytes: 2_000_000,
    }),
  ]);
  if (version.exitCode !== 0 || help.exitCode !== 0 || models.exitCode !== 0) {
    throw new OrchestratorError("WORKER_PROBE_FAILED", "Worker CLI probe failed", { adapter });
  }
  const helpText = `${help.stdout}\n${help.stderr}`;
  const modelText = `${models.stdout}\n${models.stderr}`;
  const missing = requiredFlags.filter((flag) => !helpText.includes(flag));
  if (missing.length > 0) {
    throw new OrchestratorError("WORKER_CAPABILITY_MISSING", "Worker CLI lacks required flags", {
      adapter,
      missing,
    });
  }
  const versionValue = /\b\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.-]+)?\b/.exec(
    `${version.stdout}\n${version.stderr}`,
  )?.[0];
  if (!versionValue) {
    throw new OrchestratorError("WORKER_VERSION_INVALID", "Worker CLI version is invalid", {
      adapter,
    });
  }
  return {
    adapter,
    version: versionValue,
    modelAvailable: modelText.toLowerCase().includes(profile.model.toLowerCase()),
    supportedFlags: requiredFlags,
  };
}
