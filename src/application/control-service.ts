import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ConfigFileRepository } from "../configuration/file-repository.js";
import { budgetFor } from "../configuration/schema.js";
import {
  approveDelivery,
  approveScope,
  blockExternally,
  cancelTask,
  confirmRework,
  createTask,
  recordControlReview,
  requireRework,
  resumeExternalBlock,
} from "../domain/task.js";
import type { RiskLevel, TaskAggregate, TransitionResult } from "../domain/types.js";
import { OrchestratorError, wrapError } from "../shared/errors.js";
import { assertExecutionBinding, resolveExecutionBinding } from "./execution-profile.js";
import type {
  CandidateFilePatch,
  CandidateInspection,
  CandidatePatch,
  CandidateRepository,
} from "./ports/candidate-repository.js";
import type { EventLogger } from "./ports/event-logger.js";
import type { ProcessSupervisor } from "./ports/process-supervisor.js";
import type { RunnerLauncher } from "./ports/runner-launcher.js";
import type { RuntimeRegistry } from "./ports/runtime-registry.js";
import type { TaskStore } from "./ports/task-store.js";

export interface StartTaskInput {
  readonly projectId?: string;
  readonly objective: string;
  readonly risk: RiskLevel;
  readonly initialScope: readonly string[];
}

export type TaskDecision =
  | {
      readonly action: "approve_scope";
      readonly taskId: string;
      readonly expectedRevision: number;
      readonly expectedFingerprint: string;
      readonly paths: readonly string[];
      readonly reason: string;
    }
  | {
      readonly action: "request_rework";
      readonly taskId: string;
      readonly expectedRevision: number;
      readonly reason: string;
    }
  | {
      readonly action: "approve_candidate";
      readonly taskId: string;
      readonly expectedRevision: number;
      readonly expectedFingerprint: string;
      readonly summary: string;
    }
  | {
      readonly action: "approve_delivery";
      readonly taskId: string;
      readonly expectedRevision: number;
      readonly expectedFingerprint: string;
      readonly commitMessage: string;
      readonly push: boolean;
      readonly idempotencyKey: string;
    }
  | {
      readonly action: "cancel";
      readonly taskId: string;
      readonly expectedRevision: number;
      readonly reason: string;
    };

export interface TaskObservation {
  readonly task: TaskAggregate;
  readonly changed: boolean;
  readonly timedOut: boolean;
  readonly elapsedMs: number;
  readonly legalDecisions: readonly TaskDecision["action"][];
  readonly writerLeaseOwner?: string;
}

function timestamp(): string {
  return new Date().toISOString();
}

function taskId(): string {
  const date = new Date();
  const compact = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ]
    .map((value) => String(value).padStart(2, "0"))
    .join("");
  return `task-${compact}-${crypto.randomUUID().slice(0, 8)}`;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    let canonical = resolved;
    try {
      canonical = fs.realpathSync.native(resolved);
    } catch {
      // A missing path is still compared deterministically and rejected by project readiness checks.
    }
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  };
  return normalize(left) === normalize(right);
}

function legalDecisions(task: TaskAggregate): readonly TaskDecision["action"][] {
  switch (task.state) {
    case "SCOPE_APPROVAL_REQUIRED":
      return ["approve_scope", "cancel"];
    case "AWAITING_CONTROL_REVIEW":
      return ["approve_candidate", "request_rework", "cancel"];
    case "REWORK_REQUIRED":
    case "EXTERNAL_BLOCKED":
      return ["request_rework", "cancel"];
    case "AWAITING_FINAL_APPROVAL":
      return ["approve_delivery", "request_rework", "cancel"];
    case "COMMITTED":
    case "CANCELLED":
    case "EXHAUSTED":
      return [];
    default:
      return ["cancel"];
  }
}

export class ControlService {
  public constructor(
    private readonly configRepository: ConfigFileRepository,
    private readonly store: TaskStore,
    private readonly candidates: CandidateRepository,
    private readonly launcher: RunnerLauncher,
    private readonly runtime: RuntimeRegistry,
    private readonly supervisor: ProcessSupervisor,
    private readonly logger: EventLogger,
  ) {}

  public async reconcile(
    observedAtMs = Date.now(),
  ): Promise<{ readonly blockedTasks: readonly string[] }> {
    const activeStates = new Set([
      "CREATED",
      "SCOPING",
      "IMPLEMENTING",
      "VERIFYING",
      "INDEPENDENT_REVIEWING",
      "ACCEPTING",
    ]);
    const blockedTasks: string[] = [];
    for (const task of this.store.list()) {
      if (!activeStates.has(task.state)) {
        continue;
      }
      const runner = this.runtime.get(task.id, "runner");
      if (runner && this.supervisor.status(runner) === "owned") {
        continue;
      }
      if (
        !runner &&
        task.state === "CREATED" &&
        observedAtMs - Date.parse(task.createdAt) < 30_000
      ) {
        continue;
      }
      if (runner) {
        this.runtime.clear(task.id, "runner", runner.pid, runner.identity);
      }
      const worker = this.runtime.get(task.id, "worker");
      if (worker) {
        if (this.supervisor.status(worker) === "owned") {
          await this.supervisor.terminate(worker);
        }
        this.runtime.clear(task.id, "worker", worker.pid, worker.identity);
      }
      const latest = this.store.get(task.id);
      if (latest.revision !== task.revision || !activeStates.has(latest.state)) {
        continue;
      }
      const blocked = blockExternally(latest, {
        reason: "process_lost",
        message: "Task Runner is not alive after runtime restart",
        blockedAt: timestamp(),
        resumeState: latest.state as
          | "CREATED"
          | "SCOPING"
          | "IMPLEMENTING"
          | "VERIFYING"
          | "INDEPENDENT_REVIEWING"
          | "ACCEPTING",
      });
      try {
        this.store.save(latest.revision, blocked);
      } catch (error) {
        if (error instanceof OrchestratorError && error.code === "TASK_REVISION_CONFLICT") {
          continue;
        }
        throw error;
      }
      blockedTasks.push(latest.id);
      this.logger.write({
        level: "warn",
        event: "error",
        taskId: latest.id,
        state: blocked.task.state,
        errorCode: "process_lost",
        message: "Task Runner is not alive after runtime restart",
        outcome: "blocked",
      });
    }
    return { blockedTasks };
  }

  public async start(input: StartTaskInput): Promise<TaskAggregate> {
    const config = this.configRepository.read();
    const projectId = input.projectId ?? config.defaultProject;
    const binding = resolveExecutionBinding(config, projectId, input.risk);
    const state = await this.candidates.inspectProject(binding.project);
    if (
      !samePath(state.root, binding.project.repository) ||
      !state.clean ||
      state.branch !== binding.project.targetBranch
    ) {
      throw new OrchestratorError(
        "PROJECT_NOT_READY",
        "Project is not clean on its configured target branch",
        {
          projectId,
          root: state.root,
          branch: state.branch,
          clean: state.clean,
        },
      );
    }
    const occurredAt = timestamp();
    const created = createTask({
      id: taskId(),
      projectId,
      objective: input.objective,
      risk: input.risk,
      executionProfileFingerprint: binding.fingerprint,
      implementationWorkerId: binding.implementationWorkerId,
      reviewWorkerId: binding.reviewWorkerId,
      budget: budgetFor(config, input.risk),
      initialScope: input.initialScope,
      occurredAt,
    });
    this.store.createWithWriterLease(created, occurredAt);
    this.logger.write({
      level: "info",
      event: "task.created",
      taskId: created.task.id,
      projectId,
      state: created.task.state,
    });
    let worktreePath: string | undefined;
    try {
      worktreePath = await this.candidates.createWorktree(
        binding.project,
        created.task.id,
        state.head,
      );
      await this.launcher.launch(created.task.id);
      return created.task;
    } catch (error) {
      const cancelled = cancelTask(created.task, timestamp(), "Task startup failed");
      this.store.saveAndReleaseWriterLease(created.task.revision, cancelled);
      if (worktreePath && fs.existsSync(worktreePath)) {
        try {
          await this.candidates.removeWorktree(binding.project, worktreePath, true);
        } catch {
          // Startup error remains authoritative; Worktree path is present in the Task ID for audit.
        }
      }
      throw wrapError("TASK_START_FAILED", "Unable to start Task", error, {
        taskId: created.task.id,
      });
    }
  }

  public get(taskIdValue: string): TaskAggregate {
    return this.store.get(taskIdValue);
  }

  public list(projectId?: string): readonly TaskAggregate[] {
    return this.store.list(projectId);
  }

  public async observe(
    taskIdValue: string,
    afterRevision?: number,
    timeoutMs = 0,
  ): Promise<TaskObservation> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
      throw new OrchestratorError("INVALID_OBSERVE_TIMEOUT", "Observe timeout is invalid");
    }
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    for (;;) {
      const task = this.store.get(taskIdValue);
      const writerLeaseOwner = this.store.writerLeaseOwner(task.projectId);
      if (afterRevision === undefined || task.revision !== afterRevision) {
        return {
          task,
          changed: true,
          timedOut: false,
          elapsedMs: Date.now() - startedAt,
          legalDecisions: legalDecisions(task),
          ...(writerLeaseOwner ? { writerLeaseOwner } : {}),
        };
      }
      if (Date.now() >= deadline) {
        return {
          task,
          changed: false,
          timedOut: true,
          elapsedMs: Date.now() - startedAt,
          legalDecisions: legalDecisions(task),
          ...(writerLeaseOwner ? { writerLeaseOwner } : {}),
        };
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(250, deadline - Date.now())),
      );
    }
  }

  public async candidate(
    taskIdValue: string,
    mode: "manifest",
    maxChars: number,
    file?: string,
  ): Promise<CandidateInspection>;
  public async candidate(
    taskIdValue: string,
    mode: "patch",
    maxChars: number,
    file?: string,
  ): Promise<CandidatePatch>;
  public async candidate(
    taskIdValue: string,
    mode: "file",
    maxChars: number,
    file: string,
  ): Promise<CandidateFilePatch>;
  public async candidate(
    taskIdValue: string,
    mode: "manifest" | "patch" | "file",
    maxChars: number,
    file?: string,
  ): Promise<CandidateInspection | CandidatePatch | CandidateFilePatch> {
    const task = this.store.get(taskIdValue);
    const config = this.configRepository.read();
    const binding = assertExecutionBinding(config, task);
    const worktreePath = path.resolve(binding.project.worktreeRoot, task.id);
    if (mode === "manifest") {
      return await this.candidates.inspect(worktreePath);
    }
    if (mode === "patch") {
      return await this.candidates.getPatch(worktreePath, maxChars);
    }
    if (!file) {
      throw new OrchestratorError("CANDIDATE_FILE_REQUIRED", "File mode requires a Candidate file");
    }
    return await this.candidates.getFilePatch(worktreePath, file, maxChars);
  }

  public async decide(decision: TaskDecision): Promise<TaskAggregate> {
    const task = this.store.get(decision.taskId);
    if (task.revision !== decision.expectedRevision) {
      throw new OrchestratorError(
        "TASK_REVISION_CONFLICT",
        "Decision targets a stale Task revision",
        {
          expected: decision.expectedRevision,
          actual: task.revision,
        },
      );
    }
    let transition: TransitionResult;
    switch (decision.action) {
      case "approve_scope":
        transition = approveScope(task, {
          paths: decision.paths,
          expectedCandidateFingerprint: decision.expectedFingerprint,
          reason: decision.reason,
          occurredAt: timestamp(),
        });
        break;
      case "request_rework":
        if (task.state === "AWAITING_CONTROL_REVIEW") {
          transition = recordControlReview(task, {
            expectedCandidateFingerprint: task.candidate?.fingerprint ?? "",
            decision: "rework",
            summary: decision.reason,
            occurredAt: timestamp(),
          });
        } else if (task.state === "AWAITING_FINAL_APPROVAL") {
          transition = requireRework(task, {
            reason: decision.reason,
            errorCode: "CONTROL_REQUESTED_REWORK",
            occurredAt: timestamp(),
          });
        } else if (task.state === "EXTERNAL_BLOCKED") {
          transition = resumeExternalBlock(task, timestamp());
        } else {
          transition = confirmRework(task, decision.reason, timestamp());
        }
        break;
      case "approve_candidate":
        transition = recordControlReview(task, {
          expectedCandidateFingerprint: decision.expectedFingerprint,
          decision: "approve",
          summary: decision.summary,
          occurredAt: timestamp(),
        });
        break;
      case "approve_delivery":
        transition = approveDelivery(task, {
          expectedCandidateFingerprint: decision.expectedFingerprint,
          idempotencyKey: decision.idempotencyKey,
          commitMessage: decision.commitMessage,
          push: decision.push,
          occurredAt: timestamp(),
        });
        break;
      case "cancel":
        await this.terminateProcesses(task.id);
        transition = cancelTask(task, timestamp(), decision.reason);
        this.store.saveAndReleaseWriterLease(task.revision, transition);
        this.logger.write({
          level: "warn",
          event: "state.changed",
          taskId: task.id,
          projectId: task.projectId,
          state: transition.task.state,
          outcome: "cancelled",
        });
        return transition.task;
    }
    this.store.save(task.revision, transition);
    this.logger.write({
      level: "info",
      event: "state.changed",
      taskId: task.id,
      projectId: task.projectId,
      state: transition.task.state,
      operation: transition.event.type,
    });
    await this.launcher.launch(task.id);
    return transition.task;
  }

  private async terminateProcesses(taskIdValue: string): Promise<void> {
    const records = [...this.runtime.list(taskIdValue)].sort((left) =>
      left.role === "runner" ? -1 : 1,
    );
    for (const record of records) {
      await this.supervisor.terminate(record);
      const current = this.runtime.get(taskIdValue, record.role);
      if (current?.pid === record.pid && current.identity === record.identity) {
        this.runtime.clear(taskIdValue, record.role, record.pid, record.identity);
      }
    }
  }
}
