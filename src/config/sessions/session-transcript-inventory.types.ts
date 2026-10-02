import type {
  SessionTranscriptCorpusArtifact,
  SessionTranscriptCorpusOptions,
  SessionTranscriptCorpusScope,
  SessionTranscriptCorpusEntry,
} from "../../../packages/memory-host-sdk/src/host/session-transcript-corpus.types.js";
import type { TranscriptArchivePresenceRead } from "./session-accessor.sqlite-archive-types.js";
import type { SessionAccessScope } from "./session-accessor.types.js";
import type { CanonicalSessionReaderContinuation } from "./session-canonical-key.js";

export type SessionArchiveInventoryScope = Pick<
  SessionAccessScope,
  "agentId" | "env" | "storePath"
> & {
  archiveNames?: readonly string[];
  sessionIds?: readonly string[];
  includeAllAgents?: boolean;
};

export type SessionArchiveInventoryEntry = {
  archiveName: string;
  sessionId: string;
  sessionKey: string;
  createdAt: number;
  agentId: string;
};

type SessionArchiveInventoryWorkerInput = SessionArchiveInventoryScope & {
  kind: "session-archive-inventory";
  database: { agentId: string; path: string };
};

type SessionCorpusInventoryWorkerInput = {
  kind: "session-corpus-inventory";
  database: { agentId: string; path: string };
  scope: SessionTranscriptCorpusScope;
  options: SessionTranscriptCorpusOptions;
  artifacts: readonly SessionTranscriptCorpusArtifact[];
  continuation?: CanonicalSessionReaderContinuation;
};

type SessionArchivePresenceWorkerInput = TranscriptArchivePresenceRead & {
  kind: "session-archive-presence";
};

export type SessionTranscriptInventoryWorkerInput =
  | SessionArchiveInventoryWorkerInput
  | SessionCorpusInventoryWorkerInput
  | SessionArchivePresenceWorkerInput;
export type SessionTranscriptInventoryWorkerValues = {
  "session-archive-inventory": {
    kind: "session-archive-inventory";
    archives: SessionArchiveInventoryEntry[];
  };
  "session-corpus-inventory": {
    kind: "session-corpus-inventory";
    entries: SessionTranscriptCorpusEntry[];
  };
  "session-archive-presence": { kind: "session-archive-presence"; registered: boolean };
};
export type SessionTranscriptInventoryReaders = {
  readArchiveInventory: (
    input: Omit<SessionArchiveInventoryWorkerInput, "kind" | "database">,
  ) => Promise<SessionArchiveInventoryEntry[]>;
  readCorpusInventory: (
    input: Omit<SessionCorpusInventoryWorkerInput, "kind" | "database">,
  ) => Promise<SessionTranscriptCorpusEntry[]>;
  readArchivePresence: (
    input: Omit<SessionArchivePresenceWorkerInput, "kind" | "database">,
  ) => Promise<boolean>;
};
