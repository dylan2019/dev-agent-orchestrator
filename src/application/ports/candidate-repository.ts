import type { ProjectProfile } from "../../configuration/schema.js";

export interface ProjectGitState {
  readonly root: string;
  readonly branch: string;
  readonly head: string;
  readonly clean: boolean;
  readonly status: string;
}

export interface CandidateInspection {
  readonly worktreePath: string;
  readonly baseCommit: string;
  readonly fingerprint: string;
  readonly changedFiles: readonly string[];
  readonly changedLines: number;
}

export interface CandidatePatch extends CandidateInspection {
  readonly patch: string;
  readonly truncated: boolean;
}

export interface CandidateFilePatch {
  readonly worktreePath: string;
  readonly fingerprint: string;
  readonly file: string;
  readonly patch: string;
  readonly truncated: boolean;
}

export interface PreparedCommit {
  readonly commitHash: string;
  readonly treeHash: string;
}

export interface CandidateRepository {
  inspectProject(project: ProjectProfile): Promise<ProjectGitState>;
  createWorktree(project: ProjectProfile, taskId: string, baseCommit: string): Promise<string>;
  inspect(worktreePath: string): Promise<CandidateInspection>;
  getPatch(worktreePath: string, maxChars: number): Promise<CandidatePatch>;
  getFilePatch(worktreePath: string, file: string, maxChars: number): Promise<CandidateFilePatch>;
  removeWorktree(
    project: ProjectProfile,
    worktreePath: string,
    discardChanges: boolean,
  ): Promise<void>;
  prepareCommit(
    worktreePath: string,
    expectedFingerprint: string,
    message: string,
  ): Promise<PreparedCommit>;
  integrate(
    project: ProjectProfile,
    expectedBaseCommit: string,
    prepared: PreparedCommit,
    push: boolean,
  ): Promise<void>;
}
