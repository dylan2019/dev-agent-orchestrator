import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type { GateCache, GateCacheEntry } from "../../application/ports/gate-cache.js";
import type { GateResult } from "../../domain/types.js";
import { wrapError } from "../../shared/errors.js";

interface GateCacheRow {
  readonly cache_key: string;
  readonly run_id: string;
  readonly result_json: string;
  readonly created_at: string;
}

export class SqliteGateCache implements GateCache {
  private readonly database: Database.Database;

  public constructor(file: string) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
      this.database = new Database(file);
      this.database.pragma("journal_mode = WAL");
      this.database.pragma("synchronous = FULL");
      this.database.pragma("busy_timeout = 5000");
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS gate_cache (
          cache_key TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          result_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);
    } catch (error) {
      throw wrapError("GATE_CACHE_OPEN_FAILED", "Unable to open Gate cache", error, { file });
    }
  }

  public get(cacheKey: string): GateCacheEntry | undefined {
    const row = this.database
      .prepare<[string], GateCacheRow>(
        "SELECT cache_key, run_id, result_json, created_at FROM gate_cache WHERE cache_key = ?",
      )
      .get(cacheKey);
    if (!row) {
      return undefined;
    }
    try {
      return {
        cacheKey: row.cache_key,
        runId: row.run_id,
        result: JSON.parse(row.result_json) as GateResult,
        createdAt: row.created_at,
      };
    } catch (error) {
      throw wrapError("GATE_CACHE_CORRUPT", "Gate cache entry is invalid", error, { cacheKey });
    }
  }

  public put(entry: GateCacheEntry): void {
    if (entry.result.status !== "pass") {
      return;
    }
    try {
      this.database
        .prepare(
          `INSERT INTO gate_cache(cache_key, run_id, result_json, created_at)
           VALUES(?, ?, ?, ?)
           ON CONFLICT(cache_key) DO UPDATE SET
             run_id = excluded.run_id,
             result_json = excluded.result_json,
             created_at = excluded.created_at`,
        )
        .run(entry.cacheKey, entry.runId, JSON.stringify(entry.result), entry.createdAt);
    } catch (error) {
      throw wrapError("GATE_CACHE_WRITE_FAILED", "Unable to write Gate cache", error, {
        cacheKey: entry.cacheKey,
      });
    }
  }

  public close(): void {
    this.database.close();
  }
}
