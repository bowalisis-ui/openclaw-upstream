import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { SessionEntry } from "./types.js";

/** True when this entry's transcript began as a copy of a parent (actual forkSource ancestry or the legacy/thread-settled marker). */
export function sessionEntryForkedFromParent(
  entry: Pick<SessionEntry, "forkedFromParent" | "forkSource"> | undefined,
): boolean {
  return entry?.forkSource !== undefined || entry?.forkedFromParent === true;
}

type SessionParentLink = Pick<
  SessionEntry,
  | "parentSessionKey"
  | "parentSessionId"
  | "parentSessionLifecycleRevision"
  | "spawnedBySenderIsOwner"
>;

/** Builds the stored parent link and spawn-time parent authority receipt for a new session. */
export function buildSessionParentLink(params: {
  parentSessionKey?: string;
  parent?: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
  captureSpawnAuthority: boolean;
  requesterSenderIsOwner?: boolean;
}): Partial<SessionParentLink> {
  return {
    ...(params.parentSessionKey ? { parentSessionKey: params.parentSessionKey } : {}),
    ...(params.parent?.sessionId
      ? {
          parentSessionId: params.parent.sessionId,
          ...(params.captureSpawnAuthority
            ? {
                parentSessionLifecycleRevision: params.parent.lifecycleRevision,
                spawnedBySenderIsOwner: params.requesterSenderIsOwner === true,
              }
            : {}),
        }
      : {}),
  };
}

/** Selects parent and spawn lineage that survives an in-place session reset. */
export function preserveSessionLineage(
  entry: SessionEntry | undefined,
): Partial<
  Pick<
    SessionEntry,
    | "spawnedBy"
    | "spawnedBySenderIsOwner"
    | "parentSessionKey"
    | "parentSessionId"
    | "parentSessionLifecycleRevision"
    | "forkSource"
    | "forkedFromParent"
    | "spawnDepth"
    | "subagentRole"
    | "subagentControlScope"
  >
> {
  return {
    spawnedBy: entry?.spawnedBy,
    spawnedBySenderIsOwner: entry?.spawnedBySenderIsOwner,
    parentSessionKey: entry?.parentSessionKey,
    parentSessionId: entry?.parentSessionId,
    parentSessionLifecycleRevision: entry?.parentSessionLifecycleRevision,
    forkSource: entry?.forkSource,
    forkedFromParent: sessionEntryForkedFromParent(entry) ? true : undefined,
    spawnDepth: entry?.spawnDepth,
    subagentRole: entry?.subagentRole,
    subagentControlScope: entry?.subagentControlScope,
  };
}

export function preserveSqliteSameKeySessionRolloverLineage(params: {
  next: SessionEntry;
  previous: SessionEntry;
  sessionKey: string;
}): SessionEntry {
  const previousSessionId = params.previous.sessionId.trim();
  const nextSessionId = params.next.sessionId.trim();
  if (!previousSessionId || !nextSessionId || previousSessionId === nextSessionId) {
    return params.next;
  }
  return {
    ...params.next,
    previousSessionId,
    usageFamilyKey:
      params.next.usageFamilyKey ?? params.previous.usageFamilyKey ?? params.sessionKey,
    usageFamilySessionIds: uniqueStrings([
      ...(params.previous.usageFamilySessionIds ?? []),
      previousSessionId,
      ...(params.next.usageFamilySessionIds ?? []),
      nextSessionId,
    ]),
  };
}
