export interface ProcessRunOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxCaptureBytes: number;
  readonly captureMode?: "head" | "tail";
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string | Buffer;
  readonly signal?: AbortSignal;
  readonly onSpawn?: (pid: number) => void | Promise<void>;
  readonly onExit?: (pid: number) => void | Promise<void>;
  readonly onStdout?: (chunk: Buffer) => void;
  readonly onStderr?: (chunk: Buffer) => void;
}

export interface ProcessRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly durationMs: number;
}

export interface ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options: ProcessRunOptions,
  ): Promise<ProcessRunResult>;
}
