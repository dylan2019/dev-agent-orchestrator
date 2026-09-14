import type { RuntimeProcessRecord } from "./runtime-registry.js";

export interface ProcessHooks {
  readonly onSpawn: (pid: number) => Promise<void>;
  readonly onExit: (pid: number) => void;
}

export interface ProcessSupervisor {
  workerHooks(taskId: string): ProcessHooks;
  status(record: RuntimeProcessRecord): "owned" | "gone" | "mismatch";
  terminate(record: RuntimeProcessRecord): Promise<void>;
}
