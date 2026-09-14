import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

import type {
  ProcessRunner,
  ProcessRunOptions,
  ProcessRunResult,
} from "../../application/ports/process-runner.js";
import { OrchestratorError, wrapError } from "../../shared/errors.js";

interface BoundedCapture {
  readonly chunks: Buffer[];
  readonly retainedBytes: number;
}

function appendCapture(
  current: BoundedCapture,
  chunk: Buffer,
  limit: number,
  mode: "head" | "tail",
): BoundedCapture {
  if (mode === "head") {
    const remaining = limit - current.retainedBytes;
    if (remaining <= 0) {
      return current;
    }
    const retained = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    return {
      chunks: [...current.chunks, retained],
      retainedBytes: current.retainedBytes + retained.length,
    };
  }
  if (chunk.length >= limit) {
    return { chunks: [chunk.subarray(chunk.length - limit)], retainedBytes: limit };
  }
  const chunks = [...current.chunks, chunk];
  let retainedBytes = current.retainedBytes + chunk.length;
  while (retainedBytes > limit && chunks.length > 0) {
    const overflow = retainedBytes - limit;
    const first = chunks[0];
    if (!first) {
      break;
    }
    if (first.length <= overflow) {
      chunks.shift();
      retainedBytes -= first.length;
    } else {
      chunks[0] = first.subarray(overflow);
      retainedBytes -= overflow;
    }
  }
  return { chunks, retainedBytes };
}

function resolveInvocation(command: string, args: readonly string[]) {
  const extension = path.extname(command).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    throw new OrchestratorError(
      "BATCH_COMMAND_UNSUPPORTED",
      "Batch commands require an explicit trusted executable wrapper",
      { command },
    );
  }
  if (process.platform === "win32" && extension === ".ps1") {
    return {
      command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        command,
        ...args,
      ],
    };
  }
  return { command, args: [...args] };
}

export function terminateProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new OrchestratorError("INVALID_PROCESS_ID", "Process ID is invalid", { pid });
  }
  if (process.platform === "win32") {
    spawnSync("C:\\Windows\\System32\\taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process already exited.
    }
  }
}

export class LocalProcessRunner implements ProcessRunner {
  public async run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions,
  ): Promise<ProcessRunResult> {
    if (!path.isAbsolute(command)) {
      throw new OrchestratorError("COMMAND_NOT_ABSOLUTE", "Process command must be absolute", {
        command,
      });
    }
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new OrchestratorError("INVALID_PROCESS_TIMEOUT", "Process timeout is invalid");
    }
    if (!Number.isInteger(options.maxCaptureBytes) || options.maxCaptureBytes < 1) {
      throw new OrchestratorError("INVALID_CAPTURE_LIMIT", "Process capture limit is invalid");
    }
    const invocation = resolveInvocation(command, args);
    const startedAt = Date.now();
    let stdout: BoundedCapture = { chunks: [], retainedBytes: 0 };
    let stderr: BoundedCapture = { chunks: [], retainedBytes: 0 };
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let cancelled = false;

    return await new Promise<ProcessRunResult>((resolve, reject) => {
      let settled = false;
      const child = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      const finishError = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        reject(
          wrapError("PROCESS_EXECUTION_FAILED", "Unable to execute process", error, {
            command,
            cause:
              error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
          }),
        );
      };
      const abort = (): void => {
        cancelled = true;
        if (child.pid !== undefined) {
          terminateProcessTree(child.pid);
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid !== undefined) {
          terminateProcessTree(child.pid);
        }
      }, options.timeoutMs);
      const spawnReady =
        child.pid === undefined
          ? Promise.reject(new Error("Process ID is unavailable"))
          : Promise.resolve(options.onSpawn?.(child.pid)).catch((error: unknown) => {
              if (child.pid !== undefined) {
                terminateProcessTree(child.pid);
              }
              throw error;
            });

      child.once("error", finishError);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) {
        abort();
      }
      if (options.stdin !== undefined) {
        if (!child.stdin) {
          finishError(new Error("stdin pipe is unavailable"));
          return;
        }
        child.stdin.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code !== "EPIPE") {
            finishError(error);
          }
        });
        child.stdin.end(options.stdin);
      }
      if (!child.stdout || !child.stderr) {
        abort();
        finishError(new Error("stdout or stderr pipe is unavailable"));
        return;
      }
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        stdout = appendCapture(
          stdout,
          chunk,
          options.maxCaptureBytes,
          options.captureMode ?? "tail",
        );
        options.onStdout?.(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        stderr = appendCapture(
          stderr,
          chunk,
          options.maxCaptureBytes,
          options.captureMode ?? "tail",
        );
        options.onStderr?.(chunk);
      });
      child.once("close", (code) => {
        if (settled) {
          return;
        }
        void spawnReady
          .then(async () => {
            if (child.pid !== undefined) {
              await options.onExit?.(child.pid);
            }
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", abort);
            resolve({
              exitCode: code ?? -1,
              stdout: Buffer.concat(stdout.chunks).toString("utf8"),
              stderr: Buffer.concat(stderr.chunks).toString("utf8"),
              stdoutBytes,
              stderrBytes,
              stdoutTruncated: stdoutBytes > stdout.retainedBytes,
              stderrTruncated: stderrBytes > stderr.retainedBytes,
              timedOut,
              cancelled,
              durationMs: Date.now() - startedAt,
            });
          })
          .catch(finishError);
      });
    });
  }
}
