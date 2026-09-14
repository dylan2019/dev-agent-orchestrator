import { ControlService } from "../application/control-service.js";
import { DoctorService } from "../application/doctor-service.js";
import { NodeRunnerLauncher } from "../infrastructure/process/node-runner-launcher.js";
import { createRuntimeComponents } from "./components.js";

export function createControlRuntime(runnerFile: string, home?: string) {
  const components = createRuntimeComponents(home);
  const launcher = new NodeRunnerLauncher(runnerFile, components.paths.home);
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
    ),
    close: () => components.close(),
  };
}
