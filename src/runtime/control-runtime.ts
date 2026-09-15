import { ControlService } from "../application/control-service.js";
import { DoctorService } from "../application/doctor-service.js";
import { NodeRunnerLauncher } from "../infrastructure/process/node-runner-launcher.js";
import type { RunnerLaunchObserver } from "../infrastructure/process/node-runner-launcher.js";
import { createRuntimeComponents } from "./components.js";

export function createControlRuntime(runnerFile: string, home?: string) {
  const components = createRuntimeComponents(home);
  const observer: RunnerLaunchObserver = {
    onLaunched: (taskId, pid) => {
      components.logger.write({
        level: "info",
        event: "runner.launched",
        taskId,
        operation: String(pid),
        outcome: "started",
      });
    },
    onAbnormalExit: (taskId, exitCode, stderrTail) => {
      const detail = stderrTail ? `: ${stderrTail}` : "";
      components.logger.write({
        level: "error",
        event: "runner.exited",
        taskId,
        errorCode: "RUNNER_ABNORMAL_EXIT",
        ...(exitCode === null ? {} : { exitCode }),
        message: `Task Runner exited with ${exitCode ?? "a signal"}${detail}`,
        outcome: "fail",
      });
    },
  };
  const launcher = new NodeRunnerLauncher(runnerFile, components.paths.home, { observer });
  return {
    components,
    control: new ControlService(
      components.configRepository,
      components.store,
      components.candidates,
      launcher,
      components.runtimeRegistry,
      components.supervisor,
      components.logger,
    ),
    doctor: new DoctorService(
      components.configRepository,
      components.candidates,
      components.adapters,
      components.store,
    ),
    close: () => components.close(),
  };
}
