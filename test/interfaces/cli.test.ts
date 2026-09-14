import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ConfigFileRepository } from "../../src/configuration/file-repository.js";
import { discoverGit } from "../../src/interfaces/cli/discovery.js";
import { LocalProcessRunner } from "../../src/infrastructure/process/local-process-runner.js";

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const result = await new LocalProcessRunner().run(discoverGit(), args, {
    cwd,
    timeoutMs: 30_000,
    maxCaptureBytes: 10_000,
  });
  assert.equal(result.exitCode, 0, result.stderr);
}

void test("CLI init creates strict configuration without manual JSON editing", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-cli-"));
  const repository = path.join(temporary, "repository");
  const home = path.join(temporary, "home");
  fs.mkdirSync(repository);
  try {
    await git(repository, ["init", "-b", "main"]);
    const cli = path.resolve(
      import.meta.dirname,
      "..",
      "..",
      "src",
      "interfaces",
      "cli",
      "main.js",
    );
    const result = await new LocalProcessRunner().run(
      process.execPath,
      [
        cli,
        "init",
        repository,
        "--home",
        home,
        "--implementation-command",
        process.execPath,
        "--review-command",
        process.execPath,
        "--implementation-model",
        "implementation-model",
        "--review-model",
        "review-model",
      ],
      { cwd: temporary, timeoutMs: 30_000, maxCaptureBytes: 20_000 },
    );
    assert.equal(result.exitCode, 0, result.stderr);
    const configuration = new ConfigFileRepository(path.join(home, "config.json")).read();
    const initializedProject = configuration.projects.repository;
    assert.ok(initializedProject);
    assert.equal(configuration.defaultProject, "repository");
    assert.equal(configuration.workers.implementation?.model, "implementation-model");
    assert.equal(initializedProject.targetBranch, "main");
    assert.equal(initializedProject.gates.affected[0]?.id, "diff-check");

    const duplicate = await new LocalProcessRunner().run(
      process.execPath,
      [
        cli,
        "init",
        repository,
        "--home",
        home,
        "--implementation-command",
        process.execPath,
        "--review-command",
        process.execPath,
        "--implementation-model",
        "implementation-model",
        "--review-model",
        "review-model",
      ],
      { cwd: temporary, timeoutMs: 30_000, maxCaptureBytes: 20_000 },
    );
    assert.notEqual(duplicate.exitCode, 0);
    assert.match(duplicate.stderr, /CONFIG_ALREADY_EXISTS/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
