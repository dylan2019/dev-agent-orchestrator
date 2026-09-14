import path from "node:path";

import { createControlRuntime } from "../dist/src/runtime/control-runtime.js";

class LiveSmokeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LiveSmokeError";
    this.code = code;
  }
}

const home = process.argv[2];
if (!home) {
  throw new LiveSmokeError("HOME_REQUIRED", "Usage: node scripts/live-smoke.mjs <runtime-home>");
}

const runnerFile = path.resolve("dist", "src", "interfaces", "runner", "main.js");
const runtime = createControlRuntime(runnerFile, path.resolve(home));
const deadline = Date.now() + 20 * 60_000;
let task;

async function wait(expected) {
  while (task.state !== expected) {
    if (Date.now() >= deadline) {
      throw new LiveSmokeError(
        "SMOKE_TIMEOUT",
        `Smoke Task did not reach ${expected}; current state is ${task.state}`,
      );
    }
    const observation = await runtime.control.observe(task.id, task.revision, 30_000);
    task = observation.task;
    if (observation.changed) {
      process.stdout.write(`${JSON.stringify({ state: task.state, revision: task.revision })}\n`);
    }
    if (["EXTERNAL_BLOCKED", "REWORK_REQUIRED", "CANCELLED"].includes(task.state)) {
      throw new LiveSmokeError("TASK_STOPPED", `Smoke Task stopped in ${task.state}`);
    }
  }
}

try {
  const doctor = await runtime.doctor.run();
  if (!doctor.ok) {
    throw new LiveSmokeError(
      "DOCTOR_FAILED",
      `Doctor failed with ${doctor.issues.length} issue(s)`,
    );
  }
  task = await runtime.control.start({
    objective:
      "Create smoke.txt containing exactly production-smoke followed by one newline; modify no other file.",
    risk: "normal",
    initialScope: ["smoke.txt"],
  });
  process.stdout.write(`${JSON.stringify({ taskId: task.id, state: task.state })}\n`);
  await wait("AWAITING_CONTROL_REVIEW");
  const candidate = await runtime.control.candidate(task.id, "manifest", 10_000);
  if (candidate.changedFiles.length !== 1 || candidate.changedFiles[0] !== "smoke.txt") {
    throw new LiveSmokeError("UNEXPECTED_CANDIDATE", "Smoke Candidate changed unauthorized files");
  }
  task = await runtime.control.decide({
    action: "approve_candidate",
    taskId: task.id,
    expectedRevision: task.revision,
    expectedFingerprint: candidate.fingerprint,
    summary: "Smoke Candidate contains exactly one authorized file",
  });
  await wait("AWAITING_FINAL_APPROVAL");
  if (!task.candidate) {
    throw new LiveSmokeError(
      "CANDIDATE_MISSING",
      "Smoke Task reached final approval without a Candidate",
    );
  }
  task = await runtime.control.decide({
    action: "approve_delivery",
    taskId: task.id,
    expectedRevision: task.revision,
    expectedFingerprint: task.candidate.fingerprint,
    commitMessage: "test: complete production smoke",
    push: false,
    idempotencyKey: `smoke:${task.id}`,
  });
  await wait("COMMITTED");
  process.stdout.write(`${JSON.stringify({ ok: true, taskId: task.id, state: task.state })}\n`);
} finally {
  if (task && task.state !== "COMMITTED" && task.state !== "CANCELLED") {
    try {
      const current = runtime.control.get(task.id);
      await runtime.control.decide({
        action: "cancel",
        taskId: current.id,
        expectedRevision: current.revision,
        reason: "live smoke cleanup",
      });
    } catch {
      // Runtime close remains safe and does not hide the authoritative smoke failure.
    }
  }
  runtime.close();
}
