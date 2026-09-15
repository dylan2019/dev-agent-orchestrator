import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ProjectProfile } from "../../src/configuration/schema.js";
import { GitCandidateRepository } from "../../src/infrastructure/git/git-candidate-repository.js";
import { LocalProcessRunner } from "../../src/infrastructure/process/local-process-runner.js";
import { OrchestratorError } from "../../src/shared/errors.js";

function gitCommand(): string {
  const lookup =
    process.platform === "win32"
      ? spawnSync("C:\\Windows\\System32\\where.exe", ["git.exe"], { encoding: "utf8" })
      : spawnSync("which", ["git"], { encoding: "utf8" });
  const command = lookup.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => path.isAbsolute(value) && fs.existsSync(value));
  if (!command) {
    throw new Error("Git executable is unavailable for integration tests");
  }
  return command;
}

async function runGit(command: string, cwd: string, args: readonly string[]): Promise<void> {
  const result = await new LocalProcessRunner().run(command, args, {
    cwd,
    timeoutMs: 30_000,
    maxCaptureBytes: 10_000,
  });
  assert.equal(result.exitCode, 0, result.stderr);
}

void test("Git Candidate repository preserves fingerprints, patches, approved trees, and ff-only delivery", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-git-"));
  const repositoryPath = path.join(temporary, "repository");
  const worktreeRoot = path.join(temporary, "worktrees");
  const git = gitCommand();
  const candidates = new GitCandidateRepository(git, new LocalProcessRunner());
  const project: ProjectProfile = {
    repository: repositoryPath,
    targetBranch: "main",
    worktreeRoot,
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
  };
  let worktreePath: string | undefined;
  try {
    fs.mkdirSync(repositoryPath);
    await runGit(git, repositoryPath, ["init", "-b", "main"]);
    await runGit(git, repositoryPath, ["config", "user.name", "Candidate Test"]);
    await runGit(git, repositoryPath, ["config", "user.email", "candidate@example.invalid"]);
    fs.writeFileSync(path.join(repositoryPath, "tracked.txt"), "base\n", "utf8");
    await runGit(git, repositoryPath, ["add", "tracked.txt"]);
    await runGit(git, repositoryPath, ["commit", "-m", "test: baseline"]);

    const state = await candidates.inspectProject(project);
    assert.equal(state.clean, true);
    assert.equal(state.branch, "main");
    worktreePath = await candidates.createWorktree(project, "task-candidate-0001", state.head);
    fs.writeFileSync(path.join(worktreePath, "tracked.txt"), "changed\n", "utf8");
    fs.writeFileSync(path.join(worktreePath, "untracked.txt"), "new\nfile\n", "utf8");

    const first = await candidates.inspect(worktreePath);
    const second = await candidates.inspect(worktreePath);
    assert.deepEqual(first.changedFiles, ["tracked.txt", "untracked.txt"]);
    assert.equal(first.changedLines >= 3, true);
    assert.equal(first.fingerprint, second.fingerprint);
    const patch = await candidates.getPatch(worktreePath, 20_000);
    assert.match(patch.patch, /tracked\.txt/);
    assert.match(patch.patch, /untracked\.txt/);
    assert.equal(patch.truncated, false);
    const filePatch = await candidates.getFilePatch(worktreePath, "untracked.txt", 10_000);
    assert.match(filePatch.patch, /new/);

    const outside = path.join(temporary, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "PRIVATE_EXTERNAL_CONTENT\n", "utf8");
    const candidateWorktree = worktreePath;
    assert.ok(candidateWorktree);
    const linked = path.join(candidateWorktree, "linked");
    fs.symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
    try {
      await assert.rejects(
        async () => await candidates.inspect(candidateWorktree),
        (error: unknown) =>
          error instanceof OrchestratorError && error.code === "CANDIDATE_PATH_OUTSIDE_WORKTREE",
      );
    } finally {
      if (process.platform === "win32") {
        fs.rmdirSync(linked);
      } else {
        fs.unlinkSync(linked);
      }
    }

    const prepared = await candidates.prepareCommit(
      worktreePath,
      first.fingerprint,
      "test: candidate delivery",
    );
    await candidates.integrate(project, state.head, prepared, false);
    assert.equal((await candidates.inspectProject(project)).head, prepared.commitHash);
    await candidates.removeWorktree(project, worktreePath, false);
    worktreePath = undefined;
  } finally {
    if (worktreePath && fs.existsSync(worktreePath)) {
      await candidates.removeWorktree(project, worktreePath, true);
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

if (process.platform === "win32") {
  void test("Git Candidate checkout handles a deep repository path without system Git changes", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-longpath-"));
    const repository = path.join(temporary, "repository");
    const worktreeRoot = path.join(temporary, `worktree-root-${"w".repeat(48)}`);
    const relativeFile = path.join(
      "src",
      `segment-${"a".repeat(48)}`,
      `segment-${"b".repeat(48)}`,
      `segment-${"c".repeat(48)}`,
      "LongCandidate.java",
    );
    const git = gitCommand();
    const candidates = new GitCandidateRepository(git, new LocalProcessRunner());
    const project: ProjectProfile = {
      repository,
      targetBranch: "main",
      worktreeRoot,
      instructionFiles: [],
      gates: {
        affected: [
          {
            id: "diff-check",
            command: git,
            args: ["diff", "--check", "HEAD"],
            dependsOn: [],
            timeoutMinutes: 1,
          },
        ],
        acceptance: {
          id: "acceptance",
          command: git,
          args: ["diff", "--check", "HEAD"],
          dependsOn: ["diff-check"],
          timeoutMinutes: 1,
        },
      },
    };
    let worktreePath: string | undefined;
    try {
      fs.mkdirSync(path.dirname(path.join(repository, relativeFile)), { recursive: true });
      await runGit(git, repository, ["init", "-b", "main"]);
      await runGit(git, repository, ["config", "user.name", "Longpath Test"]);
      await runGit(git, repository, ["config", "user.email", "longpath@example.invalid"]);
      fs.writeFileSync(path.join(repository, relativeFile), "base\n", "utf8");
      await runGit(git, repository, ["-c", "core.longpaths=true", "add", "-A"]);
      await runGit(git, repository, ["-c", "core.longpaths=true", "commit", "-m", "base"]);
      await runGit(git, repository, ["config", "core.longpaths", "false"]);
      const head = (await candidates.inspectProject(project)).head;
      worktreePath = await candidates.createWorktree(project, "task-longpath-0001", head);
      assert.equal(
        fs.readFileSync(path.join(worktreePath, relativeFile), "utf8").replaceAll("\r\n", "\n"),
        "base\n",
      );
      await candidates.removeWorktree(project, worktreePath, false);
      worktreePath = undefined;
    } finally {
      if (worktreePath && fs.existsSync(worktreePath)) {
        await candidates.removeWorktree(project, worktreePath, true);
      }
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
}

void test("Git Candidate inspection tolerates a touched file whose content is unchanged", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-git-touch-"));
  const repositoryPath = path.join(temporary, "repository");
  const worktreeRoot = path.join(temporary, "worktrees");
  const git = gitCommand();
  const candidates = new GitCandidateRepository(git, new LocalProcessRunner());
  const project: ProjectProfile = {
    repository: repositoryPath,
    targetBranch: "main",
    worktreeRoot,
    instructionFiles: [],
    gates: {
      affected: [
        {
          id: "diff-check",
          command: git,
          args: ["diff", "--check", "HEAD"],
          dependsOn: [],
          timeoutMinutes: 1,
        },
      ],
      acceptance: {
        id: "acceptance",
        command: git,
        args: ["diff", "--check", "HEAD"],
        dependsOn: ["diff-check"],
        timeoutMinutes: 1,
      },
    },
  };
  let worktreePath: string | undefined;
  try {
    fs.mkdirSync(repositoryPath);
    await runGit(git, repositoryPath, ["init", "-b", "main"]);
    await runGit(git, repositoryPath, ["config", "user.name", "Touch Test"]);
    await runGit(git, repositoryPath, ["config", "user.email", "touch@example.invalid"]);
    fs.writeFileSync(path.join(repositoryPath, "README.md"), "base\n", "utf8");
    await runGit(git, repositoryPath, ["add", "-A"]);
    await runGit(git, repositoryPath, ["commit", "-m", "base"]);
    const head = (await candidates.inspectProject(project)).head;
    worktreePath = await candidates.createWorktree(project, "task-touch-0001", head);
    const largeFile = path.join(worktreePath, "large.bin");
    fs.writeFileSync(largeFile, Buffer.alloc(12_000_000, 7));
    const expected = (await candidates.inspect(worktreePath)).fingerprint;
    const toucher = setInterval(() => {
      if (!fs.existsSync(largeFile)) {
        return;
      }
      const stamp = Date.now() / 1000 + 1;
      fs.utimesSync(largeFile, stamp, stamp);
    }, 1);
    let observed: string;
    try {
      observed = (await candidates.inspect(worktreePath)).fingerprint;
    } finally {
      clearInterval(toucher);
    }
    assert.equal(observed, expected);
  } finally {
    if (worktreePath && fs.existsSync(worktreePath)) {
      await candidates.removeWorktree(project, worktreePath, true);
    }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
