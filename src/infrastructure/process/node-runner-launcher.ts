import { spawn } from "node:child_process";
import fs from "node:fs";

import type { RunnerLauncher } from "../../application/ports/runner-launcher.js";
import { OrchestratorError, wrapError } from "../../shared/errors.js";

export class NodeRunnerLauncher implements RunnerLauncher {
  public constructor(
    private readonly runnerFile: string,
    private readonly runtimeHome: string,
  ) {}

  public async launch(taskId: string): Promise<number> {
    if (!fs.existsSync(this.runnerFile)) {
      throw new OrchestratorError("RUNNER_NOT_BUILT", "Runner entrypoint does not exist", {
        runnerFile: this.runnerFile,
      });
    }
    return await new Promise<number>((resolve, reject) => {
      let settled = false;
      const child = spawn(process.execPath, [this.runnerFile, "--task-id", taskId], {
        cwd: this.runtimeHome,
        env: { ...process.env, DEV_AGENT_ORCHESTRATOR_HOME: this.runtimeHome },
        detached: true,
        windowsHide: true,
        stdio: "ignore",
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
        resolve(child.pid);
      });
    });
  }
}
