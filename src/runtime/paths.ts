import os from "node:os";
import path from "node:path";

export interface RuntimePaths {
  readonly home: string;
  readonly configFile: string;
  readonly stateDatabase: string;
  readonly eventLog: string;
  readonly tasksDirectory: string;
}

export function runtimePaths(explicitHome?: string): RuntimePaths {
  const home = path.resolve(
    explicitHome ??
      process.env.DEV_AGENT_ORCHESTRATOR_HOME?.trim() ??
      path.join(os.homedir(), ".dev-agent-orchestrator"),
  );
  return {
    home,
    configFile: path.join(home, "config.json"),
    stateDatabase: path.join(home, "state", "orchestrator.db"),
    eventLog: path.join(home, "logs", "events.jsonl"),
    tasksDirectory: path.join(home, "tasks"),
  };
}
