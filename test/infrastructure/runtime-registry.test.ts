import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  processIdentity,
  waitForProcessExit,
  waitForProcessIdentity,
} from "../../src/infrastructure/process/process-identity.js";
import { terminateProcessTree } from "../../src/infrastructure/process/local-process-runner.js";
import { SqliteRuntimeRegistry } from "../../src/infrastructure/sqlite/runtime-registry.js";
import { OrchestratorError } from "../../src/shared/errors.js";

void test("runtime registry persists creation identity and rejects stale PID ownership", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-runtime-registry-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  const registry = new SqliteRuntimeRegistry(path.join(temporary, "state.db"));
  try {
    const pid = child.pid;
    assert.ok(pid);
    const identity = await waitForProcessIdentity(pid);
    assert.ok(identity);
    registry.register({
      taskId: "task-runtime-0001",
      role: "worker",
      pid,
      identity,
      startedAt: new Date().toISOString(),
    });
    assert.equal(registry.get("task-runtime-0001", "worker")?.identity, identity);
    assert.equal(processIdentity(pid), identity);
    assert.throws(
      () => registry.clear("task-runtime-0001", "worker", pid, "0".repeat(64)),
      (error: unknown) =>
        error instanceof OrchestratorError && error.code === "RUNTIME_PROCESS_IDENTITY_MISMATCH",
    );
    registry.clear("task-runtime-0001", "worker", pid, identity);
    assert.equal(registry.get("task-runtime-0001", "worker"), undefined);
  } finally {
    if (child.pid) {
      terminateProcessTree(child.pid);
      await waitForProcessExit(child.pid);
    }
    registry.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
