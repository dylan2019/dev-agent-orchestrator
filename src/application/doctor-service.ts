import fs from "node:fs";
import path from "node:path";

import type { WorkerAdapterRegistry } from "../adapters/registry.js";
import type { ConfigFileRepository } from "../configuration/file-repository.js";
import type { CandidateRepository } from "./ports/candidate-repository.js";

export interface DoctorIssue {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly subject: string;
}

export interface DoctorResult {
  readonly ok: boolean;
  readonly issues: readonly DoctorIssue[];
  readonly projectsChecked: number;
  readonly workersChecked: number;
}

function normalized(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function overlaps(left: string, right: string): boolean {
  const leftPath = normalized(left);
  const rightPath = normalized(right);
  const relativeLeft = path.relative(leftPath, rightPath);
  const relativeRight = path.relative(rightPath, leftPath);
  const inside = (relative: string) =>
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  return inside(relativeLeft) || inside(relativeRight);
}

export class DoctorService {
  public constructor(
    private readonly configRepository: ConfigFileRepository,
    private readonly candidates: CandidateRepository,
    private readonly adapters: WorkerAdapterRegistry,
  ) {}

  public async run(projectId?: string): Promise<DoctorResult> {
    const config = this.configRepository.read();
    const issues: DoctorIssue[] = [];
    const projects = projectId
      ? Object.entries(config.projects).filter(([id]) => id === projectId)
      : Object.entries(config.projects);
    if (projectId && projects.length === 0) {
      issues.push({
        severity: "error",
        code: "PROJECT_NOT_FOUND",
        message: "Requested Project is not configured",
        subject: projectId,
      });
    }
    for (const [id, project] of projects) {
      if (overlaps(project.repository, project.worktreeRoot)) {
        issues.push({
          severity: "error",
          code: "WORKTREE_ROOT_OVERLAP",
          message: "Worktree root must not contain or be contained by the repository",
          subject: id,
        });
      }
      for (const gate of [...project.gates.affected, project.gates.acceptance]) {
        if (!fs.existsSync(gate.command)) {
          issues.push({
            severity: "error",
            code: "GATE_COMMAND_MISSING",
            message: `Gate executable does not exist: ${gate.id}`,
            subject: id,
          });
        }
        if (/\.(?:cmd|bat)$/i.test(gate.command)) {
          issues.push({
            severity: "error",
            code: "BATCH_COMMAND_UNSUPPORTED",
            message: `Gate requires an explicit executable wrapper: ${gate.id}`,
            subject: id,
          });
        }
      }
      try {
        const state = await this.candidates.inspectProject(project);
        if (normalized(state.root) !== normalized(project.repository)) {
          issues.push({
            severity: "error",
            code: "REPOSITORY_ROOT_MISMATCH",
            message: "Configured repository is not the Git root",
            subject: id,
          });
        }
        if (state.branch !== project.targetBranch) {
          issues.push({
            severity: "error",
            code: "TARGET_BRANCH_MISMATCH",
            message: `Checkout ${project.targetBranch} before starting a Task`,
            subject: id,
          });
        }
        if (!state.clean) {
          issues.push({
            severity: "error",
            code: "PRIMARY_WORKTREE_DIRTY",
            message: "Primary Worktree must be clean before starting a Task",
            subject: id,
          });
        }
      } catch (error) {
        issues.push({
          severity: "error",
          code: "PROJECT_GIT_PROBE_FAILED",
          message: error instanceof Error ? error.message : String(error),
          subject: id,
        });
      }
    }
    const workerIds = new Set(
      Object.values(config.routing).flatMap((route) => [route.implementation, route.review]),
    );
    await Promise.all(
      [...workerIds].map(async (workerId) => {
        const profile = config.workers[workerId];
        const project = projects[0]?.[1];
        if (!profile || !project) {
          return;
        }
        if (!fs.existsSync(profile.command)) {
          issues.push({
            severity: "error",
            code: "WORKER_COMMAND_MISSING",
            message: "Worker executable does not exist",
            subject: workerId,
          });
          return;
        }
        try {
          const probe = await this.adapters.get(profile.adapter).probe(profile, project);
          if (!probe.modelAvailable) {
            issues.push({
              severity: "error",
              code: "WORKER_MODEL_UNAVAILABLE",
              message: `Configured model is not available: ${profile.model}`,
              subject: workerId,
            });
          }
        } catch (error) {
          issues.push({
            severity: "error",
            code: "WORKER_PROBE_FAILED",
            message: error instanceof Error ? error.message : String(error),
            subject: workerId,
          });
        }
      }),
    );
    issues.sort((left, right) =>
      `${left.severity}:${left.subject}:${left.code}`.localeCompare(
        `${right.severity}:${right.subject}:${right.code}`,
      ),
    );
    return {
      ok: !issues.some((issue) => issue.severity === "error"),
      issues,
      projectsChecked: projects.length,
      workersChecked: workerIds.size,
    };
  }
}
