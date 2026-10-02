import { requestSessionEntryCurrentAdmission } from "../config/sessions/session-entry-current-admission.worker.js";
import type { SessionEntryCurrentSource } from "../config/sessions/session-entry-current.types.js";
import { deferSqliteWorkerCommitReceipt } from "../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "./openclaw-state-db.js";
import {
  acceptSessionRepositoryWorkspaceCheckpointInDatabase,
  bindSessionRepositoryWorkspaceBaseInDatabase,
  createSessionRepositoryWorkspaceInDatabase,
  deleteSessionRepositoryWorkspaceInDatabase,
  findSessionRepositoryWorkspaceInDatabase,
  readSessionRepositoryWorkspaceInDatabase,
} from "./session-repository-workspaces.kernel.js";
import type { RepositoryWorkspaceMutationResult } from "./session-repository-workspaces.types.js";
import type { RepositoryWorkspaceWorkerOperations } from "./session-repository-workspaces.worker-contract.js";
import type { WorkerOperationHandlersFor } from "./worker-operation-registry.js";

export const repositoryWorkspaceOperations = {
  "repositoryWorkspaces.get": (input, { open }) =>
    readSessionRepositoryWorkspaceInDatabase(open().db, input.workspaceId),
  "repositoryWorkspaces.find": (input, { open }) =>
    findSessionRepositoryWorkspaceInDatabase(open().db, input),
  "repositoryWorkspaces.create": (input, { open }) =>
    mutate(open(), "repositoryWorkspaces.create", (db) =>
      createSessionRepositoryWorkspaceInDatabase(db, input, input.nowMs ?? Date.now()),
    ),
  "repositoryWorkspaces.bindBase": (input, { open }) =>
    mutate(open(), "repositoryWorkspaces.bindBase", (db) =>
      bindSessionRepositoryWorkspaceBaseInDatabase(db, input, input.nowMs ?? Date.now()),
    ),
  "repositoryWorkspaces.acceptCheckpoint": (input, { open }) =>
    mutate(open(), "repositoryWorkspaces.acceptCheckpoint", (db) =>
      acceptSessionRepositoryWorkspaceCheckpointInDatabase(db, input, input.nowMs ?? Date.now()),
    ),
  "repositoryWorkspaces.delete": (input, { open }) =>
    mutate(
      open(),
      "repositoryWorkspaces.delete",
      (db) => deleteSessionRepositoryWorkspaceInDatabase(db, input.workspaceId),
      input.sessionEntryCurrentSource,
    ),
} satisfies WorkerOperationHandlersFor<RepositoryWorkspaceWorkerOperations>;

function mutate(
  database: OpenClawStateDatabase,
  operationLabel: string,
  operation: (db: OpenClawStateDatabase["db"]) => RepositoryWorkspaceMutationResult,
  sessionEntryCurrentSource?: SessionEntryCurrentSource,
): RepositoryWorkspaceMutationResult {
  const admit = (stage: "transaction" | "commit", facts: unknown) =>
    requestSessionEntryCurrentAdmission(
      sessionEntryCurrentSource,
      { stage, facts },
      { lookup: "logical" },
    );
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      admit("transaction", undefined);
      const result = operation(db);
      admit("commit", result);
      deferSqliteWorkerCommitReceipt(db, result);
      return result;
    },
    { database },
    { operationLabel },
  );
}
