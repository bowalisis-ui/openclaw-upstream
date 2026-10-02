import type { DatabaseSync } from "node:sqlite";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import {
  assertTransactionUsable,
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
} from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { sessionChanges, type SessionRowFacts } from "../../sessions/session-row-changes.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../../state/openclaw-state-db-contract.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { assignSessionOwner } from "./session-accessor.sqlite-owner.js";
import { readSqliteSessionParticipantProjection } from "./session-accessor.sqlite-participant-projection.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import {
  applySessionGroupCategoryMutation,
  assertSessionGroupCategoryDestination,
  prepareSessionGroupCategoryMutation,
} from "./session-group-categories.kernel.js";
import { addSessionMember, removeSessionMember } from "./session-sharing-store.native.js";
import {
  addSessionSuggestion,
  claimSessionSuggestionDispatch,
  finalizeSessionSuggestionClaim,
  releaseSessionSuggestionDispatch,
} from "./session-suggestion-store.js";

type MembershipPublication = { facts?: Extract<SessionRowFacts, { kind: "member" }> };
type OwnerPublication = { facts?: Extract<SessionRowFacts, { kind: "owner" }> };
type ParticipantPublication = {
  projectionChanged: boolean;
  participants: ReturnType<typeof readSqliteSessionParticipantProjection>;
};

export type SessionSharingWorkerOperations = {
  "owner.assign": {
    input: {
      scope: SessionAccessScope;
      params: Omit<Parameters<typeof assignSessionOwner>[1], "assertCurrent">;
    };
    output: { value: ReturnType<typeof assignSessionOwner> } & OwnerPublication;
  };
  "suggestion.add": {
    input: { scope: SessionAccessScope; params: Parameters<typeof addSessionSuggestion>[1] };
    output: ReturnType<typeof addSessionSuggestion>;
  };
  "suggestion.claim": {
    input: {
      scope: SessionAccessScope;
      params: Parameters<typeof claimSessionSuggestionDispatch>[1];
    };
    output: ReturnType<typeof claimSessionSuggestionDispatch>;
  };
  "suggestion.release": {
    input: {
      scope: SessionAccessScope;
      params: Parameters<typeof releaseSessionSuggestionDispatch>[1];
    };
    output: ReturnType<typeof releaseSessionSuggestionDispatch>;
  };
  "suggestion.finalize": {
    input: {
      scope: SessionAccessScope;
      params: Parameters<typeof finalizeSessionSuggestionClaim>[1];
    };
    output: ReturnType<typeof finalizeSessionSuggestionClaim>;
  };
  "category.prepare": { input: { scope: SessionAccessScope; from: string }; output: string[] };
  "category.apply": {
    input: { scope: SessionAccessScope; from: string; to?: string };
    output: Array<{ sessionKey: string; sessionId: string }>;
  };
  add: {
    input: { scope: SessionAccessScope; params: Parameters<typeof addSessionMember>[1] };
    output: { value: ReturnType<typeof addSessionMember> } & MembershipPublication;
  };
  remove: {
    input: {
      scope: SessionAccessScope;
      identityId: string;
      expected?: Parameters<typeof removeSessionMember>[2];
      expectedSessionId?: string;
      expectedEntry?: Parameters<typeof removeSessionMember>[4];
    };
    output: { value: ReturnType<typeof removeSessionMember> } & MembershipPublication;
  };
  participant: {
    input: { scope: SessionAccessScope; params: Parameters<typeof recordSessionParticipant>[1] };
    output: { value: ReturnType<typeof recordSessionParticipant> } & ParticipantPublication;
  };
};

/** The canonical agent executor retains the connection and both live admission checks. */
export function bindSqliteWorkerBackend(
  _input: undefined,
  context: {
    databasePath: string;
    database: DatabaseSync;
    admit(stage: "transaction" | "commit"): void;
  },
): SqliteWorkerBackend<SessionSharingWorkerOperations> {
  const db = context.database;
  let categoryPlan:
    | {
        from: string;
        storePath: string;
        rows: ReturnType<typeof prepareSessionGroupCategoryMutation>;
      }
    | undefined;
  const categoryDatabase = (scope: SessionAccessScope) => {
    const database = getOpenClawAgentDatabaseIfOpen(toDatabaseOptions(resolveSqliteScope(scope)));
    if (!database || database.db !== db || database.path !== context.databasePath) {
      throw new Error("Session group category write lost its physical store owner");
    }
    return database;
  };
  return {
    execute(command) {
      const scope = { ...command.input.scope };
      const target = resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolveSqliteScope(scope)));
      if (readDatabasePathIdentitySync(target).canonicalPath !== context.databasePath) {
        throw new Error("Session collaboration target changed its database owner");
      }
      scope.storePath = context.databasePath;
      if (command.type === "category.prepare") {
        const database = categoryDatabase(scope);
        return withSqlitePostCommitPublications(db, () =>
          runSqliteDeferredTransactionSync(db, () => {
            categoryPlan = {
              from: command.input.from,
              storePath: database.path,
              rows: prepareSessionGroupCategoryMutation(database, command.input.from),
            };
            return [...categoryPlan.rows.keys()];
          }),
        );
      }
      let participantResult: SessionSharingWorkerOperations["participant"]["output"] | undefined;
      let membershipResult: MembershipPublication | undefined;
      let ownerResult: SessionSharingWorkerOperations["owner.assign"]["output"] | undefined;
      const unsubscribe =
        command.type !== "category.apply"
          ? sessionChanges.subscribeFacts((change) => {
              if (
                "sessionKey" in change &&
                change.sessionKey === command.input.scope.sessionKey &&
                change.storePath === context.databasePath
              ) {
                if (participantResult && change.facts?.kind === "participants") {
                  participantResult.projectionChanged = true;
                }
                if (membershipResult && change.facts?.kind === "member") {
                  membershipResult.facts = change.facts;
                }
                if (ownerResult && change.facts?.kind === "owner") {
                  ownerResult.facts = change.facts;
                }
              }
            })
          : undefined;
      try {
        return withSqlitePostCommitPublications(db, () =>
          runSqliteImmediateTransactionSync(
            db,
            () => {
              context.admit("transaction");
              if (command.type === "owner.assign") {
                ownerResult = { value: assignSessionOwner(scope, command.input.params) };
                return ownerResult;
              }
              if (command.type === "suggestion.add") {
                return addSessionSuggestion(scope, command.input.params);
              }
              if (command.type === "suggestion.claim") {
                return claimSessionSuggestionDispatch(scope, command.input.params);
              }
              if (command.type === "suggestion.release") {
                return releaseSessionSuggestionDispatch(scope, command.input.params);
              }
              if (command.type === "suggestion.finalize") {
                return finalizeSessionSuggestionClaim(scope, command.input.params);
              }
              if (command.type === "category.apply") {
                const database = categoryDatabase(scope);
                if (
                  !categoryPlan ||
                  categoryPlan.from !== command.input.from ||
                  categoryPlan.storePath !== database.path
                ) {
                  throw new Error("Session group category mutation has no matching prepared rows");
                }
                return applySessionGroupCategoryMutation(
                  database,
                  categoryPlan.rows,
                  command.input.to,
                  scope.env ?? process.env,
                );
              }
              if (command.type === "participant") {
                const value = recordSessionParticipant(scope, command.input.params);
                participantResult = {
                  value,
                  projectionChanged: false,
                  participants: readSqliteSessionParticipantProjection(db, scope.sessionKey),
                };
                return participantResult;
              }
              if (command.type === "add") {
                const value = addSessionMember(scope, command.input.params);
                const result: SessionSharingWorkerOperations["add"]["output"] = { value };
                membershipResult = result;
                return result;
              }
              const value = removeSessionMember(
                scope,
                command.input.identityId,
                command.input.expected,
                command.input.expectedSessionId,
                command.input.expectedEntry,
              );
              const result: SessionSharingWorkerOperations["remove"]["output"] = { value };
              membershipResult = result;
              return result;
            },
            {
              operationLabel: `sessions.${command.type}`,
              busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
              databaseLabel: context.databasePath,
              withCommit(commit) {
                context.admit("commit");
                if (command.type === "category.apply") {
                  assertSessionGroupCategoryDestination(
                    command.input.to,
                    command.input.scope.env ?? process.env,
                  );
                }
                commit();
              },
            },
          ),
        );
      } finally {
        unsubscribe?.();
      }
    },
    assertSettled() {
      assertTransactionUsable(db);
      if (db.isTransaction) {
        throw new Error("Session collaboration transaction did not settle");
      }
    },
    close() {},
  };
}
