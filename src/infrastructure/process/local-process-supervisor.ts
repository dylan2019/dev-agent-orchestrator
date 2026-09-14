import type {
  ProcessHooks,
  ProcessSupervisor,
} from "../../application/ports/process-supervisor.js";
import type {
  RuntimeProcessRecord,
  RuntimeRegistry,
} from "../../application/ports/runtime-registry.js";
import { OrchestratorError } from "../../shared/errors.js";
import {
  processIdentity,
  processIsAlive,
  waitForProcessExit,
  waitForProcessIdentity,
} from "./process-identity.js";
import { terminateProcessTree } from "./local-process-runner.js";

export class LocalProcessSupervisor implements ProcessSupervisor {
  public constructor(private readonly registry: RuntimeRegistry) {}

  public workerHooks(taskId: string): ProcessHooks {
    let registered: RuntimeProcessRecord | undefined;
    return {
      onSpawn: async (pid) => {
        const identity = await waitForProcessIdentity(pid);
        if (!identity) {
          throw new OrchestratorError(
            "PROCESS_IDENTITY_UNAVAILABLE",
            "Worker identity is unavailable",
            {
              pid,
            },
          );
        }
        registered = { taskId, role: "worker", pid, identity, startedAt: new Date().toISOString() };
        this.registry.register(registered);
      },
      onExit: (pid) => {
        if (registered?.pid !== pid) {
          return;
        }
        const current = this.registry.get(taskId, "worker");
        if (current?.pid === pid && current.identity === registered.identity) {
          this.registry.clear(taskId, "worker", pid, registered.identity);
        }
      },
    };
  }

  public status(record: RuntimeProcessRecord): "owned" | "gone" | "mismatch" {
    if (!processIsAlive(record.pid)) {
      return "gone";
    }
    return processIdentity(record.pid) === record.identity ? "owned" : "mismatch";
  }

  public async terminate(record: RuntimeProcessRecord): Promise<void> {
    const status = this.status(record);
    if (status === "gone") {
      return;
    }
    if (status === "mismatch") {
      throw new OrchestratorError(
        "RUNTIME_PROCESS_IDENTITY_MISMATCH",
        "Refusing to terminate a reused Process ID",
        { taskId: record.taskId, role: record.role, pid: record.pid },
      );
    }
    terminateProcessTree(record.pid);
    if (!(await waitForProcessExit(record.pid))) {
      throw new OrchestratorError("PROCESS_TERMINATION_FAILED", "Runtime process did not stop", {
        taskId: record.taskId,
        role: record.role,
        pid: record.pid,
      });
    }
  }
}
