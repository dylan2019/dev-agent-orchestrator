import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ControlService } from "../../src/application/control-service.js";
import { DoctorService } from "../../src/application/doctor-service.js";
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
import { createTask } from "../../src/domain/task.js";
import { ProductionLogger } from "../../src/infrastructure/logging/production-logger.js";
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
  ) {}

  public async inspectProject(): Promise<ProjectGitState> {
    return await Promise.resolve({
      root: this.reportedRoot,
      branch: this.project.targetBranch,
      head: "1".repeat(40),
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
    return Promise.reject(new Error("not used"));
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
    executionProfileFingerprint: "f".repeat(64),
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
