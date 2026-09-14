import type { ProcessRunner } from "../application/ports/process-runner.js";
import {
  implementationPrompt,
  parseExecutionResult,
  parseReviewResult,
  probeCli,
  reviewJsonSchema,
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

const REQUIRED_FLAGS = [
  "--input-format",
  "--output-format",
  "--json-schema",
  "--project",
  "--model",
  "--dangerously-skip-permissions",
  "--add-dir",
];

export class AntigravityAdapter implements WorkerAdapter {
  public readonly id = "antigravity" as const;

  public constructor(private readonly processes: ProcessRunner) {}

  public async probe(
    profile: WorkerExecutionRequest["profile"],
    project: WorkerExecutionRequest["project"],
  ): Promise<WorkerProbeResult> {
    return await probeCli(this.id, profile, project, this.processes, REQUIRED_FLAGS);
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
    const projectId = request.project.adapterProjectIds?.antigravity ?? request.task.projectId;
    return await this.processes.run(
      request.profile.command,
      [
        ...request.profile.args,
        "--project",
        projectId,
        "--model",
        request.profile.model,
        ...(request.profile.reasoningEffort ? ["--effort", request.profile.reasoningEffort] : []),
        "--mode",
        review ? "plan" : "accept-edits",
        ...(!review ? ["--dangerously-skip-permissions"] : []),
        ...(review
          ? ["--add-dir", request.runtimeDirectory, "--json-schema", reviewJsonSchema()]
          : []),
        "-p=",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--print-timeout",
        `${String(Math.ceil(request.timeoutMs / 60_000))}m`,
      ],
      {
        cwd: request.worktreePath,
        timeoutMs: request.timeoutMs,
        maxCaptureBytes: request.maxCaptureBytes,
        stdin: `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`,
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.onProcessSpawn ? { onSpawn: request.onProcessSpawn } : {}),
        ...(request.onProcessExit ? { onExit: request.onProcessExit } : {}),
      },
    );
  }
}
