import path from "node:path";

import type { ProcessRunner } from "../application/ports/process-runner.js";
import {
  implementationPrompt,
  parseExecutionResult,
  parseReviewResult,
  probeCli,
  reviewPrompt,
  withEphemeralFiles,
} from "./common.js";
import type {
  ReviewExecutionRequest,
  ReviewExecutionResult,
  WorkerAdapter,
  WorkerExecutionRequest,
  WorkerExecutionResult,
  WorkerProbeResult,
} from "./types.js";

const REQUIRED_FLAGS = ["--prompt", "--attach", "--mode", "--json", "--cwd"];

export class ZcodeAdapter implements WorkerAdapter {
  public readonly id = "zcode" as const;

  public constructor(private readonly processes: ProcessRunner) {}

  public async probe(
    profile: WorkerExecutionRequest["profile"],
    project: WorkerExecutionRequest["project"],
  ): Promise<WorkerProbeResult> {
    return await probeCli(this.id, profile, project, this.processes, REQUIRED_FLAGS, [
      "doctor",
      "--json",
    ]);
  }

  public async implement(request: WorkerExecutionRequest): Promise<WorkerExecutionResult> {
    const result = await this.execute(
      request,
      implementationPrompt(request.task, request.project),
      false,
    );
    return parseExecutionResult(this.id, result);
  }

  public async review(request: ReviewExecutionRequest): Promise<ReviewExecutionResult> {
    return await withEphemeralFiles(
      request.runtimeDirectory,
      { "candidate.patch": request.candidatePatch },
      async (paths) => {
        const patchFile = paths["candidate.patch"];
        if (!patchFile) {
          throw new Error("Candidate patch file was not created");
        }
        const result = await this.execute(
          request,
          reviewPrompt(request.task, request.project, patchFile),
          true,
        );
        return parseReviewResult(this.id, result);
      },
    );
  }

  private async execute(request: WorkerExecutionRequest, prompt: string, review: boolean) {
    return await withEphemeralFiles(
      request.runtimeDirectory,
      { "task.md": prompt },
      async (paths) => {
        const promptFile = paths["task.md"];
        if (!promptFile) {
          throw new Error("ZCode task input was not created");
        }
        return await this.processes.run(
          request.profile.command,
          [
            ...request.profile.args,
            "--surface",
            "terminal",
            "--cwd",
            request.worktreePath,
            "--mode",
            review ? "plan" : "yolo",
            "--json",
            "--no-color",
            "--attach",
            promptFile,
            "--prompt",
            `Read ${path.basename(promptFile)} completely and follow it as the only task input.`,
          ],
          {
            cwd: request.worktreePath,
            timeoutMs: request.timeoutMs,
            maxCaptureBytes: request.maxCaptureBytes,
            ...(request.signal ? { signal: request.signal } : {}),
            ...(request.onProcessSpawn ? { onSpawn: request.onProcessSpawn } : {}),
            ...(request.onProcessExit ? { onExit: request.onProcessExit } : {}),
          },
        );
      },
    );
  }
}
