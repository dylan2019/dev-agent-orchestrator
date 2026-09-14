import { TaskExecutionService } from "../../application/task-execution-service.js";
import { blockExternally } from "../../domain/task.js";
import { processIdentity } from "../../infrastructure/process/process-identity.js";
import { createRuntimeComponents } from "../../runtime/components.js";
import { OrchestratorError } from "../../shared/errors.js";

function taskIdFromArgs(): string {
  const index = process.argv.indexOf("--task-id");
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    throw new OrchestratorError("TASK_ID_REQUIRED", "Runner requires --task-id");
  }
  return value;
}

const taskId = taskIdFromArgs();
const components = createRuntimeComponents();
const identity = processIdentity(process.pid);
if (!identity) {
  components.close();
  throw new OrchestratorError("PROCESS_IDENTITY_UNAVAILABLE", "Runner identity is unavailable");
}
components.runtimeRegistry.register({
  taskId,
  role: "runner",
  pid: process.pid,
  identity,
  startedAt: new Date().toISOString(),
});

try {
  const execution = new TaskExecutionService(
    components.configRepository,
    components.store,
    components.candidates,
    components.gates,
    components.adapters,
    components.runtimeRegistry,
    components.logger,
    components.paths.tasksDirectory,
  );
  await execution.advance(taskId);
} catch (error) {
  try {
    const task = components.store.get(taskId);
    if (
      [
        "CREATED",
        "SCOPING",
        "IMPLEMENTING",
        "VERIFYING",
        "INDEPENDENT_REVIEWING",
        "ACCEPTING",
      ].includes(task.state)
    ) {
      const blocked = blockExternally(task, {
        reason: "process_lost",
        message: error instanceof Error ? error.message : String(error),
        blockedAt: new Date().toISOString(),
        resumeState: task.state as
          | "CREATED"
          | "SCOPING"
          | "IMPLEMENTING"
          | "VERIFYING"
          | "INDEPENDENT_REVIEWING"
          | "ACCEPTING",
      });
      components.store.save(task.revision, blocked);
    }
  } catch {
    // The original Runner failure remains authoritative; doctor reports unreconciled state.
  }
  components.logger.write({
    level: "error",
    event: "error",
    taskId,
    errorCode: error instanceof OrchestratorError ? error.code : "RUNNER_UNHANDLED_ERROR",
    message: error instanceof Error ? error.message : String(error),
    outcome: "fail",
  });
  process.exitCode = 1;
} finally {
  try {
    const record = components.runtimeRegistry.get(taskId, "runner");
    if (record?.pid === process.pid && record.identity === identity) {
      components.runtimeRegistry.clear(taskId, "runner", process.pid, identity);
    }
  } finally {
    components.close();
  }
}
