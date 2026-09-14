import type { CandidateRepository } from "./ports/candidate-repository.js";

export interface CandidateProgressWatchdog {
  readonly signal: AbortSignal;
  readonly reason: () => string | undefined;
  readonly stop: () => void;
}

export async function startCandidateProgressWatchdog(
  candidates: CandidateRepository,
  worktreePath: string,
  budgetMs: number,
): Promise<CandidateProgressWatchdog> {
  const controller = new AbortController();
  let fingerprint = (await candidates.inspect(worktreePath)).fingerprint;
  let lastCandidateChangeAt = Date.now();
  let stopped = false;
  let busy = false;
  let blockedReason: string | undefined;
  const intervalMs = Math.min(5_000, Math.max(25, Math.floor(budgetMs / 4)));
  const timer = setInterval(() => {
    if (stopped || busy) {
      return;
    }
    busy = true;
    void candidates
      .inspect(worktreePath)
      .then((inspection) => {
        if (inspection.fingerprint !== fingerprint) {
          fingerprint = inspection.fingerprint;
          lastCandidateChangeAt = Date.now();
          return;
        }
        if (Date.now() - lastCandidateChangeAt >= budgetMs) {
          blockedReason = `Candidate fingerprint did not change within ${String(budgetMs)}ms`;
          controller.abort();
        }
      })
      .catch((error: unknown) => {
        blockedReason = `Candidate progress inspection failed: ${error instanceof Error ? error.message : String(error)}`;
        controller.abort();
      })
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  timer.unref();
  return {
    signal: controller.signal,
    reason: () => blockedReason,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
