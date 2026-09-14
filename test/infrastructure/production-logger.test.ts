import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ProductionLogEvent } from "../../src/application/ports/event-logger.js";
import { ProductionLogger } from "../../src/infrastructure/logging/production-logger.js";

void test("production logger persists only whitelisted key fields and deduplicates unchanged events", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-log-"));
  const file = path.join(temporary, "events.jsonl");
  try {
    const logger = new ProductionLogger(file, 64_000);
    const unsafe = {
      level: "error",
      event: "error",
      taskId: "task-1",
      errorCode: "WORKER_FAILED",
      message: "token=private-value failure",
      prompt: "DO_NOT_PERSIST_PROMPT",
      thinking: "DO_NOT_PERSIST_REASONING",
      assistant: "DO_NOT_PERSIST_DELTA",
    } as ProductionLogEvent;
    assert.equal(logger.write(unsafe, new Date("2026-09-14T06:00:00.000Z")), true);
    assert.equal(logger.write(unsafe, new Date("2026-09-14T06:00:01.000Z")), false);
    const persisted = fs.readFileSync(file, "utf8");
    assert.match(persisted, /"event":"error"/);
    assert.match(persisted, /token=\[REDACTED\]/);
    assert.doesNotMatch(persisted, /private-value|DO_NOT_PERSIST/);
    assert.equal(persisted.trim().split(/\r?\n/).length, 1);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

void test("production logger rotates within a hard two-segment byte limit", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-log-rotate-"));
  const file = path.join(temporary, "events.jsonl");
  try {
    const maxBytes = 2_048;
    const logger = new ProductionLogger(file, maxBytes);
    for (let index = 0; index < 50; index += 1) {
      logger.write({
        level: "info",
        event: "state.changed",
        taskId: `task-${String(index)}`,
        state: "IMPLEMENTING",
        message: `transition-${String(index)}-${"x".repeat(80)}`,
      });
    }
    const previous = `${file}.previous`;
    assert.equal(fs.existsSync(previous), true);
    assert.equal(fs.statSync(file).size + fs.statSync(previous).size <= maxBytes, true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

void test("production logger removes expired segments before writing", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-log-retention-"));
  const file = path.join(temporary, "events.jsonl");
  try {
    fs.writeFileSync(file, "expired\n", "utf8");
    const expired = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000);
    fs.utimesSync(file, expired, expired);
    const logger = new ProductionLogger(file, 64_000, 1);
    assert.equal(fs.existsSync(file), false);
    logger.write({ level: "info", event: "task.created", taskId: "task-new" });
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /expired/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
