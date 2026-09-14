import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AntigravityAdapter } from "../../src/adapters/antigravity.js";
import { CursorAdapter } from "../../src/adapters/cursor.js";
import { WorkerAdapterRegistry } from "../../src/adapters/registry.js";
import { WorkbuddyAdapter } from "../../src/adapters/workbuddy.js";
import { ZcodeAdapter } from "../../src/adapters/zcode.js";
import type {
  ProcessRunner,
  ProcessRunOptions,
  ProcessRunResult,
} from "../../src/application/ports/process-runner.js";
import type { ProjectProfile, WorkerProfile } from "../../src/configuration/schema.js";
import { DEFAULT_BUDGETS } from "../../src/domain/budgets.js";
import {
  completeVerification,
  createTask,
  recordCandidate,
  recordControlReview,
  startImplementation,
} from "../../src/domain/task.js";
import type { TaskAggregate } from "../../src/domain/types.js";

const AT = "2026-09-14T06:00:00.000Z";
const FINGERPRINT = "a".repeat(64);

class RecordingProcessRunner implements ProcessRunner {
  public readonly calls: {
    readonly command: string;
    readonly args: readonly string[];
    readonly options: ProcessRunOptions;
  }[] = [];

  public constructor(private readonly results: ProcessRunResult[]) {}

  public async run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions,
  ): Promise<ProcessRunResult> {
    this.calls.push({ command, args, options });
    const result = this.results.shift();
    if (!result) {
      throw new Error("No fake process result configured");
    }
    return await Promise.resolve(result);
  }
}

function result(stdout: string): ProcessRunResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    cancelled: false,
    durationMs: 10,
  };
}

function project(root: string): ProjectProfile {
  return {
    repository: root,
    targetBranch: "main",
    worktreeRoot: path.join(root, "worktrees"),
    instructionFiles: [],
    adapterProjectIds: { antigravity: "agy-project" },
    gates: {
      affected: [
        {
          id: "unit",
          command: process.execPath,
          args: ["--version"],
          dependsOn: [],
          timeoutMinutes: 1,
        },
      ],
      acceptance: {
        id: "acceptance",
        command: process.execPath,
        args: ["--version"],
        dependsOn: ["unit"],
        timeoutMinutes: 1,
      },
    },
  };
}

function worker(adapter: WorkerProfile["adapter"]): WorkerProfile {
  return {
    adapter,
    command: process.execPath,
    args: [],
    model: `${adapter}-model`,
    reasoningEffort: "high",
    shellAllow: [],
  };
}

function implementationTask(): TaskAggregate {
  return startImplementation(
    createTask({
      id: "task-20260914-adapter1",
      projectId: "example",
      objective: "Implement the requested Adapter behavior",
      risk: "normal",
      executionProfileFingerprint: "f".repeat(64),
      implementationWorkerId: "implementation",
      reviewWorkerId: "review",
      budget: DEFAULT_BUDGETS.normal,
      initialScope: ["src"],
      occurredAt: AT,
    }).task,
    { executorId: "implementation", model: "model", occurredAt: AT },
  ).task;
}

function reviewTask(): TaskAggregate {
  let task = implementationTask();
  task = recordCandidate(task, {
    baseCommit: "1".repeat(40),
    fingerprint: FINGERPRINT,
    changedFiles: ["src/file.ts"],
    changedLines: 1,
    occurredAt: AT,
  }).task;
  task = completeVerification(
    task,
    [{ gateId: "unit", inputHash: "hash", status: "pass", durationMs: 1 }],
    AT,
  ).task;
  return recordControlReview(task, {
    expectedCandidateFingerprint: FINGERPRINT,
    decision: "approve",
    summary: "Ready for review",
    occurredAt: AT,
  }).task;
}

void test("Cursor implementation uses ephemeral prompt/config and keeps only final structured result", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cursor-adapter-"));
  const stdout = [
    JSON.stringify({ type: "thinking", subtype: "delta", text: "PRIVATE_REASONING" }),
    JSON.stringify({ type: "tool_call", subtype: "started" }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: "implemented",
      session_id: "cursor-session",
    }),
  ].join("\n");
  const processes = new RecordingProcessRunner([result(stdout)]);
  try {
    const adapter = new CursorAdapter(processes);
    const execution = await adapter.implement({
      task: implementationTask(),
      project: project(temporary),
      profile: worker("cursor"),
      worktreePath: temporary,
      runtimeDirectory: temporary,
      timeoutMs: 1_000,
      maxCaptureBytes: 10_000,
    });
    assert.equal(execution.summary, "implemented");
    assert.equal(execution.sessionId, "cursor-session");
    assert.equal(execution.toolEvents, 1);
    assert.equal(processes.calls[0]?.args.includes("--force"), true);
    assert.deepEqual(
      fs.readdirSync(temporary).filter((entry) => entry.startsWith("input-")),
      [],
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

void test("Antigravity review parses native structured output without persisting patch input", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-agy-adapter-"));
  const review = { verdict: "PASS", summary: "Candidate passed", findings: [] };
  const stdout = JSON.stringify({
    event: "result",
    result: {
      status: "SUCCESS",
      response: JSON.stringify(review),
      structured_output: review,
      conversation_id: "agy-session",
    },
  });
  const processes = new RecordingProcessRunner([result(stdout)]);
  try {
    const adapter = new AntigravityAdapter(processes);
    const execution = await adapter.review({
      task: reviewTask(),
      project: project(temporary),
      profile: worker("antigravity"),
      worktreePath: temporary,
      runtimeDirectory: temporary,
      timeoutMs: 1_000,
      maxCaptureBytes: 10_000,
      candidatePatch: "PRIVATE_PATCH",
    });
    assert.equal(execution.verdict, "pass");
    assert.equal(execution.summary, "Candidate passed");
    assert.equal(execution.sessionId, "agy-session");
    const call = processes.calls[0];
    assert.ok(call);
    assert.equal(call.args.includes("agy-project"), true);
    assert.doesNotMatch(JSON.stringify(call.args), /PRIVATE_PATCH/);
    assert.deepEqual(
      fs.readdirSync(temporary).filter((entry) => entry.startsWith("input-")),
      [],
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

void test("WorkBuddy and ZCode retain independent Adapter invocation contracts", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-other-adapters-"));
  const workerResult = result(
    JSON.stringify({
      type: "result",
      status: "success",
      result: "implemented",
      session_id: "session",
    }),
  );
  try {
    const workbuddyProcesses = new RecordingProcessRunner([workerResult]);
    await new WorkbuddyAdapter(workbuddyProcesses).implement({
      task: implementationTask(),
      project: project(temporary),
      profile: worker("workbuddy"),
      worktreePath: temporary,
      runtimeDirectory: temporary,
      timeoutMs: 1_000,
      maxCaptureBytes: 10_000,
    });
    assert.equal(workbuddyProcesses.calls[0]?.args.includes("-y"), true);

    const zcodeProcesses = new RecordingProcessRunner([workerResult]);
    await new ZcodeAdapter(zcodeProcesses).implement({
      task: implementationTask(),
      project: project(temporary),
      profile: worker("zcode"),
      worktreePath: temporary,
      runtimeDirectory: temporary,
      timeoutMs: 1_000,
      maxCaptureBytes: 10_000,
    });
    assert.equal(zcodeProcesses.calls[0]?.args.includes("yolo"), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

void test("Adapter registry exposes exactly four supported products", () => {
  const ids = new WorkerAdapterRegistry(new RecordingProcessRunner([]))
    .list()
    .map((adapter) => adapter.id)
    .sort();
  assert.deepEqual(ids, ["antigravity", "cursor", "workbuddy", "zcode"]);
});
