import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { DEFAULT_BUDGETS } from "../../src/domain/budgets.js";
import { createTask, startImplementation, startScoping } from "../../src/domain/task.js";
import { SqliteTaskStore } from "../../src/infrastructure/sqlite/task-store.js";
import { OrchestratorError } from "../../src/shared/errors.js";

const AT = "2026-09-14T06:00:00.000Z";

function created(
  id = "task-20260914-persist1",
  objective = "Persist a production Task transition",
) {
  return createTask({
    id,
    projectId: "example",
    objective,
    risk: "normal",
    executionProfileFingerprint: "f".repeat(64),
    implementationWorkerId: "implementation",
    reviewWorkerId: "review",
    budget: DEFAULT_BUDGETS.normal,
    initialScope: ["src"],
    occurredAt: AT,
  });
}

void test("SQLite store atomically persists transitions and rejects stale revisions", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-store-"));
  const databaseFile = path.join(temporary, "state.db");
  const store = new SqliteTaskStore(databaseFile);
  try {
    const initial = created();
    store.create(initial);
    const implementation = startImplementation(initial.task, {
      executorId: "cursor",
      model: "implementation-model",
      occurredAt: AT,
    });
    store.save(initial.task.revision, implementation);
    assert.equal(store.get(initial.task.id).state, "IMPLEMENTING");
    assert.throws(
      () => store.save(initial.task.revision, startScoping(initial.task, AT)),
      (error: unknown) =>
        error instanceof OrchestratorError && error.code === "TASK_REVISION_CONFLICT",
    );
  } finally {
    store.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

void test("SQLite store rebuilds a missing Task snapshot from append-only events", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-rebuild-"));
  const databaseFile = path.join(temporary, "state.db");
  try {
    const store = new SqliteTaskStore(databaseFile);
    const initial = created();
    store.create(initial);
    const scoping = startScoping(initial.task, AT);
    store.save(initial.task.revision, scoping);
    store.close();

    const raw = new Database(databaseFile);
    const eventCount = raw.prepare("SELECT COUNT(*) AS count FROM task_events").get() as {
      readonly count: number;
    };
    assert.equal(eventCount.count, 2);
    raw.prepare("DELETE FROM tasks").run();
    raw.close();

    const recovered = new SqliteTaskStore(databaseFile);
    assert.equal(recovered.get(initial.task.id).state, "SCOPING");
    assert.equal(recovered.get(initial.task.id).revision, 2);
    recovered.close();
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

void test("SQLite writer lease is unique and ownership-checked across store instances", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-lease-"));
  const databaseFile = path.join(temporary, "state.db");
  const first = new SqliteTaskStore(databaseFile);
  const second = new SqliteTaskStore(databaseFile);
  try {
    first.acquireWriterLease("example", "task-owner-0001", AT);
    assert.equal(second.writerLeaseOwner("example"), "task-owner-0001");
    assert.throws(
      () => second.acquireWriterLease("example", "task-owner-0002", AT),
      (error: unknown) => error instanceof OrchestratorError && error.code === "WRITER_LEASE_BUSY",
    );
    assert.throws(
      () => second.releaseWriterLease("example", "task-owner-0002"),
      (error: unknown) =>
        error instanceof OrchestratorError && error.code === "WRITER_LEASE_MISMATCH",
    );
    first.releaseWriterLease("example", "task-owner-0001");
    assert.equal(second.writerLeaseOwner("example"), undefined);
  } finally {
    second.close();
    first.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

void test("SQLite store transfers a writer lease only from the expected previous Task", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-lease-reclaim-"));
  const databaseFile = path.join(temporary, "state.db");
  const store = new SqliteTaskStore(databaseFile);
  try {
    const blockedId = "task-20260914-blocked1";
    const claimantId = "task-20260914-claim1";
    store.createWithWriterLease(created(blockedId, "Hold a lease while externally blocked"), AT);
    const claimant = created(claimantId, "Claim a lease abandoned by a blocked Task");
    assert.throws(
      () => store.createWithReclaimedWriterLease(claimant, AT, "task-20260914-missing"),
      (error: unknown) => error instanceof OrchestratorError && error.code === "WRITER_LEASE_BUSY",
    );
    assert.equal(store.writerLeaseOwner("example"), blockedId);
    assert.throws(() => store.get(claimantId));
    store.createWithReclaimedWriterLease(claimant, AT, blockedId);
    assert.equal(store.writerLeaseOwner("example"), claimantId);
    assert.equal(store.get(claimantId).state, "CREATED");
    assert.equal(store.get(blockedId).state, "CREATED");
  } finally {
    store.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
