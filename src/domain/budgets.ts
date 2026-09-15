import type { ExecutionBudget, RiskLevel } from "./types.js";

const NORMAL: ExecutionBudget = {
  maxWallClockMinutes: 60,
  maxAttempts: 3,
  maxWorkerRuns: 3,
  maxReviewerRuns: 2,
  maxToolEvents: 400,
  maxCapturedBytes: 2_000_000,
  maxNoCandidateChangeMinutes: 10,
};

export const DEFAULT_BUDGETS: Readonly<Record<RiskLevel, ExecutionBudget>> = {
  normal: NORMAL,
  high: {
    ...NORMAL,
    maxWallClockMinutes: 90,
    maxToolEvents: 600,
  },
  critical: {
    ...NORMAL,
    maxWallClockMinutes: 120,
    maxReviewerRuns: 3,
    maxToolEvents: 800,
  },
};
