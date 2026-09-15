import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ProjectProfile } from "../../configuration/schema.js";
import {
  normalizeAuthorizedPath,
  normalizeAuthorizedPaths,
  pathIsCovered,
} from "../../domain/scope.js";
import type {
  CandidateFilePatch,
  CandidateInspection,
  CandidatePatch,
  CandidateRepository,
  PreparedCommit,
  ProjectGitState,
} from "../../application/ports/candidate-repository.js";
import type { ProcessRunner, ProcessRunResult } from "../../application/ports/process-runner.js";
import { OrchestratorError } from "../../shared/errors.js";

const MAX_GIT_OUTPUT = 4_000_000;
const MAX_CANDIDATE_FILES = 10_000;
const MAX_FILE_BYTES = 256_000_000;
const MAX_TOTAL_BYTES = 1_000_000_000;

function comparable(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(comparable(root), comparable(candidate));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function assertComplete(result: ProcessRunResult, operation: string): void {
  if (result.stdoutTruncated || result.stderrTruncated) {
    throw new OrchestratorError("GIT_OUTPUT_TRUNCATED", "Git output exceeded its safe limit", {
      operation,
    });
  }
}

async function hashFile(hash: crypto.Hash, file: string): Promise<number> {
  const before = fs.lstatSync(file);
  hash.update(`mode:${String(before.mode)}\0`);
  if (before.isSymbolicLink()) {
    hash.update(`link:${fs.readlinkSync(file)}\0`);
    return 0;
  }
  if (!before.isFile()) {
    throw new OrchestratorError(
      "CANDIDATE_FILE_TYPE_UNSUPPORTED",
      "Candidate file type is unsupported",
      {
        file,
      },
    );
  }
  if (before.size > MAX_FILE_BYTES) {
    throw new OrchestratorError(
      "CANDIDATE_FILE_TOO_LARGE",
      "Candidate file exceeds its byte limit",
      {
        file,
        bytes: before.size,
      },
    );
  }
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk: string | Buffer) => {
      hash.update(chunk);
    });
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  const after = fs.lstatSync(file);
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.mode !== after.mode
  ) {
    throw new OrchestratorError(
      "CANDIDATE_CHANGED_DURING_INSPECTION",
      "Candidate changed while its fingerprint was calculated",
      { file },
    );
  }
  return before.size;
}

async function countFileLines(file: string): Promise<number> {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) {
    return 1;
  }
  let lines = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on("data", (chunk: string | Buffer) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      for (const byte of buffer) {
        if (byte === 10) {
          lines += 1;
        }
      }
    });
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return stat.size > 0 ? Math.max(1, lines) : 0;
}

export class GitCandidateRepository implements CandidateRepository {
  public constructor(
    private readonly gitCommand: string,
    private readonly processes: ProcessRunner,
  ) {}

  public async inspectProject(project: ProjectProfile): Promise<ProjectGitState> {
    const [root, branch, head, status] = await Promise.all([
      this.git(project.repository, ["rev-parse", "--show-toplevel"]),
      this.git(project.repository, ["branch", "--show-current"]),
      this.git(project.repository, ["rev-parse", "HEAD"]),
      this.git(project.repository, ["status", "--porcelain=v1", "--untracked-files=all"]),
    ]);
    const normalizedStatus = status.stdout.trim();
    return {
      root: root.stdout.trim(),
      branch: branch.stdout.trim(),
      head: head.stdout.trim(),
      clean: normalizedStatus.length === 0,
      status: normalizedStatus,
    };
  }

  public async createWorktree(
    project: ProjectProfile,
    taskId: string,
    baseCommit: string,
  ): Promise<string> {
    fs.mkdirSync(project.worktreeRoot, { recursive: true });
    const worktreePath = path.resolve(project.worktreeRoot, taskId);
    if (
      !isWithin(project.worktreeRoot, worktreePath) ||
      comparable(worktreePath) === comparable(project.worktreeRoot)
    ) {
      throw new OrchestratorError("WORKTREE_PATH_UNSAFE", "Candidate Worktree path is unsafe", {
        worktreePath,
      });
    }
    if (fs.existsSync(worktreePath)) {
      throw new OrchestratorError("WORKTREE_ALREADY_EXISTS", "Candidate Worktree already exists", {
        worktreePath,
      });
    }
    await this.git(project.repository, ["worktree", "add", "--detach", worktreePath, baseCommit]);
    return worktreePath;
  }

  public async inspect(worktreePath: string): Promise<CandidateInspection> {
    const [base, tracked, untracked, numstat] = await Promise.all([
      this.git(worktreePath, ["rev-parse", "HEAD"]),
      this.git(worktreePath, ["diff", "--no-renames", "--name-only", "-z", "HEAD"]),
      this.git(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]),
      this.git(worktreePath, ["diff", "--no-renames", "--numstat", "HEAD"]),
    ]);
    for (const [operation, result] of [
      ["changed tracked files", tracked],
      ["changed untracked files", untracked],
      ["candidate numstat", numstat],
    ] as const) {
      assertComplete(result, operation);
    }
    const trackedFiles = tracked.stdout.split("\0").filter(Boolean);
    const untrackedFiles = untracked.stdout.split("\0").filter(Boolean);
    const changedFiles = [...new Set([...trackedFiles, ...untrackedFiles])].sort();
    if (changedFiles.length > MAX_CANDIDATE_FILES) {
      throw new OrchestratorError(
        "CANDIDATE_FILE_LIMIT",
        "Candidate file count exceeds its limit",
        {
          changedFiles: changedFiles.length,
        },
      );
    }
    const hash = crypto.createHash("sha256");
    hash.update("dev-agent-candidate-v1\0");
    hash.update(base.stdout.trim());
    let totalBytes = 0;
    for (const file of changedFiles) {
      hash.update(`\0path:${file}\0`);
      const absolute = path.resolve(worktreePath, file);
      if (!isWithin(worktreePath, absolute)) {
        throw new OrchestratorError(
          "CANDIDATE_PATH_OUTSIDE_WORKTREE",
          "Candidate path escaped Worktree",
          {
            file,
          },
        );
      }
      if (!fs.existsSync(absolute)) {
        hash.update("deleted");
        continue;
      }
      totalBytes += await hashFile(hash, absolute);
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new OrchestratorError(
          "CANDIDATE_TOTAL_SIZE_LIMIT",
          "Candidate exceeds its total byte limit",
        );
      }
    }
    let changedLines = numstat.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .reduce((sum, line) => {
        const [added, deleted] = line.split("\t");
        return (
          sum +
          (added === "-" ? 1 : Number(added ?? 0)) +
          (deleted === "-" ? 1 : Number(deleted ?? 0))
        );
      }, 0);
    for (const file of untrackedFiles) {
      const absolute = path.resolve(worktreePath, file);
      if (fs.existsSync(absolute)) {
        changedLines += await countFileLines(absolute);
      }
    }
    return {
      worktreePath,
      baseCommit: base.stdout.trim(),
      fingerprint: hash.digest("hex"),
      changedFiles,
      changedLines,
    };
  }

  public async getPatch(worktreePath: string, maxChars: number): Promise<CandidatePatch> {
    this.assertPatchLimit(maxChars);
    const inspection = await this.inspect(worktreePath);
    const tracked = await this.git(
      worktreePath,
      ["diff", "--binary", "HEAD"],
      true,
      maxChars + 1,
      "head",
    );
    let patch = tracked.stdout;
    if (!tracked.stdoutTruncated && patch.length <= maxChars) {
      const untracked = await this.untrackedFiles(worktreePath);
      for (const file of untracked) {
        const remaining = maxChars + 1 - patch.length;
        if (remaining <= 0) {
          break;
        }
        const filePatch = await this.git(
          worktreePath,
          ["diff", "--no-index", "--binary", "--", "/dev/null", file],
          true,
          remaining,
          "head",
        );
        patch += filePatch.stdout;
        if (filePatch.stdoutTruncated) {
          break;
        }
      }
    }
    const truncated = tracked.stdoutTruncated || patch.length > maxChars;
    return { ...inspection, patch: truncated ? patch.slice(0, maxChars) : patch, truncated };
  }

  public async hashRelevantPaths(worktreePath: string, paths?: readonly string[]): Promise<string> {
    const inspection = await this.inspect(worktreePath);
    const selectors = paths ? normalizeAuthorizedPaths(paths) : undefined;
    const files = selectors
      ? inspection.changedFiles.filter((file) => pathIsCovered(file, selectors))
      : inspection.changedFiles;
    const hash = crypto.createHash("sha256");
    hash.update("dev-agent-gate-input-v1\0");
    hash.update(inspection.baseCommit);
    hash.update(`\0selectors:${selectors?.join("\0") ?? "all"}\0`);
    for (const file of files) {
      hash.update(`path:${file}\0`);
      const absolute = path.resolve(worktreePath, file);
      if (!fs.existsSync(absolute)) {
        hash.update("deleted\0");
      } else {
        await hashFile(hash, absolute);
      }
    }
    return hash.digest("hex");
  }

  public async getFilePatch(
    worktreePath: string,
    file: string,
    maxChars: number,
  ): Promise<CandidateFilePatch> {
    this.assertPatchLimit(maxChars);
    const normalized = normalizeAuthorizedPath(file);
    const inspection = await this.inspect(worktreePath);
    if (!inspection.changedFiles.includes(normalized)) {
      throw new OrchestratorError(
        "CANDIDATE_FILE_NOT_CHANGED",
        "File is not part of the Candidate",
        {
          file: normalized,
        },
      );
    }
    const tracked = await this.git(
      worktreePath,
      ["ls-files", "--error-unmatch", "--", normalized],
      true,
    );
    const result =
      tracked.exitCode === 0
        ? await this.git(
            worktreePath,
            ["diff", "--binary", "HEAD", "--", normalized],
            false,
            maxChars + 1,
            "head",
          )
        : await this.git(
            worktreePath,
            ["diff", "--no-index", "--binary", "--", "/dev/null", normalized],
            true,
            maxChars + 1,
            "head",
          );
    if (tracked.exitCode !== 0 && result.exitCode !== 0 && result.exitCode !== 1) {
      throw new OrchestratorError("CANDIDATE_FILE_PATCH_FAILED", "Unable to create file patch", {
        file: normalized,
      });
    }
    const truncated = result.stdoutTruncated || result.stdout.length > maxChars;
    return {
      worktreePath,
      fingerprint: inspection.fingerprint,
      file: normalized,
      patch: truncated ? result.stdout.slice(0, maxChars) : result.stdout,
      truncated,
    };
  }

  public async removeWorktree(
    project: ProjectProfile,
    worktreePath: string,
    discardChanges: boolean,
  ): Promise<void> {
    const resolved = path.resolve(worktreePath);
    if (
      !isWithin(project.worktreeRoot, resolved) ||
      comparable(resolved) === comparable(project.worktreeRoot)
    ) {
      throw new OrchestratorError("WORKTREE_REMOVAL_UNSAFE", "Worktree removal path is unsafe");
    }
    await this.git(project.repository, [
      "worktree",
      "remove",
      ...(discardChanges ? ["--force"] : []),
      resolved,
    ]);
  }

  public async prepareCommit(
    worktreePath: string,
    expectedFingerprint: string,
    message: string,
  ): Promise<PreparedCommit> {
    const before = await this.inspect(worktreePath);
    if (before.fingerprint !== expectedFingerprint) {
      throw new OrchestratorError(
        "CANDIDATE_CHANGED_BEFORE_COMMIT",
        "Candidate fingerprint changed",
      );
    }
    await this.git(worktreePath, ["add", "-A"]);
    const check = await this.git(worktreePath, ["diff", "--cached", "--check"], true);
    if (check.exitCode !== 0) {
      throw new OrchestratorError("STAGED_DIFF_INVALID", "Staged Candidate failed diff validation");
    }
    const afterStage = await this.inspect(worktreePath);
    if (afterStage.fingerprint !== expectedFingerprint) {
      throw new OrchestratorError(
        "CANDIDATE_CHANGED_DURING_STAGE",
        "Candidate changed while staging",
      );
    }
    const tree = await this.git(worktreePath, ["write-tree"]);
    await this.git(worktreePath, ["commit", "--no-verify", "-m", message.trim()]);
    const commit = await this.git(worktreePath, ["rev-parse", "HEAD"]);
    const committedTree = await this.git(worktreePath, ["rev-parse", "HEAD^{tree}"]);
    if (committedTree.stdout.trim() !== tree.stdout.trim()) {
      throw new OrchestratorError(
        "COMMITTED_TREE_MISMATCH",
        "Committed tree differs from approved tree",
      );
    }
    return { commitHash: commit.stdout.trim(), treeHash: committedTree.stdout.trim() };
  }

  public async integrate(
    project: ProjectProfile,
    expectedBaseCommit: string,
    prepared: PreparedCommit,
    push: boolean,
  ): Promise<void> {
    const state = await this.inspectProject(project);
    if (!state.clean || state.branch !== project.targetBranch) {
      throw new OrchestratorError(
        "TARGET_NOT_READY",
        "Target Worktree is not clean on its configured branch",
        {
          branch: state.branch,
          clean: state.clean,
        },
      );
    }
    if (state.head !== prepared.commitHash && state.head !== expectedBaseCommit) {
      throw new OrchestratorError(
        "TARGET_HEAD_MOVED",
        "Target branch advanced beyond Candidate base",
        {
          expectedBaseCommit,
          actual: state.head,
        },
      );
    }
    if (state.head !== prepared.commitHash) {
      await this.git(project.repository, ["merge", "--ff-only", prepared.commitHash]);
    }
    if (push) {
      await this.git(project.repository, ["push", "origin", project.targetBranch]);
    }
  }

  private async untrackedFiles(worktreePath: string): Promise<readonly string[]> {
    const result = await this.git(worktreePath, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    assertComplete(result, "untracked files");
    return result.stdout.split("\0").filter(Boolean).sort();
  }

  private assertPatchLimit(maxChars: number): void {
    if (!Number.isInteger(maxChars) || maxChars < 1_000 || maxChars > 1_000_000) {
      throw new OrchestratorError("INVALID_PATCH_LIMIT", "Patch character limit is invalid");
    }
  }

  private async git(
    cwd: string,
    args: readonly string[],
    allowFailure = false,
    maxCaptureBytes = MAX_GIT_OUTPUT,
    captureMode: "head" | "tail" = "tail",
  ): Promise<ProcessRunResult> {
    const gitArgs = process.platform === "win32" ? ["-c", "core.longpaths=true", ...args] : args;
    const result = await this.processes.run(this.gitCommand, gitArgs, {
      cwd,
      timeoutMs: 60_000,
      maxCaptureBytes,
      captureMode,
    });
    if (!allowFailure && (result.exitCode !== 0 || result.timedOut || result.cancelled)) {
      throw new OrchestratorError("GIT_COMMAND_FAILED", "Git command failed", {
        operation: args[0] ?? "unknown",
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      });
    }
    return result;
  }
}
