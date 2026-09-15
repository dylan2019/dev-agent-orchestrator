import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GateExecutor } from "../../src/application/gate-executor.js";
import type {
  CandidateFilePatch,
  CandidateInspection,
  CandidatePatch,
  CandidateRepository,
  PreparedCommit,
  ProjectGitState,
} from "../../src/application/ports/candidate-repository.js";
import type { GateCache, GateCacheEntry } from "../../src/application/ports/gate-cache.js";
import type {
  ProcessRunner,
  ProcessRunOptions,
  ProcessRunResult,
} from "../../src/application/ports/process-runner.js";
import type { ProjectProfile } from "../../src/configuration/schema.js";
import { ProductionLogger } from "../../src/infrastructure/logging/production-logger.js";
import { OrchestratorError } from "../../src/shared/errors.js";

class MemoryGateCache implements GateCache {
  private readonly entries = new Map<string, GateCacheEntry>();

  public get(cacheKey: string): GateCacheEntry | undefined {
    return this.entries.get(cacheKey);
  }

  public put(entry: GateCacheEntry): void {
    this.entries.set(entry.cacheKey, entry);
  }

  public close(): void {
    this.entries.clear();
  }
}

class FakeProcessRunner implements ProcessRunner {
  public calls = 0;
  public failAt = -1;
  public failureStderr = "";
  public readonly invocations: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
  }[] = [];

  public async run(
    _command: string,
    _args: readonly string[],
    _options: ProcessRunOptions,
  ): Promise<ProcessRunResult> {
    this.invocations.push({ command: _command, args: _args, cwd: _options.cwd });
    this.calls += 1;
    const failed = this.calls === this.failAt;
    return await Promise.resolve({
      exitCode: failed ? 1 : 0,
      stdout: "",
      stderr: failed ? this.failureStderr : "",
      stdoutBytes: 0,
      stderrBytes: failed ? Buffer.byteLength(this.failureStderr) : 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut: false,
      cancelled: false,
      durationMs: 1,
    });
  }
}

class FakeCandidateRepository implements CandidateRepository {
  public async inspect(): Promise<CandidateInspection> {
    return await Promise.resolve({
      worktreePath: "candidate",
      baseCommit: "1".repeat(40),
      fingerprint: "a".repeat(64),
      changedFiles: ["src/a.ts", "frontend/a.ts"],
      changedLines: 2,
    });
  }

  public async hashRelevantPaths(
    _worktreePath: string,
    paths?: readonly string[],
  ): Promise<string> {
    return await Promise.resolve(`hash:${paths?.join(",") ?? "all"}`);
  }

  public inspectProject(): Promise<ProjectGitState> {
    return Promise.reject(new Error("not used"));
  }

  public createWorktree(): Promise<string> {
    return Promise.reject(new Error("not used"));
  }

  public getPatch(): Promise<CandidatePatch> {
    return Promise.reject(new Error("not used"));
  }

  public getFilePatch(): Promise<CandidateFilePatch> {
    return Promise.reject(new Error("not used"));
  }

  public removeWorktree(): Promise<void> {
    return Promise.reject(new Error("not used"));
  }

  public prepareCommit(): Promise<PreparedCommit> {
    return Promise.reject(new Error("not used"));
  }

  public integrate(): Promise<void> {
    return Promise.reject(new Error("not used"));
  }
}

class MutatingCandidateRepository extends FakeCandidateRepository {
  private inspections = 0;

  public override async inspect(): Promise<CandidateInspection> {
    const inspection = await super.inspect();
    this.inspections += 1;
    return {
      ...inspection,
      fingerprint: (this.inspections === 1 ? "a" : "b").repeat(64),
    };
  }
}

function project(root: string): ProjectProfile {
  return {
    repository: root,
    targetBranch: "main",
    worktreeRoot: path.join(root, "worktrees"),
    instructionFiles: [],
    gates: {
      affected: [
        {
          id: "compile",
          command: process.execPath,
          args: ["--version"],
          dependsOn: [],
          timeoutMinutes: 1,
        },
        {
          id: "backend",
          command: process.execPath,
          args: ["--version"],
          paths: ["src"],
          dependsOn: ["compile"],
          timeoutMinutes: 1,
        },
        {
          id: "frontend",
          command: process.execPath,
          args: ["--version"],
          paths: ["frontend"],
          dependsOn: ["compile"],
          timeoutMinutes: 1,
        },
      ],
      acceptance: {
        id: "acceptance",
        command: process.execPath,
        args: ["--version"],
        dependsOn: ["backend", "frontend"],
        timeoutMinutes: 1,
      },
    },
  };
}

void test("Gate DAG executes dependencies once, caches only passing affected Gates, and never caches acceptance", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-gates-"));
  try {
    const processes = new FakeProcessRunner();
    const executor = new GateExecutor(
      processes,
      new FakeCandidateRepository(),
      new MemoryGateCache(),
      new ProductionLogger(path.join(temporary, "events.jsonl"), 64_000),
    );
    const profile = project(temporary);
    const first = await executor.runAffected("task-1", profile, temporary);
    assert.deepEqual(
      first.map((gate) => gate.gateId),
      ["compile", "backend", "frontend"],
    );
    assert.equal(processes.calls, 3);
    const second = await executor.runAffected("task-1", profile, temporary);
    assert.equal(processes.calls, 3);
    assert.equal(
      second.every((gate) => gate.cachedFromRunId !== undefined),
      true,
    );

    await executor.runAcceptance("task-1", profile, temporary);
    await executor.runAcceptance("task-1", profile, temporary);
    assert.equal(processes.calls, 5);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

void test("Gate DAG stops after the first deterministic failure", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-gate-failure-"));
  try {
    const processes = new FakeProcessRunner();
    processes.failAt = 2;
    const executor = new GateExecutor(
      processes,
      new FakeCandidateRepository(),
      new MemoryGateCache(),
      new ProductionLogger(path.join(temporary, "events.jsonl"), 64_000),
    );
    const results = await executor.runAffected("task-1", project(temporary), temporary);
    assert.deepEqual(
      results.map((gate) => gate.status),
      ["pass", "fail"],
    );
    assert.equal(processes.calls, 2);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

void test("acceptance failure keeps only its exit code and safe classification", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-acceptance-failure-"));
  try {
    const processes = new FakeProcessRunner();
    processes.failAt = 1;
    processes.failureStderr =
      "'eslint' is not recognized as an internal or external command. PRIVATE_TOKEN=do-not-log";
    const logFile = path.join(temporary, "events.jsonl");
    const executor = new GateExecutor(
      processes,
      new FakeCandidateRepository(),
      new MemoryGateCache(),
      new ProductionLogger(logFile, 64_000),
    );
    const result = await executor.runAcceptance("task-1", project(temporary), temporary);
    assert.equal(result.status, "fail");
    assert.equal(result.exitCode, 1);
    assert.equal(result.errorCode, "GATE_REQUIRED_TOOL_MISSING");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TOKEN|do-not-log|eslint/);
    const log = fs.readFileSync(logFile, "utf8");
    assert.match(log, /"exitCode":1/);
    assert.doesNotMatch(log, /PRIVATE_TOKEN|do-not-log|eslint/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

void test("setup Gates run before implementation and cannot modify the Git Candidate", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-setup-gate-"));
  try {
    const profile: ProjectProfile = {
      ...project(temporary),
      gates: {
        ...project(temporary).gates,
        setup: [
          {
            id: "dependencies",
            command: process.execPath,
            args: ["--version"],
            dependsOn: [],
            timeoutMinutes: 1,
          },
        ],
      },
    };
    const stable = new GateExecutor(
      new FakeProcessRunner(),
      new FakeCandidateRepository(),
      new MemoryGateCache(),
      new ProductionLogger(path.join(temporary, "stable.jsonl"), 64_000),
    );
    assert.equal((await stable.runSetup("task-1", profile, temporary, ["src"])).length, 1);

    const mutating = new GateExecutor(
      new FakeProcessRunner(),
      new MutatingCandidateRepository(),
      new MemoryGateCache(),
      new ProductionLogger(path.join(temporary, "mutating.jsonl"), 64_000),
    );
    await assert.rejects(
      async () => await mutating.runSetup("task-1", profile, temporary, ["src"]),
      (error: unknown) =>
        error instanceof OrchestratorError && error.code === "SETUP_MODIFIED_CANDIDATE",
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
