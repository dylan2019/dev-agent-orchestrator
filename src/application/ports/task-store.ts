import type { TaskAggregate, TransitionResult } from "../../domain/types.js";

export interface TaskStore {
  create(result: TransitionResult): void;
  createWithWriterLease(result: TransitionResult, acquiredAt: string): void;
  createWithReclaimedWriterLease(
    result: TransitionResult,
    acquiredAt: string,
    expectedOwnerTaskId: string,
  ): void;
  save(expectedRevision: number, result: TransitionResult): void;
  saveAndReleaseWriterLease(expectedRevision: number, result: TransitionResult): void;
  get(taskId: string): TaskAggregate;
  list(projectId?: string): readonly TaskAggregate[];
  rebuildSnapshots(): number;
  acquireWriterLease(projectId: string, taskId: string, acquiredAt: string): void;
  releaseWriterLease(projectId: string, taskId: string): void;
  writerLeaseOwner(projectId: string): string | undefined;
  close(): void;
}
