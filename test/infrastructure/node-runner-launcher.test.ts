import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { NodeRunnerLauncher } from "../../src/infrastructure/process/node-runner-launcher.js";
import { OrchestratorError } from "../../src/shared/errors.js";

interface ExitRecord {
  readonly taskId: string;
  readonly exitCode: number | null;
  readonly stderrTail: string;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

async function removeDirectory(directory: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
    }
  }
}

void test("runner launcher reports an abnormal exit with its bounded stderr tail", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-runner-exit-"));
  const script = path.join(temporary, "failing-runner.mjs");
  fs.writeFileSync(
    script,
    'process.stderr.write("Error: Cannot find module better-sqlite3\\n");\nprocess.exit(3);\n',
    "utf8",
  );
  let launchedCount = 0;
  const exits: ExitRecord[] = [];
  const launcher = new NodeRunnerLauncher(script, temporary, {
    observer: {
      onLaunched: () => {
        launchedCount += 1;
      },
      onAbnormalExit: (taskId, exitCode, stderrTail) => {
        exits.push({ taskId, exitCode, stderrTail });
      },
    },
  });
  try {
    const pid = await launcher.launch("task-runner-exit-0001");
    assert.ok(pid > 0);
    assert.equal(launchedCount, 1);
    await waitFor(() => exits.length > 0);
    assert.equal(exits.length, 1);
    const recorded = exits[0];
    assert.ok(recorded);
    assert.equal(recorded.taskId, "task-runner-exit-0001");
    assert.equal(recorded.exitCode, 3);
    assert.match(recorded.stderrTail, /better-sqlite3/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

void test("runner launcher drains a live Runner without reporting a false failure", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-runner-alive-"));
  const script = path.join(temporary, "live-runner.mjs");
  fs.writeFileSync(
    script,
    'process.stdout.write("#".repeat(2_000_000));\nsetInterval(() => {}, 1_000);\n',
    "utf8",
  );
  let launchedPid = 0;
  const exits: ExitRecord[] = [];
  const launcher = new NodeRunnerLauncher(script, temporary, {
    observer: {
      onLaunched: (_taskId, pid) => {
        launchedPid = pid;
      },
      onAbnormalExit: (taskId, exitCode, stderrTail) => {
        exits.push({ taskId, exitCode, stderrTail });
      },
    },
  });
  try {
    const pid = await launcher.launch("task-runner-alive-001");
    assert.equal(pid, launchedPid);
    assert.ok(pid > 0);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 750);
    });
    assert.deepEqual(exits, []);
  } finally {
    if (launchedPid > 0) {
      try {
        process.kill(launchedPid);
      } catch {
        // The live Runner already exited before test cleanup.
      }
      await waitFor(() => {
        try {
          process.kill(launchedPid, 0);
          return false;
        } catch {
          return true;
        }
      });
    }
    await removeDirectory(temporary);
  }
});

void test("runner launcher rejects an invalid capture limit and a missing entrypoint", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-runner-guard-"));
  try {
    assert.throws(
      () => new NodeRunnerLauncher("runner.mjs", temporary, { maxCapturedBytes: 8 }),
      (error: unknown) =>
        error instanceof OrchestratorError && error.code === "INVALID_CAPTURE_LIMIT",
    );
    const launcher = new NodeRunnerLauncher(path.join(temporary, "absent-runner.mjs"), temporary);
    await assert.rejects(
      async () => await launcher.launch("task-runner-guard-0001"),
      (error: unknown) => error instanceof OrchestratorError && error.code === "RUNNER_NOT_BUILT",
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
