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

const REQUIRED_FLAGS = ["--output-format", "--model", "--json-schema", "--add-dir"];

export class WorkbuddyAdapter implements WorkerAdapter {
  public readonly id = "workbuddy" as const;

  public constructor(private readonly processes: ProcessRunner) {}

  public async probe(
    profile: WorkerExecutionRequest["profile"],
    project: WorkerExecutionRequest["project"],
  ): Promise<WorkerProbeResult> {
    return await probeCli(this.id, profile, project, this.processes, REQUIRED_FLAGS, ["--help"]);
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
    return await this.processes.run(
      request.profile.command,
      [
        ...request.profile.args,
        "-p",
        "--output-format",
        "stream-json",
        "--model",
        request.profile.model,
        ...(request.profile.reasoningEffort ? ["--effort", request.profile.reasoningEffort] : []),
        ...(review
          ? [
              "--permission-mode",
              "plan",
              "--add-dir",
              request.runtimeDirectory,
              "--json-schema",
              reviewJsonSchema(),
            ]
          : ["-y"]),
      ],
      {
        cwd: request.worktreePath,
        timeoutMs: request.timeoutMs,
        maxCaptureBytes: request.maxCaptureBytes,
        maxTotalOutputBytes: request.maxCaptureBytes,
        stdin: prompt,
        ...(request.signal ? { signal: request.signal } : {}),
        ...(request.onProcessSpawn ? { onSpawn: request.onProcessSpawn } : {}),
        ...(request.onProcessExit ? { onExit: request.onProcessExit } : {}),
        ...(request.onStdoutActivity ? { onStdout: request.onStdoutActivity } : {}),
      },
    );
  }
}
