import type { ExternalBlock } from "../domain/types.js";

const EXTERNAL_REASONS: Readonly<Record<string, ExternalBlock["reason"]>> = {
  PROVIDER_RATE_LIMIT: "provider_rate_limit",
  WORKER_RATE_LIMIT: "provider_rate_limit",
  PROVIDER_CAPACITY: "provider_capacity",
  WORKER_CAPACITY: "provider_capacity",
  SETUP_FAILED: "environment_unavailable",
  GATE_CWD_UNAVAILABLE: "environment_unavailable",
  PROCESS_EXECUTION_FAILED: "environment_unavailable",
  SEMANTIC_STALL: "semantic_stall",
  WORKER_OUTPUT_LIMIT: "semantic_stall",
  WORKER_TIMEOUT: "execution_timeout",
  GATE_TIMEOUT: "execution_timeout",
  PROCESS_IDENTITY_UNAVAILABLE: "runtime_fault",
  PROCESS_TERMINATION_FAILED: "runtime_fault",
  RUNTIME_PROCESS_IDENTITY_MISMATCH: "runtime_fault",
};
const REVIEWER_EXECUTOR_FAILURES = new Set([
  "WORKER_EXECUTION_FAILED",
  "WORKER_RESULT_FAILED",
  "WORKER_RESULT_ERROR",
  "WORKER_RESULT_INVALID",
  "REVIEW_RESULT_INVALID",
]);
const PRE_INTEGRATION_CANDIDATE_DRIFT = new Set([
  "CANDIDATE_CHANGED_BEFORE_ACCEPTANCE",
  "ACCEPTANCE_MODIFIED_CANDIDATE",
  "CANDIDATE_CHANGED_BEFORE_COMMIT",
  "CANDIDATE_CHANGED_DURING_STAGE",
]);

export function externalReasonForCode(code: string): ExternalBlock["reason"] | undefined {
  return EXTERNAL_REASONS[code];
}

export function externalReasonForExecution(
  code: string,
  stage: ExternalBlock["resumeState"],
): ExternalBlock["reason"] | undefined {
  if (stage === "INDEPENDENT_REVIEWING" && REVIEWER_EXECUTOR_FAILURES.has(code)) {
    return "runtime_fault";
  }
  if (stage === "ACCEPTING" && !PRE_INTEGRATION_CANDIDATE_DRIFT.has(code)) {
    return externalReasonForCode(code) ?? "runtime_fault";
  }
  return externalReasonForCode(code);
}
