import fs from "node:fs";

import { WorkerAdapterRegistry } from "../adapters/registry.js";
import { GateExecutor } from "../application/gate-executor.js";
import { ConfigFileRepository } from "../configuration/file-repository.js";
import { GitCandidateRepository } from "../infrastructure/git/git-candidate-repository.js";
import { ProductionLogger } from "../infrastructure/logging/production-logger.js";
import { LocalProcessRunner } from "../infrastructure/process/local-process-runner.js";
import { SqliteGateCache } from "../infrastructure/sqlite/gate-cache.js";
import { SqliteRuntimeRegistry } from "../infrastructure/sqlite/runtime-registry.js";
import { SqliteTaskStore } from "../infrastructure/sqlite/task-store.js";
import { OrchestratorError } from "../shared/errors.js";
import { runtimePaths, type RuntimePaths } from "./paths.js";

export interface RuntimeComponents {
  readonly paths: RuntimePaths;
  readonly configRepository: ConfigFileRepository;
  readonly store: SqliteTaskStore;
  readonly gateCache: SqliteGateCache;
  readonly runtimeRegistry: SqliteRuntimeRegistry;
  readonly logger: ProductionLogger;
  readonly processes: LocalProcessRunner;
  readonly candidates: GitCandidateRepository;
  readonly gates: GateExecutor;
  readonly adapters: WorkerAdapterRegistry;
  close(): void;
}

export function createRuntimeComponents(home?: string): RuntimeComponents {
  const paths = runtimePaths(home);
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const configRepository = new ConfigFileRepository(paths.configFile);
  if (!configRepository.exists()) {
    throw new OrchestratorError(
      "CONFIG_NOT_INITIALIZED",
      "Run init before starting the orchestrator",
      {
        configFile: paths.configFile,
      },
    );
  }
  const config = configRepository.read();
  const store = new SqliteTaskStore(paths.stateDatabase);
  const gateCache = new SqliteGateCache(paths.stateDatabase);
  const runtimeRegistry = new SqliteRuntimeRegistry(paths.stateDatabase);
  const logger = new ProductionLogger(paths.eventLog, config.logging.maxBytes);
  const processes = new LocalProcessRunner();
  const candidates = new GitCandidateRepository(config.runtime.gitCommand, processes);
  const gates = new GateExecutor(processes, candidates, gateCache, logger);
  const adapters = new WorkerAdapterRegistry(processes);
  return {
    paths,
    configRepository,
    store,
    gateCache,
    runtimeRegistry,
    logger,
    processes,
    candidates,
    gates,
    adapters,
    close: () => {
      runtimeRegistry.close();
      gateCache.close();
      store.close();
    },
  };
}
