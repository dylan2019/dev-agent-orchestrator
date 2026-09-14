import fs from "node:fs";
import path from "node:path";

import { DomainError } from "../domain/errors.js";
import { normalizeAuthorizedPaths, pathIsCovered } from "../domain/scope.js";
import {
  blockExternally,
  completeDelivery,
  completeVerification,
  recordCandidate,
  recordIndependentReview,
  requestScopeApproval,
  requireRework,
  startImplementation,
  startIndependentReviewAttempt,
} from "../domain/task.js";
import type { ExternalBlock, TaskAggregate, TransitionResult } from "../domain/types.js";
import type { WorkerAdapterRegistry } from "../adapters/registry.js";
import type { ConfigFileRepository } from "../configuration/file-repository.js";
import type { CandidateRepository } from "./ports/candidate-repository.js";
import type { ProcessSupervisor } from "./ports/process-supervisor.js";
import type { TaskStore } from "./ports/task-store.js";
import type { GateExecutor } from "./gate-executor.js";
import { assertExecutionBinding } from "./execution-profile.js";
import type { EventLogger } from "./ports/event-logger.js";
import { OrchestratorError } from "../shared/errors.js";

function now(): string {
  return new Date().toISOString();
}

function errorCode(error: unknown): string {
  return error instanceof OrchestratorError || error instanceof DomainError
    ? error.code
    : "UNEXPECTED_EXECUTION_ERROR";
}

function errorMessage(error: unknown): string {
  if (
    error instanceof OrchestratorError &&
    typeof error.details?.cause === "string" &&
    error.details.cause
  ) {
    return `${error.message}: ${error.details.cause}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export class TaskExecutionService {
  public constructor(
    private readonly configRepository: ConfigFileRepository,
    private readonly store: TaskStore,
    private readonly candidates: CandidateRepository,
    private readonly gates: GateExecutor,
    private readonly adapters: WorkerAdapterRegistry,
    private readonly supervisor: ProcessSupervisor,
    private readonly logger: EventLogger,
    private readonly tasksDirectory: string,
  ) {}

  public async advance(taskId: string): Promise<TaskAggregate> {
    const task = this.store.get(taskId);
    switch (task.state) {
      case "CREATED":
      case "REWORK_REQUIRED":
        return await this.runImplementation(task);
      case "INDEPENDENT_REVIEWING":
        return await this.runIndependentReview(task);
      case "ACCEPTING":
        return await this.runDelivery(task);
      default:
        return task;
    }
  }

  private async runImplementation(initial: TaskAggregate): Promise<TaskAggregate> {
    const binding = assertExecutionBinding(this.configRepository.read(), initial);
    const started = startImplementation(initial, {
      executorId: binding.implementationWorkerId,
      model: binding.implementationWorker.model,
      occurredAt: now(),
    });
    this.persist(initial, started);
    let task = started.task;
    const worktreePath = path.resolve(binding.project.worktreeRoot, task.id);
    const runtimeDirectory = path.join(this.tasksDirectory, task.id);
    fs.mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
    const attempt = task.attempts.at(-1);
    if (!attempt) {
      throw new OrchestratorError(
        "IMPLEMENTATION_ATTEMPT_MISSING",
        "Implementation Attempt is missing",
      );
    }
    try {
      const scope = task.scopeGrants.at(-1);
      if (!scope) {
        throw new OrchestratorError("SCOPE_MISSING", "Task has no ScopeGrant");
      }
      const setupResults = await this.gates.runSetup(
        task.id,
        binding.project,
        worktreePath,
        scope.paths,
      );
      const failedSetup = setupResults.find((gate) => gate.status === "fail");
      if (failedSetup) {
        throw new OrchestratorError("SETUP_FAILED", "Project setup Gate failed", {
          gateId: failedSetup.gateId,
          errorCode: failedSetup.errorCode ?? null,
        });
      }
    } catch (error) {
      return this.handleExecutionError(task, error, "IMPLEMENTING");
    }
    this.logger.write({
      level: "info",
      event: "worker.started",
      taskId: task.id,
      attempt: attempt.number,
      state: task.state,
      operation: binding.implementationWorkerId,
      outcome: "started",
    });
    try {
      const hooks = this.supervisor.workerHooks(task.id);
      const result = await this.adapters.get(binding.implementationWorker.adapter).implement({
        task,
        project: binding.project,
        profile: binding.implementationWorker,
        worktreePath,
        runtimeDirectory,
        timeoutMs: task.budget.maxWallClockMinutes * 60_000,
        maxCaptureBytes: task.budget.maxCapturedBytes,
        onProcessSpawn: hooks.onSpawn,
        onProcessExit: hooks.onExit,
      });
      this.logger.write({
        level: "info",
        event: "worker.finished",
        taskId: task.id,
        attempt: attempt.number,
        state: task.state,
        operation: binding.implementationWorkerId,
        outcome: "pass",
        durationMs: result.durationMs,
        toolEvents: result.toolEvents,
        capturedBytes: result.capturedBytes,
      });
      if (
        result.toolEvents > task.budget.maxToolEvents ||
        result.capturedBytes > task.budget.maxCapturedBytes
      ) {
        return this.persistExternalBlock(task, {
          reason: "semantic_stall",
          message: "Worker exceeded its semantic activity budget",
          blockedAt: now(),
          resumeState: "IMPLEMENTING",
        });
      }
      const inspection = await this.candidates.inspect(worktreePath);
      const scope = task.scopeGrants.at(-1);
      if (!scope) {
        throw new OrchestratorError("SCOPE_MISSING", "Task has no ScopeGrant");
      }
      const violations = inspection.changedFiles.filter(
        (file) => !pathIsCovered(file, scope.paths),
      );
      if (violations.length > 0) {
        try {
          const requestedPaths = normalizeAuthorizedPaths([...scope.paths, ...violations]);
          const transition = requestScopeApproval(task, {
            requestedPaths,
            reason: `Candidate requires additional paths: ${violations.join(", ")}`,
            candidateFingerprint: inspection.fingerprint,
            occurredAt: now(),
          });
          this.persist(task, transition);
          return transition.task;
        } catch (error) {
          if (!(error instanceof DomainError) || error.code !== "INVALID_SCOPE_PATH") {
            throw error;
          }
          const transition = requireRework(task, {
            reason: `Worker modified forbidden sensitive paths: ${violations.join(", ")}`,
            errorCode: "FORBIDDEN_PATH_MODIFIED",
            occurredAt: now(),
          });
          this.persist(task, transition);
          return transition.task;
        }
      }
      const candidate = recordCandidate(task, {
        baseCommit: inspection.baseCommit,
        fingerprint: inspection.fingerprint,
        changedFiles: inspection.changedFiles,
        changedLines: inspection.changedLines,
        occurredAt: now(),
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        workerSummary: result.summary,
      });
      this.persist(task, candidate);
      task = candidate.task;
      const gateResults = await this.gates.runAffected(task.id, binding.project, worktreePath);
      const verified = completeVerification(task, gateResults, now());
      this.persist(task, verified);
      return verified.task;
    } catch (error) {
      return this.handleExecutionError(task, error, "IMPLEMENTING");
    }
  }

  private async runIndependentReview(initial: TaskAggregate): Promise<TaskAggregate> {
    const binding = assertExecutionBinding(this.configRepository.read(), initial);
    const started = startIndependentReviewAttempt(initial, {
      executorId: binding.reviewWorkerId,
      model: binding.reviewWorker.model,
      occurredAt: now(),
    });
    this.persist(initial, started);
    const task = started.task;
    const attempt = task.attempts.at(-1);
    if (!attempt) {
      throw new OrchestratorError("REVIEW_ATTEMPT_MISSING", "Review Attempt is missing");
    }
    const worktreePath = path.resolve(binding.project.worktreeRoot, task.id);
    const runtimeDirectory = path.join(this.tasksDirectory, task.id);
    try {
      const patch = await this.candidates.getPatch(worktreePath, 500_000);
      if (patch.fingerprint !== task.candidate?.fingerprint) {
        throw new OrchestratorError(
          "CANDIDATE_CHANGED_BEFORE_REVIEW",
          "Candidate changed before review",
        );
      }
      const hooks = this.supervisor.workerHooks(task.id);
      this.logger.write({
        level: "info",
        event: "independent_review.started",
        taskId: task.id,
        attempt: attempt.number,
        state: task.state,
        operation: binding.reviewWorkerId,
        outcome: "started",
      });
      const result = await this.adapters.get(binding.reviewWorker.adapter).review({
        task,
        project: binding.project,
        profile: binding.reviewWorker,
        worktreePath,
        runtimeDirectory,
        timeoutMs: task.budget.maxWallClockMinutes * 60_000,
        maxCaptureBytes: task.budget.maxCapturedBytes,
        candidatePatch: patch.patch,
        onProcessSpawn: hooks.onSpawn,
        onProcessExit: hooks.onExit,
      });
      const reviewed = recordIndependentReview(task, {
        candidateFingerprint: patch.fingerprint,
        executorId: binding.reviewWorkerId,
        model: binding.reviewWorker.model,
        verdict: result.verdict,
        summary: result.summary,
        findings: result.findings,
        reviewedAt: now(),
      });
      this.persist(task, reviewed);
      this.logger.write({
        level: result.verdict === "pass" ? "info" : "warn",
        event: "independent_review.finished",
        taskId: task.id,
        attempt: attempt.number,
        state: reviewed.task.state,
        operation: binding.reviewWorkerId,
        outcome: result.verdict,
        durationMs: result.durationMs,
        toolEvents: result.toolEvents,
        capturedBytes: result.capturedBytes,
      });
      return reviewed.task;
    } catch (error) {
      return this.handleExecutionError(task, error, "INDEPENDENT_REVIEWING");
    }
  }

  private async runDelivery(task: TaskAggregate): Promise<TaskAggregate> {
    const binding = assertExecutionBinding(this.configRepository.read(), task);
    const worktreePath = path.resolve(binding.project.worktreeRoot, task.id);
    try {
      const expectedFingerprint = task.candidate?.fingerprint;
      if (!expectedFingerprint) {
        throw new OrchestratorError("CANDIDATE_MISSING", "Delivery has no CandidateSnapshot");
      }
      const before = await this.candidates.inspect(worktreePath);
      if (before.fingerprint !== expectedFingerprint) {
        throw new OrchestratorError(
          "CANDIDATE_CHANGED_BEFORE_ACCEPTANCE",
          "Candidate changed before acceptance",
        );
      }
      const acceptance = await this.gates.runAcceptance(task.id, binding.project, worktreePath);
      if (acceptance.status !== "pass") {
        const rework = requireRework(task, {
          reason: `Final acceptance failed: ${acceptance.gateId}`,
          errorCode: acceptance.errorCode ?? "ACCEPTANCE_FAILED",
          occurredAt: now(),
        });
        this.persist(task, rework);
        return rework.task;
      }
      const after = await this.candidates.inspect(worktreePath);
      if (after.fingerprint !== expectedFingerprint) {
        throw new OrchestratorError(
          "ACCEPTANCE_MODIFIED_CANDIDATE",
          "Acceptance modified Candidate",
        );
      }
      const prepared = await this.candidates.prepareCommit(
        worktreePath,
        expectedFingerprint,
        task.delivery?.commitMessage ?? `feat: deliver ${task.id}`,
      );
      await this.candidates.integrate(
        binding.project,
        task.candidate.baseCommit,
        prepared,
        task.delivery?.pushRequested ?? false,
      );
      const completed = completeDelivery(task, {
        candidateFingerprint: expectedFingerprint,
        commitHash: prepared.commitHash,
        treeHash: prepared.treeHash,
        pushed: task.delivery?.pushRequested ?? false,
        occurredAt: now(),
      });
      this.store.saveAndReleaseWriterLease(task.revision, completed);
      await this.candidates.removeWorktree(binding.project, worktreePath, false);
      this.logger.write({
        level: "info",
        event: "delivery.finished",
        taskId: task.id,
        state: completed.task.state,
        outcome: "committed",
      });
      return completed.task;
    } catch (error) {
      return this.handleExecutionError(task, error, "ACCEPTING");
    }
  }

  private handleExecutionError(
    task: TaskAggregate,
    error: unknown,
    resumeState: ExternalBlock["resumeState"],
  ): TaskAggregate {
    const current = this.store.get(task.id);
    if (current.state !== resumeState) {
      return current;
    }
    const code = errorCode(error);
    const message = errorMessage(error);
    const externalReason = code.includes("RATE_LIMIT")
      ? "provider_rate_limit"
      : code.includes("CAPACITY")
        ? "provider_capacity"
        : code.includes("SETUP")
          ? "environment_unavailable"
          : code.includes("TIMEOUT") || code.includes("PROCESS")
            ? "process_lost"
            : undefined;
    if (externalReason) {
      return this.persistExternalBlock(current, {
        reason: externalReason,
        message,
        blockedAt: now(),
        resumeState,
      });
    }
    const rework = requireRework(current, { reason: message, errorCode: code, occurredAt: now() });
    this.persist(current, rework);
    this.logger.write({
      level: "error",
      event: "error",
      taskId: current.id,
      state: rework.task.state,
      errorCode: code,
      message,
      outcome: "fail",
    });
    return rework.task;
  }

  private persistExternalBlock(task: TaskAggregate, block: ExternalBlock): TaskAggregate {
    const transition = blockExternally(task, block);
    this.persist(task, transition);
    this.logger.write({
      level: "warn",
      event: "error",
      taskId: task.id,
      state: transition.task.state,
      errorCode: block.reason,
      message: block.message,
      outcome: "blocked",
    });
    return transition.task;
  }

  private persist(previous: TaskAggregate, transition: TransitionResult): void {
    this.store.save(previous.revision, transition);
    this.logger.write({
      level: "info",
      event: "state.changed",
      taskId: transition.task.id,
      projectId: transition.task.projectId,
      state: transition.task.state,
      operation: transition.event.type,
    });
  }
}
