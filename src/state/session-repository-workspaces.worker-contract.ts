import type { SessionEntryCurrentSource } from "../config/sessions/session-entry-current.types.js";
import type {
  RepositoryWorkspaceBase,
  RepositoryWorkspaceCheckpoint,
  RepositoryWorkspaceCreate,
  RepositoryWorkspaceMutationResult,
  RepositoryWorkspaceOwner,
  SessionRepositoryWorkspaceRecord,
} from "./session-repository-workspaces.types.js";

type RepositoryWorkspaceInputs = {
  "repositoryWorkspaces.get": { workspaceId: string };
  "repositoryWorkspaces.find": RepositoryWorkspaceOwner;
  "repositoryWorkspaces.create": RepositoryWorkspaceCreate & { nowMs?: number };
  "repositoryWorkspaces.bindBase": RepositoryWorkspaceBase & { nowMs?: number };
  "repositoryWorkspaces.acceptCheckpoint": RepositoryWorkspaceCheckpoint & { nowMs?: number };
  "repositoryWorkspaces.delete": {
    workspaceId: string;
    sessionEntryCurrentSource?: SessionEntryCurrentSource;
  };
};

export type RepositoryWorkspaceWorkerOperations = {
  [Key in keyof RepositoryWorkspaceInputs]: {
    input: RepositoryWorkspaceInputs[Key];
    output: Key extends "repositoryWorkspaces.get" | "repositoryWorkspaces.find"
      ? SessionRepositoryWorkspaceRecord | undefined
      : RepositoryWorkspaceMutationResult;
  };
};
