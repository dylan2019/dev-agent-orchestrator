import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { CandidateRepository } from "./ports/candidate-repository.js";
import type { GateCache } from "./ports/gate-cache.js";
import type { ProcessRunner } from "./ports/process-runner.js";
import type { GateDefinition, ProjectProfile } from "../configuration/schema.js";
import { pathIsCovered } from "../domain/scope.js";
import type { GateResult } from "../domain/types.js";
import type { EventLogger } from "./ports/event-logger.js";
import { OrchestratorError, wrapError } from "../shared/errors.js";

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function definitionHash(gate: GateDefinition): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        id: gate.id,
        command: gate.command,
        args: gate.args,
        cwd: gate.cwd ?? null,
        paths: gate.paths ?? null,
        dependsOn: gate.dependsOn,
        timeoutMinutes: gate.timeoutMinutes,
      }),
    )
    .digest("hex");
}

function gateFailureCode(stderr: string): string {
  return /'[A-Za-z0-9._-]{1,64}' is not recognized as an internal or external command/i.test(
    stderr,
  ) || /(?:^|\n)(?:sh|bash):\s*(?:\d+:\s*)?[A-Za-z0-9._-]{1,64}:\s*command not found/i.test(stderr)
    ? "GATE_REQUIRED_TOOL_MISSING"
    : "GATE_EXIT_NONZERO";
}

function selectedGateOrder(
  gates: readonly GateDefinition[],
  changedFiles: readonly string[],
  requiredGateIds: readonly string[] = [],
): readonly GateDefinition[] {
  const byId = new Map(gates.map((gate) => [gate.id, gate]));
  const selected = new Set(
    requiredGateIds.length > 0
      ? requiredGateIds
      : gates
          .filter(
            (gate) =>
              gate.paths === undefined ||
              changedFiles.some(
                (file) =>
                  pathIsCovered(file, gate.paths ?? []) ||
                  (gate.paths ?? []).some((gatePath) => pathIsCovered(gatePath, [file])),
              ),
          )
          .map((gate) => gate.id),
  );
  const includeDependencies = (gateId: string): void => {
    const gate = byId.get(gateId);
    if (!gate) {
      throw new OrchestratorError("GATE_DEPENDENCY_MISSING", "Gate dependency is missing", {
        gateId,
      });
    }
    for (const dependency of gate.dependsOn) {
      if (!selected.has(dependency)) {
        selected.add(dependency);
        includeDependencies(dependency);
      }
    }
  };
  for (const gateId of [...selected]) {
    includeDependencies(gateId);
  }
  const ordered: GateDefinition[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (gateId: string): void => {
    if (visited.has(gateId)) {
      return;
    }
    if (visiting.has(gateId)) {
      throw new OrchestratorError("GATE_DEPENDENCY_CYCLE", "Gate dependency graph has a cycle", {
        gateId,
      });
    }
    const gate = byId.get(gateId);
    if (!gate) {
      throw new OrchestratorError("GATE_DEPENDENCY_MISSING", "Gate dependency is missing", {
        gateId,
      });
    }
    visiting.add(gateId);
    for (const dependency of gate.dependsOn) {
      visit(dependency);
    }
    visiting.delete(gateId);
    visited.add(gateId);
    ordered.push(gate);
  };
  for (const gate of gates) {
    if (selected.has(gate.id)) {
      visit(gate.id);
    }
  }
  return ordered;
}

export class GateExecutor {
  public constructor(
    private readonly processes: ProcessRunner,
    private readonly candidates: CandidateRepository,
    private readonly cache: GateCache,
    private readonly logger: EventLogger,
  ) {}

  public async runSetup(
    taskId: string,
    project: ProjectProfile,
    worktreePath: string,
    authorizedPaths: readonly string[],
  ): Promise<readonly GateResult[]> {
    const ordered = selectedGateOrder(project.gates.setup ?? [], authorizedPaths);
    const results: GateResult[] = [];
    for (const gate of ordered) {
      const before = await this.candidates.inspect(worktreePath);
      const result = await this.runGate(taskId, project, worktreePath, gate, false);
      results.push(result);
      if (result.status === "fail") {
        break;
      }
      const after = await this.candidates.inspect(worktreePath);
      if (before.fingerprint !== after.fingerprint || before.baseCommit !== after.baseCommit) {
        throw new OrchestratorError(
          "SETUP_MODIFIED_CANDIDATE",
          "Setup Gate modified the Git Candidate",
          { gateId: gate.id },
        );
      }
    }
    return results;
  }

  public async runAffected(
    taskId: string,
    project: ProjectProfile,
    worktreePath: string,
  ): Promise<readonly GateResult[]> {
    const inspection = await this.candidates.inspect(worktreePath);
    const ordered = selectedGateOrder(project.gates.affected, inspection.changedFiles);
    const results: GateResult[] = [];
    for (const gate of ordered) {
      const result = await this.runGate(taskId, project, worktreePath, gate, true);
      results.push(result);
      if (result.status === "fail") {
        break;
      }
    }
    return results;
  }

  public async runAcceptance(
    taskId: string,
    project: ProjectProfile,
    worktreePath: string,
  ): Promise<GateResult> {
    if (project.gates.acceptance.dependsOn.length > 0) {
      const dependencies = selectedGateOrder(
        project.gates.affected,
        [],
        project.gates.acceptance.dependsOn,
      );
      for (const gate of dependencies) {
        const result = await this.runGate(taskId, project, worktreePath, gate, true);
        if (result.status === "fail") {
          return result;
        }
      }
    }
    return await this.runGate(taskId, project, worktreePath, project.gates.acceptance, false);
  }

  private async runGate(
    taskId: string,
    project: ProjectProfile,
    worktreePath: string,
    gate: GateDefinition,
    cacheable: boolean,
  ): Promise<GateResult> {
    const relevantHash = await this.candidates.hashRelevantPaths(worktreePath, gate.paths);
    const inputHash = crypto
      .createHash("sha256")
      .update(`${definitionHash(gate)}\0${relevantHash}`)
      .digest("hex");
    const cacheKey = `${gate.id}:${inputHash}`;
    if (cacheable) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return { ...cached.result, cachedFromRunId: cached.runId };
      }
    }
    const gateCwd = gate.cwd ? path.resolve(worktreePath, gate.cwd) : path.resolve(worktreePath);
    let canonicalRoot: string;
    let canonicalCwd: string;
    try {
      canonicalRoot = fs.realpathSync.native(worktreePath);
      canonicalCwd = fs.realpathSync.native(gateCwd);
    } catch (error) {
      throw wrapError("GATE_CWD_UNAVAILABLE", "Gate working directory cannot be resolved", error, {
        gateId: gate.id,
      });
    }
    if (!isWithin(worktreePath, gateCwd) || !isWithin(canonicalRoot, canonicalCwd)) {
      throw new OrchestratorError(
        "GATE_CWD_OUTSIDE_WORKTREE",
        "Gate cwd escaped Candidate Worktree",
        {
          gateId: gate.id,
          cwd: gate.cwd ?? null,
        },
      );
    }
    this.logger.write({
      level: "info",
      event: "gate.started",
      taskId,
      operation: gate.id,
      outcome: "started",
    });
    const runId = crypto.randomUUID();
    const result = await this.processes.run(gate.command, gate.args, {
      cwd: gateCwd,
      timeoutMs: gate.timeoutMinutes * 60_000,
      maxCaptureBytes: 100_000,
      env: { ...process.env, DEV_AGENT_WORKTREE_ROOT: project.worktreeRoot },
    });
    const passed = result.exitCode === 0 && !result.timedOut && !result.cancelled;
    const gateResult: GateResult = {
      gateId: gate.id,
      inputHash,
      status: passed ? "pass" : "fail",
      durationMs: result.durationMs,
      ...(!passed
        ? {
            errorCode: result.timedOut
              ? "GATE_TIMEOUT"
              : result.cancelled
                ? "GATE_CANCELLED"
                : gateFailureCode(result.stderr),
            exitCode: result.exitCode,
          }
        : {}),
    };
    if (cacheable && passed) {
      this.cache.put({ cacheKey, runId, result: gateResult, createdAt: new Date().toISOString() });
    }
    this.logger.write({
      level: passed ? "info" : "error",
      event: "gate.finished",
      taskId,
      operation: gate.id,
      durationMs: result.durationMs,
      outcome: passed ? "pass" : "fail",
      ...(!passed ? { errorCode: gateResult.errorCode } : {}),
      ...(!passed ? { exitCode: result.exitCode } : {}),
    });
    return gateResult;
  }
}
