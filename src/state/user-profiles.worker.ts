import { createHash } from "node:crypto";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";
import { executeUserChannelIdentityChange } from "./user-channel-identities.worker.js";
import {
  selectProfileAccessEntries,
  selectStoredGitHubIdentities,
} from "./user-profile-github-identity.js";
import { listUserProfilesSync, readUserProfileSnapshotSync } from "./user-profile-identity.read.js";
import {
  executeUserProfileWrite,
  linkEmail,
  mergeProfiles,
  setAvatar,
  setDisplayName,
  setUserProfileRole,
  syncGitHubIdentity,
} from "./user-profile-writes.worker.js";
import {
  inspectProfileAvatarInDatabase,
  selectResolvedUserProfileById,
  toUserProfile,
  userProfilesDb,
} from "./user-profiles-internal.js";
import { ensureUserProfilesSchema } from "./user-profiles-schema.js";
import {
  ensureGatewayOwnerProfile,
  ensureProfileForEmail,
  ensureProfileForTailscaleIdentity,
} from "./user-profiles.js";
import type { UserProfileWorkerOperations } from "./user-profiles.worker-contract.js";
import type { WorkerOperationHandlersFor } from "./worker-operation-registry.js";

export const userProfileOperations = {
  "userProfiles.setRole": (input, { open, stateOptions }) =>
    executeUserProfileWrite(
      "userProfiles.setRole",
      { ...stateOptions(), database: open() },
      (owned) => setUserProfileRole(input.profileId, input.role, owned),
    ),
  "userProfiles.linkEmail": (input, { open, stateOptions }) =>
    executeUserProfileWrite(
      "userProfiles.linkEmail",
      { ...stateOptions(), database: open() },
      (owned, display) => ({
        profile: linkEmail(input.email, input.targetProfileId, owned),
        display: display(),
      }),
      input.targetProfileId,
    ),
  "userProfiles.merge": (input, { open, stateOptions }) =>
    executeUserProfileWrite(
      "userProfiles.merge",
      { ...stateOptions(), database: open() },
      (owned, display) => ({
        ...mergeProfiles(input.sourceProfileId, input.targetProfileId, owned),
        display: display(),
      }),
      input.targetProfileId,
    ),
  "userProfiles.ensureEmail": (input, { open, stateOptions }) =>
    executeUserProfileWrite(
      "userProfiles.ensureEmail",
      { ...stateOptions(), database: open() },
      (owned) =>
        ensureProfileForEmail(input.email, {
          ...owned,
          expectedGitHubAccountId: input.expectedGitHubAccountId,
        }),
    ),
  "userProfiles.ensureTailscale": (input, { open, stateOptions }) =>
    executeUserProfileWrite(
      "userProfiles.ensureTailscale",
      { ...stateOptions(), database: open() },
      (owned) => ensureProfileForTailscaleIdentity(input, owned),
    ),
  "userProfiles.syncGitHub": (input, { open, stateOptions }) =>
    executeUserProfileWrite(
      "userProfiles.syncGitHub",
      { ...stateOptions(), database: open() },
      (owned) => syncGitHubIdentity(input, owned),
    ),
  "userProfiles.ensureOwner": (input, { open, stateOptions }) =>
    executeUserProfileWrite(
      "userProfiles.ensureOwner",
      { ...stateOptions(), database: open() },
      (owned) => ensureGatewayOwnerProfile(input.displayName, owned),
    ),
  "userProfiles.setDisplayName": (input, { open, stateOptions }) =>
    executeUserProfileWrite(
      "userProfiles.setDisplayName",
      { ...stateOptions(), database: open() },
      (owned, display) => ({
        profile: setDisplayName(input.profileId, input.name, owned),
        display: display(),
      }),
      input.profileId,
    ),
  "userProfiles.setAvatar": (input, { open, stateOptions }) =>
    executeUserProfileWrite(
      "userProfiles.setAvatar",
      { ...stateOptions(), database: open() },
      (owned, display) => {
        const result = setAvatar(input.profileId, input.bytes, input.mime, owned);
        return result.ok
          ? { ok: true as const, value: { profile: result.value, display: display() } }
          : result;
      },
      input.profileId,
    ),
  "userProfiles.list": (input, { open, stateOptions }) => {
    const options = { ...stateOptions(), database: open() };
    return input?.githubAccountIds === undefined
      ? { profiles: listUserProfilesSync(options) }
      : readUserProfileSnapshotSync(options, input.githubAccountIds);
  },
  "userProfiles.directory": ({ limit }, { open, stateOptions }) => {
    const database = open();
    ensureUserProfilesSchema(stateOptions(), database);
    return runSqliteDeferredTransactionSync(
      database.db,
      () => {
        const profiles = executeSqliteQuerySync(
          database.db,
          userProfilesDb(database.db)
            .selectFrom("user_profiles")
            .select("id")
            .where("merged_into", "is", null)
            .orderBy("created_at", "asc")
            .orderBy("id", "asc")
            .limit(limit + 1),
        ).rows;
        const selected = profiles.slice(0, limit);
        const identities = selectStoredGitHubIdentities(
          database.db,
          selected.map(({ id }) => id),
        );
        return {
          profiles: selected.map(({ id }) => ({
            id,
            logins: identities.get(id)?.accounts.map((account) => account.login) ?? [],
          })),
          truncated: profiles.length > limit,
        };
      },
      { databaseLabel: database.path, operationLabel: "user-profiles.directory" },
    );
  },
  "userProfiles.channelIdentity.change": (input, { open, stateOptions }) =>
    executeUserChannelIdentityChange(input, { ...stateOptions(), database: open() }),
  "userProfiles.avatar.inspect": ({ profileId }, { open }) =>
    inspectProfileAvatarInDatabase(open().db, profileId),
  "userProfiles.avatar.adopt": (input, { open, stateOptions }) => {
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const profile = selectResolvedUserProfileById(db, input.profileId);
        if (!profile) {
          return { profile: undefined };
        }
        if (profile.avatar !== null) {
          return { profile: toUserProfile(profile) };
        }
        const before = selectProfileAccessEntries(db, [profile.id])[0]![1];
        requestSqliteWorkerOperationAdmission({
          stage: "transaction",
          facts: { kind: "profile-avatar", before },
        });
        executeSqliteQuerySync(
          db,
          userProfilesDb(db)
            .updateTable("user_profiles")
            .set({
              avatar: input.bytes,
              avatar_mime: input.mime,
              avatar_sha256: sha256,
              updated_at: input.now,
            })
            .where("id", "=", profile.id),
        );
        const committed = selectProfileAccessEntries(db, [profile.id])[0]![1];
        return {
          profile: toUserProfile({ ...profile, avatar_mime: input.mime, updated_at: input.now }),
          committed,
        };
      },
      { ...stateOptions(), database: open() },
      { operationLabel: "user-profiles.adopt-avatar" },
    );
  },
} satisfies WorkerOperationHandlersFor<UserProfileWorkerOperations>;
