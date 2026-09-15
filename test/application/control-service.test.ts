import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ControlService } from "../../src/application/control-service.js";
import { DoctorService } from "../../src/application/doctor-service.js";
import { resolveExecutionBinding } from "../../src/application/execution-profile.js";
import type { WorkerAdapterRegistry } from "../../src/adapters/registry.js";
import type {
  CandidateFilePatch,
  CandidateInspection,
  CandidatePatch,
  CandidateRepository,
  PreparedCommit,
  ProjectGitState,
} from "../../src/application/ports/candidate-repository.js";
import type { RunnerLauncher } from "../../src/application/ports/runner-launcher.js";
import { ConfigFileRepository } from "../../src/configuration/file-repository.js";
import { CONFIG_VERSION, type OrchestratorConfig } from "../../src/configuration/schema.js";
import { DEFAULT_BUDGETS } from "../../src/domain/budgets.js";
import {
  approveDelivery,
  blockExternally,
  completeVerification,
  createTask,
  recordCandidate,
  recordControlReview,
  recordIndependentReview,
  requireRework,
  startImplementation,
  startIndependentReviewAttempt,
} from "../../src/domain/task.js";
import { ProductionLogger } from "../../src/infrastructure/logging/production-logger.js";
import { processIdentity } from "../../src/infrastructure/process/process-identity.js";
import { LocalProcessSupervisor } from "../../src/infrastructure/process/local-process-supervisor.js";
import { SqliteRuntimeRegistry } from "../../src/infrastructure/sqlite/runtime-registry.js";
import { SqliteTaskStore } from "../../src/infrastructure/sqlite/task-store.js";
import { OrchestratorError } from "../../src/shared/errors.js";

class FakeLauncher implements RunnerLauncher {
  public readonly launched: string[] = [];

  public async launch(taskId: string): Promise<number> {
    this.launched.push(taskId);
    return await Promise.resolve(1000 + this.launched.length);
  }
}

class FakeCandidates implements CandidateRepository {
  public constructor(
    private readonly project: OrchestratorConfig["projects"][string],
    private readonly reportedRoot = project.repository,
    private readonly candidateInspection?: CandidateInspection,
    private readonly targetHead = "1".repeat(40),
  ) {}

  public async inspectProject(): Promise<ProjectGitState> {
    return await Promise.resolve({
      root: this.reportedRoot,
      branch: this.project.targetBranch,
      head: this.targetHead,
      clean: true,
      status: "",
    });
  }

  public async createWorktree(
    _project: OrchestratorConfig["projects"][string],
    taskId: string,
  ): Promise<string> {
    const target = path.join(this.project.worktreeRoot, taskId);
    fs.mkdirSync(target, { recursive: true });
    return await Promise.resolve(target);
  }

  public inspect(): Promise<CandidateInspection> {
    return this.candidateInspection
      ? Promise.resolve(this.candidateInspection)
      : Promise.reject(new Error("not used"));
  }

  public hashRelevantPaths(): Promise<string> {
    return Promise.reject(new Error("not used"));
  }

  public getPatch(): Promise<CandidatePatch> {
    return Promise.reject(new Error("not used"));
  }

  public getFilePatch(): Promise<CandidateFilePatch> {
    return Promise.reject(new Error("not used"));
  }

  public async removeWorktree(
    _project: OrchestratorConfig["projects"][string],
    worktreePath: string,
  ): Promise<void> {
    fs.rmSync(worktreePath, { recursive: true, force: true });
    await Promise.resolve();
  }

  public prepareCommit(): Promise<PreparedCommit> {
    return Promise.reject(new Error("not used"));
  }

  public integrate(): Promise<void> {
    return Promise.reject(new Error("not used"));
  }
}

class PendingCandidates extends FakeCandidates {
  public started: (() => void) | undefined;
  public release: (() => void) | undefined;

  public override async createWorktree(
    project: OrchestratorConfig["projects"][string],
    taskId: string,
  ): Promise<string> {
    this.started?.();
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    return await super.createWorktree(project, taskId);
  }
}

function config(temporary: string): OrchestratorConfig {
  return {
    version: CONFIG_VERSION,
    defaultProject: "example",
    runtime: { gitCommand: process.execPath },
    workers: {
      implementation: {
        adapter: "cursor",
        command: process.execPath,
        args: [],
        model: "implementation-model",
        shellAllow: [],
      },
      review: {
        adapter: "antigravity",
        command: process.execPath,
        args: [],
        model: "review-model",
        shellAllow: [],
      },
    },
    routing: {
      normal: { implementation: "implementation", review: "review" },
      high: { implementation: "implementation", review: "review" },
      critical: { implementation: "implementation", review: "review" },
    },
    projects: {
      example: {
        repository: path.join(temporary, "repository"),
        targetBranch: "main",
        worktreeRoot: path.join(temporary, "worktrees"),
        instructionFiles: [],
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
      },
    },
    budgets: DEFAULT_BUDGETS,
    logging: { maxBytes: 64_000, retentionDays: 14 },
  };
}

void test("control service creates one Task with an atomic lease and rejects stale decisions", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-control-"));
  const configuration = config(temporary);
  const project = configuration.projects.example;
  assert.ok(project);
  fs.mkdirSync(project.repository, { recursive: true });
  const configRepository = new ConfigFileRepository(path.join(temporary, "config.json"));
  configRepository.write(configuration);
  const store = new SqliteTaskStore(path.join(temporary, "state.db"));
  const runtime = new SqliteRuntimeRegistry(path.join(temporary, "state.db"));
  const launcher = new FakeLauncher();
  const control = new ControlService(
    configRepository,
    store,
    new FakeCandidates(project),
    launcher,
    runtime,
    new LocalProcessSupervisor(runtime),
    new ProductionLogger(path.join(temporary, "events.jsonl"), 64_000),
  );
  try {
    const task = await control.start({
      objective: "Implement one stable production Task",
      risk: "normal",
      initialScope: ["src"],
    });
    assert.equal(task.state, "CREATED");
    assert.equal(store.writerLeaseOwner("example"), task.id);
    assert.deepEqual(launcher.launched, [task.id]);
    const observation = await control.observe(task.id);
    assert.equal(observation.changed, true);
    assert.deepEqual(observation.legalDecisions, ["cancel"]);
    await assert.rejects(
      async () =>
        await control.decide({
          action: "cancel",
          taskId: task.id,
          expectedRevision: task.revision + 1,
          reason: "stale",
        }),
      (error: unknown) =>
        error instanceof OrchestratorError && error.code === "TASK_REVISION_CONFLICT",
    );
    const startupReconciliation = await control.reconcile();
    assert.deepEqual(startupReconciliation.blockedTasks, []);
    assert.equal(control.get(task.id).state, "CREATED");
    const reconciliation = await control.reconcile(Date.now() + 60_000);
    assert.deepEqual(reconciliation.blockedTasks, [task.id]);
    const blocked = control.get(task.id);
    assert.equal(blocked.state, "EXTERNAL_BLOCKED");
    const cancelled = await control.decide({
      action: "cancel",
      taskId: task.id,
      expectedRevision: blocked.revision,
      reason: "operator cancellation",
    });
    assert.equal(cancelled.state, "CANCELLED");
    assert.equal(store.writerLeaseOwner("example"), undefined);
  } finally {
    runtime.close();
    store.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

void test("control service accepts canonical Git roots reached through a filesystem alias", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-canonical-root-"));
  const configuration = config(temporary);
  const project = configuration.projects.example;
  assert.ok(project);
  const canonicalRepository = path.join(temporary, "canonical-repository");
  fs.mkdirSync(canonicalRepository);
  fs.symlinkSync(
    canonicalRepository,
    project.repository,
    process.platform === "win32" ? "junction" : "dir",
  );
  const configRepository = new ConfigFileRepository(path.join(temporary, "config.json"));
  configRepository.write(configuration);
  const store = new SqliteTaskStore(path.join(temporary, "state.db"));
  const runtime = new SqliteRuntimeRegistry(path.join(temporary, "state.db"));
  const control = new ControlService(
    configRepository,
    store,
    new FakeCandidates(project, canonicalRepository),
    new FakeLauncher(),
    runtime,
    new LocalProcessSupervisor(runtime),
    new ProductionLogger(path.join(temporary, "events.jsonl"), 64_000),
  );
  try {
    const task = await control.start({
      objective: "Accept one canonical repository identity",
      risk: "normal",
      initialScope: ["src"],
    });
    const cancelled = await control.decide({
      action: "cancel",
      taskId: task.id,
      expectedRevision: task.revision,
      reason: "canonical root verified",
    });
    assert.equal(cancelled.state, "CANCELLED");
  } finally {
    runtime.close();
    store.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

void test("periodic reconcile does not block a Task while its Worktree is still being created", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-pending-start-"));
  const configuration = config(temporary);
  const project = configuration.projects.example;
  assert.ok(project);
  fs.mkdirSync(project.repository, { recursive: true });
  const configRepository = new ConfigFileRepository(path.join(temporary, "config.json"));
  configRepository.write(configuration);
  const store = new SqliteTaskStore(path.join(temporary, "state.db"));
  const registry = new SqliteRuntimeRegistry(path.join(temporary, "state.db"));
  const candidates = new PendingCandidates(project);
  const control = new ControlService(
    configRepository,
    store,
    candidates,
    new FakeLauncher(),
    registry,
    new LocalProcessSupervisor(registry),
    new ProductionLogger(path.join(temporary, "events.jsonl"), 64_000),
  );
  let notifyStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  candidates.started = notifyStarted;
  const start = control.start({
    objective: "Prepare a large Worktree without false process loss",
    risk: "normal",
    initialScope: ["src"],
  });
  try {
    await started;
    const pending = store.list()[0];
    assert.ok(pending);
    assert.equal(pending.state, "CREATED");
    assert.deepEqual((await control.reconcile(Date.now() + 60_000)).blockedTasks, []);
    assert.equal(store.get(pending.id).state, "CREATED");
    candidates.release?.();
    const launched = await start;
    assert.equal(launched.id, pending.id);
    assert.deepEqual((await control.reconcile(Date.now() + 60_000)).blockedTasks, [pending.id]);
    assert.equal(store.get(pending.id).state, "EXTERNAL_BLOCKED");
  } finally {
    candidates.release?.();
    await start;
    registry.close();
    store.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

void test("doctor reports a leased Task whose Candidate Worktree is missing", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-missing-worktree-"));
  const configuration = config(temporary);
  const project = configuration.projects.example;
  assert.ok(project);
  fs.mkdirSync(project.repository, { recursive: true });
  const configRepository = new ConfigFileRepository(path.join(temporary, "config.json"));
  configRepository.write(configuration);
  const store = new SqliteTaskStore(path.join(temporary, "state.db"));
  const created = createTask({
    id: "task-missing-worktree-0001",
    projectId: "example",
    objective: "Diagnose a missing leased Candidate Worktree",
    risk: "normal",
    executionProfileFingerprint: resolveExecutionBinding(
      configRepository.read(),
      "example",
      "normal",
    ).fingerprint,
    implementationWorkerId: "implementation",
    reviewWorkerId: "review",
    budget: DEFAULT_BUDGETS.normal,
    initialScope: ["src"],
    occurredAt: "2026-09-15T06:00:00.000Z",
  });
  store.createWithWriterLease(created, created.task.createdAt);
  const adapters = {
    get: () => ({
      probe: async () => await Promise.resolve({ modelAvailable: true }),
    }),
  } as unknown as WorkerAdapterRegistry;
  try {
    const doctor = new DoctorService(
      configRepository,
      new FakeCandidates(project),
      adapters,
      store,
    );
    const report = await doctor.run("example");
    assert.equal(report.ok, false);
    assert.ok(report.issues.some((issue) => issue.code === "CANDIDATE_WORKTREE_MISSING"));
  } finally {
    store.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

void test("a blocked Task releases its Project writer lease to a new Task and cannot resume afterwards", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-lease-handover-"));
  const configuration = config(temporary);
  const project = configuration.projects.example;
  assert.ok(project);
  fs.mkdirSync(project.repository, { recursive: true });
  const configRepository = new ConfigFileRepository(path.join(temporary, "config.json"));
  configRepository.write(configuration);
  const store = new SqliteTaskStore(path.join(temporary, "state.db"));
  const runtime = new SqliteRuntimeRegistry(path.join(temporary, "state.db"));
  const at = "2026-09-15T06:00:00.000Z";
  const binding = resolveExecutionBinding(configRepository.read(), "example", "normal");
  const blocked = blockExternally(
    startImplementation(
      createTask({
        id: "task-blocked-lease-0001",
        projectId: "example",
        objective: "Hold a Project writer lease while externally blocked",
        risk: "normal",
        executionProfileFingerprint: binding.fingerprint,
        implementationWorkerId: "implementation",
        reviewWorkerId: "review",
        budget: DEFAULT_BUDGETS.normal,
        initialScope: ["src"],
        occurredAt: at,
      }).task,
      { executorId: "implementation", model: "implementation-model", occurredAt: at },
    ).task,
    {
      reason: "process_lost",
      message: "Task Runner is no longer alive",
      blockedAt: at,
      resumeState: "IMPLEMENTING",
    },
  );
  store.createWithWriterLease(blocked, at);
  const control = new ControlService(
    configRepository,
    store,
    new FakeCandidates(project),
    new FakeLauncher(),
    runtime,
    new LocalProcessSupervisor(runtime),
    new ProductionLogger(path.join(temporary, "events.jsonl"), 64_000),
  );
  try {
    const started = await control.start({
      objective: "Continue work on a Project whose lease holder is blocked",
      risk: "normal",
      initialScope: ["src"],
    });
    assert.equal(store.writerLeaseOwner("example"), started.id);
    assert.equal(store.get(blocked.task.id).state, "EXTERNAL_BLOCKED");
    await assert.rejects(
      async () =>
        await control.decide({
          action: "request_rework",
          taskId: blocked.task.id,
          expectedRevision: blocked.task.revision,
          reason: "Retry the blocked Task",
        }),
      (error: unknown) =>
        error instanceof OrchestratorError && error.code === "WRITER_LEASE_UNAVAILABLE",
    );
    assert.equal(store.get(blocked.task.id).state, "EXTERNAL_BLOCKED");
  } finally {
    runtime.close();
    store.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

void test("reconcile tolerates a recently updated Task whose Runner has not registered yet", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-launch-grace-"));
  const configuration = config(temporary);
  const project = configuration.projects.example;
  assert.ok(project);
  fs.mkdirSync(project.repository, { recursive: true });
  const configRepository = new ConfigFileRepository(path.join(temporary, "config.json"));
  configRepository.write(configuration);
  const store = new SqliteTaskStore(path.join(temporary, "state.db"));
  const runtime = new SqliteRuntimeRegistry(path.join(temporary, "state.db"));
  const at = new Date().toISOString();
  const binding = resolveExecutionBinding(configRepository.read(), "example", "normal");
  const created = createTask({
    id: "task-launch-grace-0001",
    projectId: "example",
    objective: "Wait for a Runner that has not registered yet",
    risk: "normal",
    executionProfileFingerprint: binding.fingerprint,
    implementationWorkerId: "implementation",
    reviewWorkerId: "review",
    budget: DEFAULT_BUDGETS.normal,
    initialScope: ["src"],
    occurredAt: at,
  });
  store.createWithWriterLease(created, at);
  const implementing = startImplementation(created.task, {
    executorId: "implementation",
    model: "implementation-model",
    occurredAt: at,
  });
  store.save(created.task.revision, implementing);
  const control = new ControlService(
    configRepository,
    store,
    new FakeCandidates(project),
    new FakeLauncher(),
    runtime,
    new LocalProcessSupervisor(runtime),
    new ProductionLogger(path.join(temporary, "events.jsonl"), 64_000),
  );
  try {
    const reconciliation = await control.reconcile();
    assert.deepEqual(reconciliation.blockedTasks, []);
    assert.equal(store.get(created.task.id).state, "IMPLEMENTING");
    const stale = await control.reconcile(Date.now() + 60_000);
    assert.deepEqual(stale.blockedTasks, [created.task.id]);
    assert.equal(store.get(created.task.id).state, "EXTERNAL_BLOCKED");
  } finally {
    runtime.close();
    store.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

void test("a live Runner prevents a duplicate Task Runner launch", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-runner-relaunch-"));
  const configuration = config(temporary);
  const project = configuration.projects.example;
  assert.ok(project);
  fs.mkdirSync(project.repository, { recursive: true });
  const configRepository = new ConfigFileRepository(path.join(temporary, "config.json"));
  configRepository.write(configuration);
  const store = new SqliteTaskStore(path.join(temporary, "state.db"));
  const runtime = new SqliteRuntimeRegistry(path.join(temporary, "state.db"));
  const at = new Date().toISOString();
  const binding = resolveExecutionBinding(configRepository.read(), "example", "normal");
  const created = createTask({
    id: "task-runner-relaunch-01",
    projectId: "example",
    objective: "Keep one Task Runner alive across repeated decisions",
    risk: "normal",
    executionProfileFingerprint: binding.fingerprint,
    implementationWorkerId: "implementation",
    reviewWorkerId: "review",
    budget: DEFAULT_BUDGETS.normal,
    initialScope: ["src"],
    occurredAt: at,
  });
  store.createWithWriterLease(created, at);
  let current = created.task;
  const implementing = startImplementation(current, {
    executorId: "implementation",
    model: "implementation-model",
    occurredAt: at,
  });
  store.save(current.revision, implementing);
  current = implementing.task;
  const reworked = requireRework(current, {
    reason: "Worker output was incomplete",
    errorCode: "WORKER_RESULT_ERROR",
    occurredAt: at,
  });
  store.save(current.revision, reworked);
  current = reworked.task;
  const identity = processIdentity(process.pid);
  assert.ok(identity);
  runtime.register({
    taskId: current.id,
    role: "runner",
    pid: process.pid,
    identity,
    startedAt: at,
  });
  const launcher = new FakeLauncher();
  const control = new ControlService(
    configRepository,
    store,
    new FakeCandidates(project),
    launcher,
    runtime,
    new LocalProcessSupervisor(runtime),
    new ProductionLogger(path.join(temporary, "events.jsonl"), 64_000),
  );
  try {
    const repeated = await control.decide({
      action: "request_rework",
      taskId: current.id,
      expectedRevision: current.revision,
      reason: "Confirm the existing Runner keeps working",
    });
    assert.deepEqual(launcher.launched, []);
    const released = await control.decide({
      action: "request_rework",
      taskId: current.id,
      expectedRevision: repeated.revision,
      reason: "Restart the Runner after it was lost",
    });
    assert.deepEqual(launcher.launched, []);
    runtime.clear(current.id, "runner", process.pid, identity);
    await control.decide({
      action: "request_rework",
      taskId: current.id,
      expectedRevision: released.revision,
      reason: "Relaunch after the Runner record was cleared",
    });
    assert.deepEqual(launcher.launched, [current.id]);
  } finally {
    runtime.close();
    store.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

void test("cancelling a Task removes its abandoned Candidate Worktree", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cancel-worktree-"));
  const configuration = config(temporary);
  const project = configuration.projects.example;
  assert.ok(project);
  fs.mkdirSync(project.repository, { recursive: true });
  const configRepository = new ConfigFileRepository(path.join(temporary, "config.json"));
  configRepository.write(configuration);
  const store = new SqliteTaskStore(path.join(temporary, "state.db"));
  const runtime = new SqliteRuntimeRegistry(path.join(temporary, "state.db"));
  const control = new ControlService(
    configRepository,
    store,
    new FakeCandidates(project),
    new FakeLauncher(),
    runtime,
    new LocalProcessSupervisor(runtime),
    new ProductionLogger(path.join(temporary, "events.jsonl"), 64_000),
  );
  try {
    const task = await control.start({
      objective: "Create a Candidate Worktree that must not survive cancellation",
      risk: "normal",
      initialScope: ["src"],
    });
    const worktreePath = path.join(project.worktreeRoot, task.id);
    assert.equal(fs.existsSync(worktreePath), true);
    const cancelled = await control.decide({
      action: "cancel",
      taskId: task.id,
      expectedRevision: task.revision,
      reason: "abandon before implementation",
    });
    assert.equal(cancelled.state, "CANCELLED");
    assert.equal(fs.existsSync(worktreePath), false);
    assert.equal(store.writerLeaseOwner("example"), undefined);
  } finally {
    runtime.close();
    store.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

void test("delivery recovery refuses an advanced target and resumes only the unchanged approved Candidate", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-safe-delivery-resume-"));
  const at = "2026-09-15T06:00:00.000Z";
  const configuration = config(temporary);
  const project = configuration.projects.example;
  assert.ok(project);
  fs.mkdirSync(project.repository, { recursive: true });
  const configRepository = new ConfigFileRepository(path.join(temporary, "config.json"));
  configRepository.write(configuration);
  const store = new SqliteTaskStore(path.join(temporary, "state.db"));
  const runtime = new SqliteRuntimeRegistry(path.join(temporary, "state.db"));
  const fingerprint = "a".repeat(64);
  let current = createTask({
    id: "task-safe-delivery-0001",
    projectId: "example",
    objective: "Recover reviewed delivery without repeating implementation",
    risk: "normal",
    executionProfileFingerprint: resolveExecutionBinding(
      configRepository.read(),
      "example",
      "normal",
    ).fingerprint,
    implementationWorkerId: "implementation",
    reviewWorkerId: "review",
    budget: DEFAULT_BUDGETS.normal,
    initialScope: ["src"],
    occurredAt: at,
  }).task;
  current = startImplementation(current, {
    executorId: "implementation",
    model: "model",
    occurredAt: at,
  }).task;
  current = recordCandidate(current, {
    baseCommit: "1".repeat(40),
    fingerprint,
    changedFiles: ["src/a.ts"],
    changedLines: 1,
    occurredAt: at,
  }).task;
  current = completeVerification(
    current,
    [{ gateId: "unit", inputHash: "hash", status: "pass", durationMs: 1 }],
    at,
  ).task;
  current = recordControlReview(current, {
    expectedCandidateFingerprint: fingerprint,
    decision: "approve",
    summary: "Candidate verified",
    occurredAt: at,
  }).task;
  current = startIndependentReviewAttempt(current, {
    executorId: "review",
    model: "model",
    occurredAt: at,
  }).task;
  current = recordIndependentReview(current, {
    candidateFingerprint: fingerprint,
    executorId: "review",
    model: "model",
    verdict: "pass",
    summary: "Review passed",
    findings: [],
    reviewedAt: at,
  }).task;
  current = approveDelivery(current, {
    expectedCandidateFingerprint: fingerprint,
    idempotencyKey: "delivery:safe:0001",
    commitMessage: "test: safe delivery",
    push: false,
    occurredAt: at,
  }).task;
  const blocked = blockExternally(current, {
    reason: "process_lost",
    message: "Delivery Runner stopped",
    blockedAt: at,
    resumeState: "ACCEPTING",
  });
  store.createWithWriterLease(blocked, at);
  const worktreePath = path.join(project.worktreeRoot, blocked.task.id);
  fs.mkdirSync(worktreePath, { recursive: true });
  const candidate: CandidateInspection = {
    worktreePath,
    baseCommit: "1".repeat(40),
    fingerprint,
    changedFiles: ["src/a.ts"],
    changedLines: 1,
  };
  const logger = new ProductionLogger(path.join(temporary, "events.jsonl"), 64_000);
  const supervisor = new LocalProcessSupervisor(runtime);
  try {
    const unsafe = new ControlService(
      configRepository,
      store,
      new FakeCandidates(project, project.repository, candidate, "2".repeat(40)),
      new FakeLauncher(),
      runtime,
      supervisor,
      logger,
    );
    await assert.rejects(
      async () =>
        await unsafe.decide({
          action: "request_rework",
          taskId: blocked.task.id,
          expectedRevision: blocked.task.revision,
          reason: "Retry delivery",
        }),
      (error: unknown) =>
        error instanceof OrchestratorError && error.code === "DELIVERY_OUTCOME_UNKNOWN",
    );
    assert.equal(store.get(blocked.task.id).state, "EXTERNAL_BLOCKED");
    const safe = new ControlService(
      configRepository,
      store,
      new FakeCandidates(project, project.repository, candidate),
      new FakeLauncher(),
      runtime,
      supervisor,
      logger,
    );
    const resumed = await safe.decide({
      action: "request_rework",
      taskId: blocked.task.id,
      expectedRevision: blocked.task.revision,
      reason: "Retry verified delivery",
    });
    assert.equal(resumed.state, "ACCEPTING");
    assert.equal(resumed.attempts.filter((attempt) => attempt.kind === "implementation").length, 1);
    assert.equal(store.writerLeaseOwner("example"), blocked.task.id);
  } finally {
    runtime.close();
    store.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
