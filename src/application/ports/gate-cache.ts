import type { GateResult } from "../../domain/types.js";

export interface GateCacheEntry {
  readonly cacheKey: string;
  readonly runId: string;
  readonly result: GateResult;
  readonly createdAt: string;
}

export interface GateCache {
  get(cacheKey: string): GateCacheEntry | undefined;
  put(entry: GateCacheEntry): void;
  close(): void;
}
