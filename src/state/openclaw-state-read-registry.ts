import type { DatabaseSync } from "node:sqlite";
import {
  readSandboxBrowserRegistryInDatabase,
  readSandboxRegistryEntryInDatabase,
  readSandboxRegistryInDatabase,
  readSandboxRuntimeIdsInDatabase,
} from "../agents/sandbox/registry.kernel.js";
import { listRegistryWorktreesInDatabase } from "../agents/worktrees/registry-read.kernel.js";
import { readWorktreeRunLeaseStateInDatabase } from "../agents/worktrees/run-lease-owner.js";
import { getFleetCellInDatabase, listFleetCellsInDatabase } from "../fleet/registry.kernel.js";
import { readPreparedPoolPresenceDemandInDatabase } from "../gateway/worker-environments/prepared-pool-presence-store.worker.js";
import {
  readWorkerEnvironmentFacts,
  readWorkerEnvironmentPrunePage,
} from "../gateway/worker-environments/store-row-codec.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadResult,
} from "./openclaw-state-read.types.js";

export function readStateRegistryCommand(
  db: DatabaseSync,
  command: Extract<
    OpenClawStateReadCommand,
    {
      type:
        | "worktrees.cleanupState"
        | "preparedPoolPresence.read"
        | "workerEnvironments.snapshot"
        | "workerEnvironments.pruneCandidates"
        | "fleet.list"
        | "fleet.get"
        | "sandboxRegistry.list"
        | "sandboxRegistry.get"
        | "sandboxRegistry.runtimeIds"
        | "sandboxRegistry.browsers";
    }
  >,
): OpenClawStateReadResult {
  if (command.type === "preparedPoolPresence.read") {
    return { type: command.type, demand: readPreparedPoolPresenceDemandInDatabase(db) };
  }
  if (command.type === "workerEnvironments.snapshot") {
    return {
      type: command.type,
      facts: runSqliteDeferredTransactionSync(db, () =>
        readWorkerEnvironmentFacts(db, command.ids),
      ),
    };
  }
  if (command.type === "workerEnvironments.pruneCandidates") {
    return {
      type: command.type,
      page: readWorkerEnvironmentPrunePage(db, command.input),
    };
  }
  if (command.type === "sandboxRegistry.list") {
    return { type: command.type, entries: readSandboxRegistryInDatabase(db) };
  }
  if (command.type === "sandboxRegistry.get") {
    return {
      type: command.type,
      entry: readSandboxRegistryEntryInDatabase(db, command.containerName),
    };
  }
  if (command.type === "sandboxRegistry.runtimeIds") {
    return {
      type: command.type,
      runtimeIds: readSandboxRuntimeIdsInDatabase(db, command),
    };
  }
  if (command.type === "sandboxRegistry.browsers") {
    return { type: command.type, entries: readSandboxBrowserRegistryInDatabase(db) };
  }
  if (command.type === "worktrees.cleanupState") {
    return {
      type: command.type,
      records: listRegistryWorktreesInDatabase(db),
      leases: readWorktreeRunLeaseStateInDatabase(db),
    };
  }
  return command.type === "fleet.list"
    ? { type: command.type, cells: listFleetCellsInDatabase(db) }
    : { type: command.type, cell: getFleetCellInDatabase(db, command.tenantId) };
}
