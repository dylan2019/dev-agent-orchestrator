import type { WorkerAdapterId } from "../configuration/schema.js";
import type { ProcessRunner } from "../application/ports/process-runner.js";
import { OrchestratorError } from "../shared/errors.js";
import { AntigravityAdapter } from "./antigravity.js";
import { CursorAdapter } from "./cursor.js";
import type { WorkerAdapter } from "./types.js";
import { WorkbuddyAdapter } from "./workbuddy.js";
import { ZcodeAdapter } from "./zcode.js";

export class WorkerAdapterRegistry {
  private readonly adapters: ReadonlyMap<WorkerAdapterId, WorkerAdapter>;

  public constructor(processes: ProcessRunner) {
    const adapters = [
      new CursorAdapter(processes),
      new AntigravityAdapter(processes),
      new WorkbuddyAdapter(processes),
      new ZcodeAdapter(processes),
    ];
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  public get(id: WorkerAdapterId): WorkerAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new OrchestratorError("WORKER_ADAPTER_NOT_FOUND", "Worker Adapter is not registered", {
        adapter: id,
      });
    }
    return adapter;
  }

  public list(): readonly WorkerAdapter[] {
    return [...this.adapters.values()];
  }
}
