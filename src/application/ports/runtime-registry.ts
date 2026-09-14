export type RuntimeProcessRole = "runner" | "worker";

export interface RuntimeProcessRecord {
  readonly taskId: string;
  readonly role: RuntimeProcessRole;
  readonly pid: number;
  readonly identity: string;
  readonly startedAt: string;
}

export interface RuntimeRegistry {
  register(record: RuntimeProcessRecord): void;
  clear(taskId: string, role: RuntimeProcessRole, pid: number, identity: string): void;
  get(taskId: string, role: RuntimeProcessRole): RuntimeProcessRecord | undefined;
  list(taskId: string): readonly RuntimeProcessRecord[];
  close(): void;
}
