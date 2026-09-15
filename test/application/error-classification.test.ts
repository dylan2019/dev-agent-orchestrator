import assert from "node:assert/strict";
import test from "node:test";

import {
  externalReasonForCode,
  externalReasonForExecution,
} from "../../src/application/error-classification.js";

void test("external failure reasons use exact typed codes rather than substrings", () => {
  assert.equal(externalReasonForCode("SETUP_FAILED"), "environment_unavailable");
  assert.equal(externalReasonForCode("GATE_CWD_UNAVAILABLE"), "environment_unavailable");
  assert.equal(externalReasonForCode("WORKER_OUTPUT_LIMIT"), "semantic_stall");
  assert.equal(externalReasonForCode("WORKER_TIMEOUT"), "execution_timeout");
  assert.equal(externalReasonForCode("GATE_TIMEOUT"), "execution_timeout");
  assert.equal(externalReasonForCode("INVALID_PROCESS_TIMEOUT"), undefined);
  assert.equal(externalReasonForCode("UNEXPECTED_RATE_LIMIT_FRAGMENT"), undefined);
});

void test("Reviewer execution failure blocks externally without condemning an unchanged Candidate", () => {
  assert.equal(
    externalReasonForExecution("WORKER_RESULT_FAILED", "INDEPENDENT_REVIEWING"),
    "runtime_fault",
  );
  assert.equal(
    externalReasonForExecution("WORKER_EXECUTION_FAILED", "INDEPENDENT_REVIEWING"),
    "runtime_fault",
  );
  assert.equal(
    externalReasonForExecution("WORKER_RESULT_ERROR", "INDEPENDENT_REVIEWING"),
    "runtime_fault",
  );
  assert.equal(externalReasonForExecution("WORKER_RESULT_FAILED", "IMPLEMENTING"), undefined);
});

void test("an uncertain delivery exception blocks for target inspection instead of restarting implementation", () => {
  assert.equal(externalReasonForExecution("GIT_MERGE_FAILED", "ACCEPTING"), "runtime_fault");
  assert.equal(
    externalReasonForExecution("CANDIDATE_CHANGED_BEFORE_ACCEPTANCE", "ACCEPTING"),
    undefined,
  );
});
