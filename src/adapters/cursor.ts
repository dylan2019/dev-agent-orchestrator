import path from "node:path";

import type { ProcessRunner } from "../application/ports/process-runner.js";
import { isEnvironmentTemplatePath } from "../domain/scope.js";
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

const REQUIRED_FLAGS = ["--output-format", "--mode", "--model", "--force", "--add-dir"];

export class CursorAdapter implements WorkerAdapter {
  public readonly id = "cursor" as const;

  public constructor(private readonly processes: ProcessRunner) {}

  public async probe(
    profile: WorkerExecutionRequest["profile"],
    project: WorkerExecutionRequest["project"],
  ): Promise<WorkerProbeResult> {
    return await probeCli(this.id, profile, project, this.processes, REQUIRED_FLAGS);
  }

  public async implement(request: WorkerExecutionRequest): Promise<WorkerExecutionResult> {
    return await this.execute(request, implementationPrompt(request.task, request.project), false);
  }

  public async review(request: ReviewExecutionRequest): Promise<ReviewExecutionResult> {
    return await withEphemeralFiles(
      request.runtimeDirectory,
      { "candidate.patch": request.candidatePatch },
      async (patchPaths) => {
        const patchFile = patchPaths["candidate.patch"];
        if (!patchFile) {
          throw new Error("Candidate patch file was not created");
        }
        return await this.executeReview(
          request,
          reviewPrompt(request.task, request.project, patchFile),
        );
      },
    );
  }

  private async execute(
    request: WorkerExecutionRequest,
    prompt: string,
    review: boolean,
  ): Promise<WorkerExecutionResult> {
    return await withEphemeralFiles(
      request.runtimeDirectory,
      { "task.md": prompt, "cli-config.json": this.cursorConfig(request, review) },
      async (paths) => {
        const promptFile = paths["task.md"];
        const configFile = paths["cli-config.json"];
        if (!promptFile || !configFile) {
          throw new Error("Cursor ephemeral input was not created");
        }
        const result = await this.processes.run(
          request.profile.command,
          [
            ...request.profile.args,
            "-p",
            "--output-format",
            "stream-json",
            "--trust",
            "--model",
            request.profile.model,
            ...(review ? ["--mode=ask"] : ["--force"]),
            "--add-dir",
            path.dirname(promptFile),
            `Read ${path.basename(promptFile)} completely and follow it as the only task input.`,
          ],
          {
            cwd: request.worktreePath,
            timeoutMs: request.timeoutMs,
            maxCaptureBytes: request.maxCaptureBytes,
            env: { ...process.env, CURSOR_CONFIG_DIR: path.dirname(configFile) },
            ...(request.signal ? { signal: request.signal } : {}),
            ...(request.onProcessSpawn ? { onSpawn: request.onProcessSpawn } : {}),
            ...(request.onProcessExit ? { onExit: request.onProcessExit } : {}),
          },
        );
        return parseExecutionResult(this.id, result);
      },
    );
  }

  private async executeReview(
    request: ReviewExecutionRequest,
    prompt: string,
  ): Promise<ReviewExecutionResult> {
    return await withEphemeralFiles(
      request.runtimeDirectory,
      { "review.md": prompt, "cli-config.json": this.cursorConfig(request, true) },
      async (paths) => {
        const promptFile = paths["review.md"];
        const configFile = paths["cli-config.json"];
        if (!promptFile || !configFile) {
          throw new Error("Cursor review input was not created");
        }
        const result = await this.processes.run(
          request.profile.command,
          [
            ...request.profile.args,
            "-p",
            "--output-format",
            "stream-json",
            "--trust",
            "--model",
            request.profile.model,
            "--mode=ask",
            "--add-dir",
            request.runtimeDirectory,
            `Read ${path.basename(promptFile)} completely and follow it as the only review input.`,
          ],
          {
            cwd: request.worktreePath,
            timeoutMs: request.timeoutMs,
            maxCaptureBytes: request.maxCaptureBytes,
            env: { ...process.env, CURSOR_CONFIG_DIR: path.dirname(configFile) },
            ...(request.signal ? { signal: request.signal } : {}),
            ...(request.onProcessSpawn ? { onSpawn: request.onProcessSpawn } : {}),
            ...(request.onProcessExit ? { onExit: request.onProcessExit } : {}),
          },
        );
        return parseReviewResult(this.id, result);
      },
    );
  }

  private cursorConfig(request: WorkerExecutionRequest, review: boolean): string {
    const scope = request.task.scopeGrants.at(-1);
    const paths = review ? [] : (scope?.paths ?? []);
    const allowsEnvironmentTemplate = paths.some(isEnvironmentTemplatePath);
    return JSON.stringify({
      version: 1,
      approvalMode: "allowlist",
      sandbox: { mode: "disabled", networkAccess: "deny" },
      attribution: { attributeCommitsToAgent: false, attributePRsToAgent: false },
      permissions: {
        allow: [
          "Read(**)",
          ...request.profile.shellAllow,
          ...paths.flatMap((item) => [`Write(${item})`, `Write(${item}/**)`]),
        ],
        deny: [
          "Shell(git*)",
          "Shell(gh*)",
          "Shell(rm*)",
          "Shell(del*)",
          "Shell(Remove-Item*)",
          "Shell(rtk:git commit*)",
          "Shell(rtk:git push*)",
          "Shell(rtk:git reset*)",
          "Shell(rtk:git checkout*)",
          "Shell(rtk:git clean*)",
          ...(allowsEnvironmentTemplate
            ? ["Read(.env)", "Write(.env)", "Read(**/.env)", "Write(**/.env)"]
            : ["Read(.env*)", "Write(.env*)", "Read(**/.env*)", "Write(**/.env*)"]),
          "Read(**/*.key)",
          "Write(**/*.key)",
          "Read(**/*.pem)",
          "Write(**/*.pem)",
          "Write(.git/**)",
        ],
      },
    });
  }
}
