import type { Result } from "@openclaw/normalization-core/result";
import type {
  UserProfile as UserProfileListItem,
  UsersMergeResult,
} from "../../packages/gateway-protocol/src/schema/users.js";
import type { UserProfileAvatarInspection } from "./user-profiles-avatar.types.js";
import type { TailscaleProfileIdentity } from "./user-profiles-tailscale-login.js";
import type {
  ProfileDisplayRow,
  UserProfile,
  UserProfileAvatarMime,
  UserProfileDisplay,
  UserProfileGitHubSyncInput,
  UserProfileOwnerErrorCode,
  UserChannelIdentityWorkerOperations,
} from "./user-profiles.types.js";

export type UserProfileWriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: "not-found"; profileId: string }
  | { ok: false; kind: "merge"; message: string }
  | { ok: false; kind: "owner"; code: UserProfileOwnerErrorCode };

export type UserProfileAvatarError =
  | { code: "avatar_too_large"; maxBytes: number }
  | { code: "unsupported_avatar_mime"; mime: string };

export type UserProfileWriteOperations = {
  "userProfiles.setDisplayName": {
    input: { profileId: string; name: string | null };
    output: UserProfileWriteResult<{ profile: UserProfileListItem; display: UserProfileDisplay }>;
  };
  "userProfiles.setAvatar": {
    input: { profileId: string; bytes: Uint8Array; mime: string };
    output: UserProfileWriteResult<
      Result<{ profile: UserProfileListItem; display: UserProfileDisplay }, UserProfileAvatarError>
    >;
  };
  "userProfiles.setRole": {
    input: { profileId: string; role: string | null };
    output: UserProfileWriteResult<UserProfileListItem>;
  };
  "userProfiles.linkEmail": {
    input: { email: string; targetProfileId: string };
    output: UserProfileWriteResult<{ profile: UserProfileListItem; display: UserProfileDisplay }>;
  };
  "userProfiles.merge": {
    input: { sourceProfileId: string; targetProfileId: string };
    output: UserProfileWriteResult<UsersMergeResult & { display: UserProfileDisplay }>;
  };
  "userProfiles.ensureEmail": {
    input: { email: string; expectedGitHubAccountId?: number };
    output: UserProfileWriteResult<UserProfile>;
  };
  "userProfiles.ensureTailscale": {
    input: TailscaleProfileIdentity;
    output: UserProfileWriteResult<UserProfile>;
  };
  "userProfiles.syncGitHub": {
    input: UserProfileGitHubSyncInput;
    output: UserProfileWriteResult<UserProfileListItem>;
  };
  "userProfiles.ensureOwner": {
    input: { displayName: string | null };
    output: UserProfileWriteResult<UserProfile>;
  };
};

export type UserProfileWorkerOperations = UserProfileWriteOperations &
  UserChannelIdentityWorkerOperations & {
    "userProfiles.list": {
    input: { githubAccountIds: readonly number[] } | undefined;
    output: {
      profiles: UserProfileListItem[];
      githubProfiles?: Array<{ accountId: number; profileId: string }>;
    };
  };
    "userProfiles.directory": {
      input: { limit: number };
      output: { profiles: Array<{ id: string; logins: string[] }>; truncated: boolean };
    };
    "userProfiles.avatar.inspect": {
      input: { profileId: string };
      output: UserProfileAvatarInspection;
    };
    "userProfiles.avatar.adopt": {
      input: { profileId: string; bytes: Uint8Array; mime: UserProfileAvatarMime; now: number };
      output: { profile: UserProfile | undefined; committed?: ProfileDisplayRow };
    };
  };
