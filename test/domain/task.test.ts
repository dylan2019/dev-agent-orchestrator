import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_BUDGETS } from "../../src/domain/budgets.js";
import { DomainError } from "../../src/domain/errors.js";
import {
  approveDelivery,
  approveScope,
  completeDelivery,
  completeVerification,
  createTask,
  recordCandidate,
  recordControlReview,
  recordIndependentReview,
  requestScopeApproval,
  startImplementation,
} from "../../src/domain/task.js";
import type { TaskAggregate } from "../../src/domain/types.js";

const AT = "2026-09-14T06:00:00.000Z";
const BASE = "1".repeat(40);
const FIRST = "a".repeat(64);
const SECOND = "b".repeat(64);

function task(): TaskAggregate {
  return createTask({
    id: "task-20260914-aaaaaaaa",
    projectId: "example",
    objective: "Implement the requested production behavior",
    risk: "normal",
    budget: DEFAULT_BUDGETS.normal,
    initialScope: ["src"],
    occurredAt: AT,
  }).task;
}

void test("Task follows control review before independent review and delivery", () => {
  let current = startImplementation(task(), {
    executorId: "cursor",
    model: "implementation-model",
    occurredAt: AT,
  }).task;
  current = recordCandidate(current, {
    baseCommit: BASE,
    fingerprint: FIRST,
    changedFiles: ["src/task.ts"],
    changedLines: 20,
    occurredAt: AT,
    sessionId: "session-1",
  }).task;
  assert.equal(current.state, "VERIFYING");
  current = completeVerification(
    current,
    [{ gateId: "unit", inputHash: "hash", status: "pass", durationMs: 10 }],
    AT,
  ).task;
  assert.equal(current.state, "AWAITING_CONTROL_REVIEW");
  current = recordControlReview(current, {
    expectedCandidateFingerprint: FIRST,
    decision: "approve",
    summary: "Candidate is ready for independent review",
    occurredAt: AT,
  }).task;
  assert.equal(current.state, "INDEPENDENT_REVIEWING");
  current = recordIndependentReview(current, {
    candidateFingerprint: FIRST,
    executorId: "reviewer",
    model: "review-model",
    verdict: "pass",
    summary: "Independent review passed",
    findings: [],
    reviewedAt: AT,
  }).task;
  assert.equal(current.state, "AWAITING_FINAL_APPROVAL");
  current = approveDelivery(current, {
    expectedCandidateFingerprint: FIRST,
    idempotencyKey: "delivery:example:1",
    occurredAt: AT,
  }).task;
  current = completeDelivery(current, {
    candidateFingerprint: FIRST,
    commitHash: "2".repeat(40),
    treeHash: "3".repeat(40),
    pushed: true,
    occurredAt: AT,
  }).task;
  assert.equal(current.state, "COMMITTED");
  assert.equal(current.delivery?.status, "committed");
});

void test("scope expansion preserves the Task and appends an auditable grant", () => {
  let current = startImplementation(task(), {
    executorId: "cursor",
    model: "implementation-model",
    occurredAt: AT,
  }).task;
  current = requestScopeApproval(current, {
    requestedPaths: ["src", "config/.env.nacos.example"],
    reason: "Configuration template is part of the delivery",
    candidateFingerprint: FIRST,
    occurredAt: AT,
  }).task;
  assert.equal(current.state, "SCOPE_APPROVAL_REQUIRED");
  current = approveScope(current, {
    paths: ["src", "config/.env.nacos.example"],
    expectedCandidateFingerprint: FIRST,
    reason: "Template contains no credential values",
    occurredAt: AT,
  }).task;
  assert.equal(current.state, "REWORK_REQUIRED");
  assert.equal(current.scopeGrants.length, 2);
  const expandedGrant = current.scopeGrants[1];
  assert.ok(expandedGrant);
  assert.equal(expandedGrant.revision, 2);
  assert.equal(expandedGrant.candidateFingerprint, FIRST);
  current = startImplementation(current, {
    executorId: "cursor",
    model: "implementation-model",
    occurredAt: AT,
  }).task;
  assert.equal(current.id, "task-20260914-aaaaaaaa");
  assert.equal(current.attempts.length, 2);
  assert.equal(current.attempts[1]?.scopeRevision, 2);
});

void test("stale decisions, oversized candidates, and illegal ordering fail closed", () => {
  let current = startImplementation(task(), {
    executorId: "cursor",
    model: "implementation-model",
    occurredAt: AT,
  }).task;
  assert.throws(
    () =>
      recordCandidate(current, {
        baseCommit: BASE,
        fingerprint: FIRST,
        changedFiles: ["outside/file.ts"],
        changedLines: 1,
        occurredAt: AT,
      }),
    (error: unknown) => error instanceof DomainError && error.code === "CANDIDATE_SCOPE_VIOLATION",
  );
  current = recordCandidate(current, {
    baseCommit: BASE,
    fingerprint: FIRST,
    changedFiles: ["src/task.ts"],
    changedLines: 1,
    occurredAt: AT,
  }).task;
  assert.throws(
    () =>
      recordControlReview(current, {
        expectedCandidateFingerprint: SECOND,
        decision: "approve",
        summary: "stale",
        occurredAt: AT,
      }),
    (error: unknown) => error instanceof DomainError && error.code === "ILLEGAL_TASK_TRANSITION",
  );
  current = completeVerification(
    current,
    [{ gateId: "unit", inputHash: "hash", status: "pass", durationMs: 10 }],
    AT,
  ).task;
  assert.throws(
    () =>
      recordControlReview(current, {
        expectedCandidateFingerprint: SECOND,
        decision: "approve",
        summary: "stale",
        occurredAt: AT,
      }),
    (error: unknown) => error instanceof DomainError && error.code === "STALE_CANDIDATE_DECISION",
  );
});
