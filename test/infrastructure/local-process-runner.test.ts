import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalProcessRunner } from "../../src/infrastructure/process/local-process-runner.js";
import { OrchestratorError } from "../../src/shared/errors.js";

void test("local process runner preserves argument boundaries and bounded output", async () => {
  const runner = new LocalProcessRunner();
  const result = await runner.run(
    process.execPath,
    [
      "-e",
      'process.stdout.write("A".repeat(5000) + process.argv[1])',
      "argument with spaces & metacharacters",
    ],
    { cwd: os.tmpdir(), timeoutMs: 10_000, maxCaptureBytes: 512 },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(Buffer.byteLength(result.stdout, "utf8") <= 512, true);
  assert.match(result.stdout, /argument with spaces & metacharacters/);
});

void test("local process runner terminates a timed-out process tree", async () => {
  const runner = new LocalProcessRunner();
  const result = await runner.run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: os.tmpdir(),
    timeoutMs: 200,
    maxCaptureBytes: 512,
  });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});

void test("local process runner rejects shell-relative and batch commands", async () => {
  const runner = new LocalProcessRunner();
  await assert.rejects(
    async () =>
      await runner.run("node", ["--version"], {
        cwd: os.tmpdir(),
        timeoutMs: 1_000,
        maxCaptureBytes: 512,
      }),
    (error: unknown) => error instanceof OrchestratorError && error.code === "COMMAND_NOT_ABSOLUTE",
  );
  await assert.rejects(
    async () =>
      await runner.run(path.join(os.tmpdir(), "unsafe.cmd"), [], {
        cwd: os.tmpdir(),
        timeoutMs: 1_000,
        maxCaptureBytes: 512,
      }),
    (error: unknown) =>
      error instanceof OrchestratorError && error.code === "BATCH_COMMAND_UNSUPPORTED",
  );
});
