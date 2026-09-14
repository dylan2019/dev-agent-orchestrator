import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type { TaskStore } from "../../application/ports/task-store.js";
import { parseTaskAggregate } from "../../domain/schema.js";
import type { DomainEvent, TaskAggregate, TransitionResult } from "../../domain/types.js";
import { OrchestratorError, wrapError } from "../../shared/errors.js";

const SCHEMA_VERSION = 1;

interface AggregateRow {
  readonly aggregate_json: string;
}

interface LeaseRow {
  readonly task_id: string;
}

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

function deserializeTask(value: string): TaskAggregate {
  try {
    return parseTaskAggregate(JSON.parse(value) as unknown);
  } catch (error) {
    throw wrapError("TASK_STATE_CORRUPT", "Persisted Task aggregate is invalid", error);
  }
}

export class SqliteTaskStore implements TaskStore {
  private readonly database: Database.Database;

  public constructor(file: string) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
      this.database = new Database(file);
      this.database.pragma("journal_mode = WAL");
      this.database.pragma("synchronous = FULL");
      this.database.pragma("foreign_keys = ON");
      this.database.pragma("busy_timeout = 5000");
      this.migrate();
      this.rebuildSnapshots();
    } catch (error) {
      throw wrapError("STATE_STORE_OPEN_FAILED", "Unable to open durable state store", error, {
        file,
      });
    }
  }

  public create(result: TransitionResult): void {
    this.persist(undefined, result);
  }

  public save(expectedRevision: number, result: TransitionResult): void {
    this.persist(expectedRevision, result);
  }

  public get(taskId: string): TaskAggregate {
    const row = this.database
      .prepare<[string], AggregateRow>("SELECT aggregate_json FROM tasks WHERE id = ?")
      .get(taskId);
    if (!row) {
      throw new OrchestratorError("TASK_NOT_FOUND", "Task does not exist", { taskId });
    }
    return deserializeTask(row.aggregate_json);
  }

  public list(projectId?: string): readonly TaskAggregate[] {
    const rows = projectId
      ? this.database
          .prepare<[string], AggregateRow>(
            "SELECT aggregate_json FROM tasks WHERE project_id = ? ORDER BY updated_at DESC",
          )
          .all(projectId)
      : this.database
          .prepare<[], AggregateRow>("SELECT aggregate_json FROM tasks ORDER BY updated_at DESC")
          .all();
    return rows.map((row) => deserializeTask(row.aggregate_json));
  }

  public rebuildSnapshots(): number {
    const missing = this.database
      .prepare<[], { readonly task_id: string; readonly aggregate_json: string }>(
        `SELECT e.task_id, e.aggregate_json
         FROM task_events e
         JOIN (
           SELECT task_id, MAX(revision) AS revision
           FROM task_events
           GROUP BY task_id
         ) latest ON latest.task_id = e.task_id AND latest.revision = e.revision
         LEFT JOIN tasks t ON t.id = e.task_id
         WHERE t.id IS NULL`,
      )
      .all();
    const insert = this.database.prepare(
      `INSERT INTO tasks(id, project_id, state, revision, aggregate_json, updated_at)
       VALUES(@id, @projectId, @state, @revision, @aggregateJson, @updatedAt)`,
    );
    const rebuild = this.database.transaction(() => {
      for (const row of missing) {
        const task = deserializeTask(row.aggregate_json);
        insert.run({
          id: task.id,
          projectId: task.projectId,
          state: task.state,
          revision: task.revision,
          aggregateJson: row.aggregate_json,
          updatedAt: task.updatedAt,
        });
      }
    });
    rebuild();
    return missing.length;
  }

  public acquireWriterLease(projectId: string, taskId: string, acquiredAt: string): void {
    try {
      this.database
        .prepare("INSERT INTO writer_leases(project_id, task_id, acquired_at) VALUES(?, ?, ?)")
        .run(projectId, taskId, acquiredAt);
    } catch (error) {
      const owner = this.writerLeaseOwner(projectId);
      throw wrapError("WRITER_LEASE_BUSY", "Project already has a writer Task", error, {
        projectId,
        requestedTaskId: taskId,
        owner: owner ?? "unknown",
      });
    }
  }

  public releaseWriterLease(projectId: string, taskId: string): void {
    const result = this.database
      .prepare("DELETE FROM writer_leases WHERE project_id = ? AND task_id = ?")
      .run(projectId, taskId);
    if (result.changes !== 1) {
      throw new OrchestratorError("WRITER_LEASE_MISMATCH", "Writer lease is not owned by Task", {
        projectId,
        taskId,
        owner: this.writerLeaseOwner(projectId) ?? null,
      });
    }
  }

  public writerLeaseOwner(projectId: string): string | undefined {
    return this.database
      .prepare<[string], LeaseRow>("SELECT task_id FROM writer_leases WHERE project_id = ?")
      .get(projectId)?.task_id;
  }

  public close(): void {
    this.database.close();
  }

  private persist(expectedRevision: number | undefined, result: TransitionResult): void {
    const task = parseTaskAggregate(result.task);
    this.assertEventMatchesTask(result.event, task);
    const aggregateJson = serialize(task);
    const payloadJson = serialize(result.event.payload);
    const transaction = this.database.transaction(() => {
      if (expectedRevision === undefined) {
        this.database
          .prepare(
            `INSERT INTO tasks(id, project_id, state, revision, aggregate_json, updated_at)
             VALUES(?, ?, ?, ?, ?, ?)`,
          )
          .run(task.id, task.projectId, task.state, task.revision, aggregateJson, task.updatedAt);
      } else {
        const updated = this.database
          .prepare(
            `UPDATE tasks
             SET state = ?, revision = ?, aggregate_json = ?, updated_at = ?
             WHERE id = ? AND revision = ?`,
          )
          .run(task.state, task.revision, aggregateJson, task.updatedAt, task.id, expectedRevision);
        if (updated.changes !== 1) {
          const actual = this.database
            .prepare<[string], { readonly revision: number }>(
              "SELECT revision FROM tasks WHERE id = ?",
            )
            .get(task.id)?.revision;
          throw new OrchestratorError("TASK_REVISION_CONFLICT", "Task revision is stale", {
            taskId: task.id,
            expectedRevision,
            actualRevision: actual ?? null,
          });
        }
      }
      this.database
        .prepare(
          `INSERT INTO task_events(task_id, revision, event_type, occurred_at, payload_json, aggregate_json)
           VALUES(?, ?, ?, ?, ?, ?)`,
        )
        .run(
          task.id,
          task.revision,
          result.event.type,
          result.event.occurredAt,
          payloadJson,
          aggregateJson,
        );
    });
    try {
      transaction();
    } catch (error) {
      if (error instanceof OrchestratorError) {
        throw error;
      }
      throw wrapError("TASK_STATE_WRITE_FAILED", "Unable to persist Task transition", error, {
        taskId: task.id,
        revision: task.revision,
      });
    }
  }

  private assertEventMatchesTask(domainEvent: DomainEvent, task: TaskAggregate): void {
    if (
      domainEvent.taskId !== task.id ||
      domainEvent.revision !== task.revision ||
      domainEvent.occurredAt !== task.updatedAt
    ) {
      throw new OrchestratorError(
        "DOMAIN_EVENT_MISMATCH",
        "Domain event does not match Task transition",
      );
    }
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        state TEXT NOT NULL,
        revision INTEGER NOT NULL,
        aggregate_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_project_updated
        ON tasks(project_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS task_events (
        task_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        aggregate_json TEXT NOT NULL,
        PRIMARY KEY(task_id, revision)
      );
      CREATE TABLE IF NOT EXISTS writer_leases (
        project_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        acquired_at TEXT NOT NULL
      );
    `);
    const current = this.database
      .prepare<[], { readonly version: number }>("SELECT version FROM schema_meta LIMIT 1")
      .get();
    if (!current) {
      this.database.prepare("INSERT INTO schema_meta(version) VALUES(?)").run(SCHEMA_VERSION);
      return;
    }
    if (current.version !== SCHEMA_VERSION) {
      throw new OrchestratorError("STATE_SCHEMA_UNSUPPORTED", "State schema is unsupported", {
        expected: SCHEMA_VERSION,
        actual: current.version,
      });
    }
  }
}
