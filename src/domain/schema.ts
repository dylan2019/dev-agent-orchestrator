import { z } from "zod";

import { TASK_STATES, type TaskAggregate } from "./types.js";

const FingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const TimestampSchema = z.iso.datetime({ offset: true });
const BudgetSchema = z
  .object({
    maxWallClockMinutes: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    maxWorkerRuns: z.number().int().positive(),
    maxReviewerRuns: z.number().int().positive(),
    maxToolEvents: z.number().int().positive(),
    maxCapturedBytes: z.number().int().positive(),
    maxNoCandidateChangeMinutes: z.number().int().positive(),
    maxChangedFiles: z.number().int().positive(),
    maxChangedLines: z.number().int().positive(),
  })
  .strict();
const ScopeGrantSchema = z
  .object({
    revision: z.number().int().positive(),
    paths: z.array(z.string().min(1)).min(1),
    approvedBy: z.literal("codex"),
    approvedAt: TimestampSchema,
    reason: z.string().min(1),
    candidateFingerprint: FingerprintSchema.optional(),
  })
  .strict();
const ScopeRequestSchema = z
  .object({
    requestedPaths: z.array(z.string().min(1)).min(1),
    reason: z.string().min(1),
    candidateFingerprint: FingerprintSchema,
    requestedAt: TimestampSchema,
  })
  .strict();
const AttemptSchema = z
  .object({
    number: z.number().int().positive(),
    kind: z.enum(["implementation", "independent_review"]),
    executorId: z.string().min(1),
    model: z.string().min(1),
    scopeRevision: z.number().int().positive(),
    sessionId: z.string().min(1).optional(),
    status: z.enum(["running", "succeeded", "failed", "cancelled"]),
    startedAt: TimestampSchema,
    finishedAt: TimestampSchema.optional(),
    errorCode: z.string().min(1).optional(),
  })
  .strict();
const CandidateSchema = z
  .object({
    id: z.uuid(),
    baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
    fingerprint: FingerprintSchema,
    changedFiles: z.array(z.string().min(1)).min(1),
    changedLines: z.number().int().nonnegative(),
    producedByAttempt: z.number().int().positive(),
    createdAt: TimestampSchema,
  })
  .strict();
const GateResultSchema = z
  .object({
    gateId: z.string().min(1),
    inputHash: z.string().min(1),
    status: z.enum(["pass", "fail"]),
    durationMs: z.number().int().nonnegative(),
    errorCode: z.string().min(1).optional(),
    cachedFromRunId: z.string().min(1).optional(),
  })
  .strict();
const ControlReviewSchema = z
  .object({
    candidateFingerprint: FingerprintSchema,
    decision: z.enum(["approve", "rework"]),
    summary: z.string().min(1),
    reviewedAt: TimestampSchema,
  })
  .strict();
const IndependentReviewSchema = z
  .object({
    candidateFingerprint: FingerprintSchema,
    executorId: z.string().min(1),
    model: z.string().min(1),
    verdict: z.enum(["pass", "fail"]),
    summary: z.string().min(1),
    findings: z.array(z.string()),
    reviewedAt: TimestampSchema,
  })
  .strict();
const DeliverySchema = z
  .object({
    candidateFingerprint: FingerprintSchema,
    idempotencyKey: z.string().min(8),
    commitMessage: z.string().min(3).max(500),
    pushRequested: z.boolean(),
    status: z.enum(["running", "committed", "failed"]),
    startedAt: TimestampSchema,
    finishedAt: TimestampSchema.optional(),
    commitHash: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .optional(),
    treeHash: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .optional(),
    pushed: z.boolean().optional(),
    errorCode: z.string().min(1).optional(),
  })
  .strict();
const ExternalBlockSchema = z
  .object({
    reason: z.enum(["provider_capacity", "provider_rate_limit", "semantic_stall", "process_lost"]),
    message: z.string().min(1),
    blockedAt: TimestampSchema,
    resumeState: z.enum(
      TASK_STATES.filter(
        (state) => state !== "EXTERNAL_BLOCKED" && state !== "COMMITTED" && state !== "CANCELLED",
      ) as [
        (
          | "CREATED"
          | "SCOPING"
          | "IMPLEMENTING"
          | "SCOPE_APPROVAL_REQUIRED"
          | "VERIFYING"
          | "AWAITING_CONTROL_REVIEW"
          | "INDEPENDENT_REVIEWING"
          | "REWORK_REQUIRED"
          | "AWAITING_FINAL_APPROVAL"
          | "ACCEPTING"
        ),
        ...(
          | "CREATED"
          | "SCOPING"
          | "IMPLEMENTING"
          | "SCOPE_APPROVAL_REQUIRED"
          | "VERIFYING"
          | "AWAITING_CONTROL_REVIEW"
          | "INDEPENDENT_REVIEWING"
          | "REWORK_REQUIRED"
          | "AWAITING_FINAL_APPROVAL"
          | "ACCEPTING"
        )[],
      ],
    ),
  })
  .strict();

export const TaskAggregateSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{7,79}$/),
    projectId: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    objective: z.string().min(8),
    risk: z.enum(["normal", "high", "critical"]),
    executionProfileFingerprint: FingerprintSchema,
    implementationWorkerId: z.string().min(1),
    reviewWorkerId: z.string().min(1),
    state: z.enum(TASK_STATES),
    revision: z.number().int().positive(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    budget: BudgetSchema,
    scopeGrants: z.array(ScopeGrantSchema).min(1),
    attempts: z.array(AttemptSchema),
    candidate: CandidateSchema.optional(),
    scopeRequest: ScopeRequestSchema.optional(),
    gateResults: z.array(GateResultSchema).optional(),
    controlReview: ControlReviewSchema.optional(),
    independentReview: IndependentReviewSchema.optional(),
    delivery: DeliverySchema.optional(),
    externalBlock: ExternalBlockSchema.optional(),
    reworkReason: z.string().optional(),
    lastWorkerSummary: z.string().max(20_000).optional(),
  })
  .strict();

export function parseTaskAggregate(value: unknown): TaskAggregate {
  return TaskAggregateSchema.parse(value) as TaskAggregate;
}
