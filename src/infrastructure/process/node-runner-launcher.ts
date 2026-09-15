import { spawn } from "node:child_process";
import fs from "node:fs";

import type { RunnerLauncher } from "../../application/ports/runner-launcher.js";
import { OrchestratorError, wrapError } from "../../shared/errors.js";

export interface RunnerLaunchObserver {
  readonly onLaunched: (taskId: string, pid: number) => void;
  readonly onAbnormalExit: (taskId: string, exitCode: number | null, stderrTail: string) => void;
}

export interface RunnerLauncherOptions {
  readonly observer?: RunnerLaunchObserver;
  readonly maxCapturedBytes?: number;
}

const DEFAULT_MAX_CAPTURED_BYTES = 2_048;

class BoundedCapture {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;

  public constructor(private readonly maxBytes: number) {}

  public push(chunk: Buffer): void {
    if (this.bytes >= this.maxBytes) {
      return;
    }
    this.chunks.push(chunk);
    this.bytes += chunk.length;
  }

  public tail(): string {
    if (this.bytes === 0) {
      return "";
    }
    const buffer = Buffer.concat(this.chunks);
    const start = Math.max(0, buffer.length - this.maxBytes);
    return buffer.subarray(start).toString("utf8").trimEnd();
  }
}

export class NodeRunnerLauncher implements RunnerLauncher {
  private readonly maxCapturedBytes: number;

  public constructor(
    private readonly runnerFile: string,
    private readonly runtimeHome: string,
    private readonly options: RunnerLauncherOptions = {},
  ) {
    const maxCapturedBytes = options.maxCapturedBytes ?? DEFAULT_MAX_CAPTURED_BYTES;
    if (!Number.isInteger(maxCapturedBytes) || maxCapturedBytes < 256) {
      throw new OrchestratorError("INVALID_CAPTURE_LIMIT", "Runner capture limit is invalid");
    }
    this.maxCapturedBytes = maxCapturedBytes;
  }

  public async launch(taskId: string): Promise<number> {
    if (!fs.existsSync(this.runnerFile)) {
      throw new OrchestratorError("RUNNER_NOT_BUILT", "Runner entrypoint does not exist", {
        runnerFile: this.runnerFile,
      });
    }
    return await new Promise<number>((resolve, reject) => {
      let settled = false;
      const stderrCapture = new BoundedCapture(this.maxCapturedBytes);
      const child = spawn(process.execPath, [this.runnerFile, "--task-id", taskId], {
        cwd: this.runtimeHome,
        env: { ...process.env, DEV_AGENT_ORCHESTRATOR_HOME: this.runtimeHome },
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", () => {
        // Runner output stays inside its own bounded capture and never reaches the parent process.
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrCapture.push(chunk);
      });
      for (const stream of [child.stdout, child.stderr]) {
        stream?.on("error", () => {
          // A broken diagnostic pipe is reported through process exit, not through this stream.
        });
      }
      child.once("exit", (exitCode, signal) => {
        if (exitCode === 0) {
          return;
        }
        this.options.observer?.onAbnormalExit(taskId, exitCode, signal ?? stderrCapture.tail());
      });
      child.once("error", (error) => {
        if (!settled) {
          settled = true;
          reject(
            wrapError("RUNNER_START_FAILED", "Unable to start Task Runner", error, { taskId }),
          );
        }
      });
      child.once("spawn", () => {
        if (settled || child.pid === undefined) {
          return;
        }
        settled = true;
        child.unref();
        this.options.observer?.onLaunched(taskId, child.pid);
        resolve(child.pid);
      });
    });
  }
}
