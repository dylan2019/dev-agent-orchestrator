import assert from "node:assert/strict";
import test from "node:test";

import { startCandidateProgressWatchdog } from "../../src/application/candidate-progress-watchdog.js";
import type {
  CandidateFilePatch,
  CandidateInspection,
  CandidatePatch,
  CandidateRepository,
  PreparedCommit,
  ProjectGitState,
} from "../../src/application/ports/candidate-repository.js";

class StaticCandidate implements CandidateRepository {
  public async inspect(): Promise<CandidateInspection> {
    return await Promise.resolve({
      worktreePath: "candidate",
      baseCommit: "1".repeat(40),
      fingerprint: "a".repeat(64),
      changedFiles: [],
      changedLines: 0,
    });
  }

  public hashRelevantPaths(): Promise<string> {
    return Promise.reject(new Error("not used"));
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

void test("Candidate watchdog aborts activity that makes no semantic progress", async () => {
  const watchdog = await startCandidateProgressWatchdog(new StaticCandidate(), "candidate", 100);
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("watchdog did not abort")), 1_000);
      watchdog.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
    });
    assert.match(watchdog.reason() ?? "", /fingerprint did not change/);
  } finally {
    watchdog.stop();
  }
});
