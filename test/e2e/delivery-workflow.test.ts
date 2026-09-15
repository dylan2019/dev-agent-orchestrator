import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConfigFileRepository } from "../../src/configuration/file-repository.js";
import { CONFIG_VERSION, type OrchestratorConfig } from "../../src/configuration/schema.js";
import { DEFAULT_BUDGETS } from "../../src/domain/budgets.js";
import type { TaskAggregate, TaskState } from "../../src/domain/types.js";
import { discoverGit } from "../../src/interfaces/cli/discovery.js";
import { LocalProcessRunner } from "../../src/infrastructure/process/local-process-runner.js";
import { createControlRuntime } from "../../src/runtime/control-runtime.js";

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const result = await new LocalProcessRunner().run(discoverGit(), args, {
    cwd,
    timeoutMs: 30_000,
    maxCaptureBytes: 20_000,
  });
  assert.equal(result.exitCode, 0, result.stderr);
}

function writeWorkers(
  temporary: string,
  scopeExpansion = false,
): { implementation: string; review: string } {
  const implementation = path.join(temporary, "implementation-worker.mjs");
  const review = path.join(temporary, "review-worker.mjs");
  fs.writeFileSync(
    implementation,
    [
      'import fs from "node:fs";',
      'if (process.argv.includes("--version")) { console.log("1.0.0"); process.exit(0); }',
      'if (process.argv.includes("--help")) { console.log("--output-format --mode --model --force --add-dir"); process.exit(0); }',
      'if (process.argv.includes("models")) { console.log("implementation-model"); process.exit(0); }',
      'fs.writeFileSync("src.txt", "delivered\\n", "utf8");',
      ...(scopeExpansion
        ? ['fs.writeFileSync(".env.nacos.example", "NACOS_ENDPOINT=\\n", "utf8");']
        : []),
      'console.log(JSON.stringify({ type: "result", subtype: "success", result: "implemented candidate", session_id: "implementation-session" }));',
      "await new Promise((resolve) => setTimeout(resolve, 500));",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    review,
    [
      'if (process.argv.includes("--version")) { console.log("1.0.0"); process.exit(0); }',
      'if (process.argv.includes("--help")) { console.log("--input-format --output-format --json-schema --project --model --dangerously-skip-permissions --add-dir"); process.exit(0); }',
      'if (process.argv.includes("models")) { console.log("review-model"); process.exit(0); }',
      "for await (const chunk of process.stdin) { void chunk; }",
      'const review = { verdict: "PASS", summary: "independent review passed", findings: [] };',
      'console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: JSON.stringify(review), structured_output: review, conversation_id: "review-session" } }));',
      "await new Promise((resolve) => setTimeout(resolve, 500));",
    ].join("\n"),
    "utf8",
  );
  return { implementation, review };
}

function config(
  temporary: string,
  repository: string,
  workers: { implementation: string; review: string },
): OrchestratorConfig {
  const route = { implementation: "implementation", review: "review" };
  return {
    version: CONFIG_VERSION,
    defaultProject: "example",
    runtime: { gitCommand: discoverGit() },
    workers: {
      implementation: {
        adapter: "cursor",
        command: process.execPath,
        args: [workers.implementation],
        model: "implementation-model",
        shellAllow: [],
      },
      review: {
        adapter: "antigravity",
        command: process.execPath,
        args: [workers.review],
        model: "review-model",
        shellAllow: [],
      },
    },
    routing: { normal: route, high: route, critical: route },
    projects: {
      example: {
        repository,
        targetBranch: "main",
        worktreeRoot: path.join(temporary, "worktrees"),
        instructionFiles: [],
        gates: {
          affected: [
            {
              id: "affected",
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
            dependsOn: ["affected"],
            timeoutMinutes: 1,
          },
        },
      },
    },
    budgets: DEFAULT_BUDGETS,
    logging: { maxBytes: 128_000, retentionDays: 7 },
  };
}

async function waitForState(
  observe: (revision: number) => Promise<{ readonly task: TaskAggregate }>,
  task: TaskAggregate,
  expected: TaskState,
  diagnostics?: () => unknown,
): Promise<TaskAggregate> {
  let current = task;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const observation = await observe(current.revision);
    current = observation.task;
    if (current.state === expected) {
      return current;
    }
    if (["REWORK_REQUIRED", "EXTERNAL_BLOCKED", "CANCELLED", "EXHAUSTED"].includes(current.state)) {
      throw new Error(
        `Task entered ${current.state}: ${current.reworkReason ?? current.externalBlock?.message ?? "unknown"}`,
      );
    }
  }
  throw new Error(
    `Task did not enter ${expected}; current state is ${current.state}; diagnostics=${JSON.stringify(diagnostics?.() ?? null)}`,
  );
}

void test("clean public workflow delivers one Task without Candidate replay or noisy logs", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-e2e-"));
  const repository = path.join(temporary, "repository");
  const home = path.join(temporary, "home");
  fs.mkdirSync(repository);
  let runtime: ReturnType<typeof createControlRuntime> | undefined;
  let task: TaskAggregate | undefined;
  try {
    await git(repository, ["init", "-b", "main"]);
    await git(repository, ["config", "user.name", "Orchestrator E2E"]);
    await git(repository, ["config", "user.email", "orchestrator@example.invalid"]);
    fs.writeFileSync(path.join(repository, "README.md"), "base\n", "utf8");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "test: baseline"]);
    const workers = writeWorkers(temporary);
    new ConfigFileRepository(path.join(home, "config.json")).write(
      config(temporary, repository, workers),
    );
    const runnerFile = path.resolve(
      import.meta.dirname,
      "..",
      "..",
      "src",
      "interfaces",
      "runner",
      "main.js",
    );
    const activeRuntime = createControlRuntime(runnerFile, home);
    runtime = activeRuntime;
    task = await activeRuntime.control.start({
      objective: "Create one delivered source file through the production workflow",
      risk: "normal",
      initialScope: ["src.txt"],
    });
    const taskIdValue = task.id;
    task = await waitForState(
      async (revision) => await activeRuntime.control.observe(taskIdValue, revision, 5_000),
      task,
      "AWAITING_CONTROL_REVIEW",
      () => ({
        task: activeRuntime.control.get(taskIdValue),
        runtime: activeRuntime.components.runtimeRegistry.list(taskIdValue),
        events: fs.existsSync(path.join(home, "logs", "events.jsonl"))
          ? fs.readFileSync(path.join(home, "logs", "events.jsonl"), "utf8")
          : "missing",
      }),
    );
    assert.equal(task.attempts.filter((attempt) => attempt.kind === "implementation").length, 1);
    const candidate = task.candidate;
    assert.ok(candidate);
    assert.equal(candidate.changedFiles.length, 1);
    task = await activeRuntime.control.decide({
      action: "approve_candidate",
      taskId: task.id,
      expectedRevision: task.revision,
      expectedFingerprint: candidate.fingerprint,
      summary: "Codex verified the bounded Candidate",
    });
    task = await waitForState(
      async (revision) => await activeRuntime.control.observe(taskIdValue, revision, 5_000),
      task,
      "AWAITING_FINAL_APPROVAL",
    );
    assert.equal(task.independentReview?.verdict, "pass");
    task = await activeRuntime.control.decide({
      action: "approve_delivery",
      taskId: task.id,
      expectedRevision: task.revision,
      expectedFingerprint: task.candidate?.fingerprint ?? "",
      commitMessage: "feat: deliver e2e candidate",
      push: false,
      idempotencyKey: `delivery:${task.id}`,
    });
    task = await waitForState(
      async (revision) => await activeRuntime.control.observe(taskIdValue, revision, 5_000),
      task,
      "COMMITTED",
    );
    assert.equal(
      fs.readFileSync(path.join(repository, "src.txt"), "utf8").replaceAll("\r\n", "\n"),
      "delivered\n",
    );
    assert.equal(activeRuntime.components.store.writerLeaseOwner("example"), undefined);
    const registryDeadline = Date.now() + 5_000;
    while (
      activeRuntime.components.runtimeRegistry.list(task.id).length > 0 &&
      Date.now() < registryDeadline
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    assert.deepEqual(activeRuntime.components.runtimeRegistry.list(task.id), []);
    assert.equal(fs.existsSync(path.join(temporary, "worktrees", task.id)), false);
    const log = fs.readFileSync(path.join(home, "logs", "events.jsonl"), "utf8");
    assert.match(log, /"event":"delivery.finished"/);
    assert.doesNotMatch(
      log,
      /Create one delivered|implemented candidate|PRIVATE|thinking|assistant/,
    );
  } finally {
    if (
      runtime &&
      task &&
      task.state !== "COMMITTED" &&
      task.state !== "CANCELLED" &&
      task.state !== "EXHAUSTED"
    ) {
      try {
        const current = runtime.control.get(task.id);
        await runtime.control.decide({
          action: "cancel",
          taskId: current.id,
          expectedRevision: current.revision,
          reason: "test cleanup",
        });
      } catch {
        // The temporary directory cleanup remains bounded to the test root.
      }
    }
    runtime?.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    fs.rmSync(temporary, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
});

void test("scope expansion continues one Task and releases its lease when attempts exhaust", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-scope-e2e-"));
  const repository = path.join(temporary, "repository");
  const home = path.join(temporary, "home");
  fs.mkdirSync(repository);
  let runtime: ReturnType<typeof createControlRuntime> | undefined;
  let task: TaskAggregate | undefined;
  try {
    await git(repository, ["init", "-b", "main"]);
    await git(repository, ["config", "user.name", "Scope E2E"]);
    await git(repository, ["config", "user.email", "scope@example.invalid"]);
    fs.writeFileSync(path.join(repository, "README.md"), "base\n", "utf8");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "test: baseline"]);
    const workers = writeWorkers(temporary, true);
    const profile = config(temporary, repository, workers);
    new ConfigFileRepository(path.join(home, "config.json")).write({
      ...profile,
      budgets: {
        ...profile.budgets,
        normal: { ...profile.budgets.normal, maxAttempts: 2, maxWorkerRuns: 2 },
      },
    });
    const runnerFile = path.resolve(
      import.meta.dirname,
      "..",
      "..",
      "src",
      "interfaces",
      "runner",
      "main.js",
    );
    const activeRuntime = createControlRuntime(runnerFile, home);
    runtime = activeRuntime;
    task = await activeRuntime.control.start({
      objective: "Expand authorization without replacing the Task or Candidate",
      risk: "normal",
      initialScope: ["src.txt"],
    });
    const taskIdValue = task.id;
    task = await waitForState(
      async (revision) => await activeRuntime.control.observe(taskIdValue, revision, 5_000),
      task,
      "SCOPE_APPROVAL_REQUIRED",
    );
    const candidate = await activeRuntime.control.candidate(task.id, "manifest", 10_000);
    assert.deepEqual(candidate.changedFiles, [".env.nacos.example", "src.txt"]);
    const originalTaskId = task.id;
    task = await activeRuntime.control.decide({
      action: "approve_scope",
      taskId: task.id,
      expectedRevision: task.revision,
      expectedFingerprint: candidate.fingerprint,
      paths: ["src.txt", ".env.nacos.example"],
      reason: "Template is an explicit credential-free delivery artifact",
    });
    task = await waitForState(
      async (revision) => await activeRuntime.control.observe(taskIdValue, revision, 5_000),
      task,
      "AWAITING_CONTROL_REVIEW",
    );
    assert.equal(task.id, originalTaskId);
    assert.equal(task.scopeGrants.length, 2);
    assert.equal(task.attempts.filter((attempt) => attempt.kind === "implementation").length, 2);
    task = await activeRuntime.control.decide({
      action: "request_rework",
      taskId: task.id,
      expectedRevision: task.revision,
      reason: "Check bounded retry after two implementation Attempts",
    });
    task = await waitForState(
      async (revision) => await activeRuntime.control.observe(taskIdValue, revision, 5_000),
      task,
      "EXHAUSTED",
    );
    assert.equal(activeRuntime.components.store.writerLeaseOwner("example"), undefined);
    assert.equal(fs.existsSync(path.join(temporary, "worktrees", task.id)), true);
    assert.equal(task.attempts.filter((attempt) => attempt.kind === "implementation").length, 2);
  } finally {
    if (
      runtime &&
      task &&
      task.state !== "COMMITTED" &&
      task.state !== "CANCELLED" &&
      task.state !== "EXHAUSTED"
    ) {
      try {
        const current = runtime.control.get(task.id);
        await runtime.control.decide({
          action: "cancel",
          taskId: current.id,
          expectedRevision: current.revision,
          reason: "test cleanup",
        });
      } catch {
        // The temporary directory cleanup remains bounded to the test root.
      }
    }
    runtime?.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
