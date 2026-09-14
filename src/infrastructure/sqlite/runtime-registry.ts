import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type {
  RuntimeProcessRecord,
  RuntimeProcessRole,
  RuntimeRegistry,
} from "../../application/ports/runtime-registry.js";
import { OrchestratorError, wrapError } from "../../shared/errors.js";

interface RuntimeRow {
  readonly task_id: string;
  readonly role: RuntimeProcessRole;
  readonly pid: number;
  readonly identity: string;
  readonly started_at: string;
}

function fromRow(row: RuntimeRow): RuntimeProcessRecord {
  return {
    taskId: row.task_id,
    role: row.role,
    pid: row.pid,
    identity: row.identity,
    startedAt: row.started_at,
  };
}

export class SqliteRuntimeRegistry implements RuntimeRegistry {
  private readonly database: Database.Database;

  public constructor(file: string) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
      this.database = new Database(file);
      this.database.pragma("journal_mode = WAL");
      this.database.pragma("synchronous = FULL");
      this.database.pragma("busy_timeout = 5000");
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS runtime_processes (
          task_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('runner', 'worker')),
          pid INTEGER NOT NULL,
          identity TEXT NOT NULL,
          started_at TEXT NOT NULL,
          PRIMARY KEY(task_id, role)
        )
      `);
    } catch (error) {
      throw wrapError("RUNTIME_REGISTRY_OPEN_FAILED", "Unable to open runtime registry", error, {
        file,
      });
    }
  }

  public register(record: RuntimeProcessRecord): void {
    try {
      this.database
        .prepare(
          `INSERT INTO runtime_processes(task_id, role, pid, identity, started_at)
           VALUES(?, ?, ?, ?, ?)
           ON CONFLICT(task_id, role) DO UPDATE SET
             pid = excluded.pid,
             identity = excluded.identity,
             started_at = excluded.started_at`,
        )
        .run(record.taskId, record.role, record.pid, record.identity, record.startedAt);
    } catch (error) {
      throw wrapError(
        "RUNTIME_PROCESS_REGISTER_FAILED",
        "Unable to register runtime process",
        error,
        {
          taskId: record.taskId,
          role: record.role,
        },
      );
    }
  }

  public clear(taskId: string, role: RuntimeProcessRole, pid: number, identity: string): void {
    const result = this.database
      .prepare(
        "DELETE FROM runtime_processes WHERE task_id = ? AND role = ? AND pid = ? AND identity = ?",
      )
      .run(taskId, role, pid, identity);
    if (result.changes !== 1) {
      throw new OrchestratorError(
        "RUNTIME_PROCESS_IDENTITY_MISMATCH",
        "Runtime process registration changed before it could be cleared",
        { taskId, role, pid },
      );
    }
  }

  public get(taskId: string, role: RuntimeProcessRole): RuntimeProcessRecord | undefined {
    const row = this.database
      .prepare<[string, RuntimeProcessRole], RuntimeRow>(
        "SELECT task_id, role, pid, identity, started_at FROM runtime_processes WHERE task_id = ? AND role = ?",
      )
      .get(taskId, role);
    return row ? fromRow(row) : undefined;
  }

  public list(taskId: string): readonly RuntimeProcessRecord[] {
    return this.database
      .prepare<[string], RuntimeRow>(
        "SELECT task_id, role, pid, identity, started_at FROM runtime_processes WHERE task_id = ? ORDER BY role",
      )
      .all(taskId)
      .map(fromRow);
  }

  public close(): void {
    this.database.close();
  }
}
