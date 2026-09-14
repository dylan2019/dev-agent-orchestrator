import crypto from "node:crypto";

import type { OrchestratorConfig, ProjectProfile, WorkerProfile } from "../configuration/schema.js";
import type { RiskLevel, TaskAggregate } from "../domain/types.js";
import { OrchestratorError } from "../shared/errors.js";

export interface ExecutionBinding {
  readonly project: ProjectProfile;
  readonly implementationWorkerId: string;
  readonly implementationWorker: WorkerProfile;
  readonly reviewWorkerId: string;
  readonly reviewWorker: WorkerProfile;
  readonly fingerprint: string;
}

function fingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function resolveExecutionBinding(
  config: OrchestratorConfig,
  projectId: string,
  risk: RiskLevel,
): ExecutionBinding {
  const project = config.projects[projectId];
  const route = config.routing[risk];
  if (!project) {
    throw new OrchestratorError("PROJECT_NOT_FOUND", "Project is not configured", { projectId });
  }
  const implementationWorker = config.workers[route.implementation];
  const reviewWorker = config.workers[route.review];
  if (!implementationWorker || !reviewWorker) {
    throw new OrchestratorError("ROUTE_WORKER_NOT_FOUND", "Risk route references a missing Worker");
  }
  const binding = {
    project,
    implementationWorkerId: route.implementation,
    implementationWorker,
    reviewWorkerId: route.review,
    reviewWorker,
  };
  return { ...binding, fingerprint: fingerprint(binding) };
}

export function assertExecutionBinding(
  config: OrchestratorConfig,
  task: TaskAggregate,
): ExecutionBinding {
  const binding = resolveExecutionBinding(config, task.projectId, task.risk);
  if (
    binding.fingerprint !== task.executionProfileFingerprint ||
    binding.implementationWorkerId !== task.implementationWorkerId ||
    binding.reviewWorkerId !== task.reviewWorkerId
  ) {
    throw new OrchestratorError(
      "EXECUTION_PROFILE_CHANGED",
      "Project, routing, or Worker profile changed while Task was active",
      {
        taskId: task.id,
        expected: task.executionProfileFingerprint,
        actual: binding.fingerprint,
      },
    );
  }
  return binding;
}
