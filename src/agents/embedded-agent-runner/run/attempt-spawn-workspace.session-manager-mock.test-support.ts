import type { Mock } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";

type UnknownMock = Mock<(...args: unknown[]) => unknown>;

export type SessionManagerMocks = {
  getSessionTarget: Mock<() => undefined>;
  getSessionId: Mock<() => string>;
  getAppendParentId: Mock<() => string | null>;
  getHeader: UnknownMock;
  getLeafId: Mock<() => string | null>;
  getLeafEntry: UnknownMock;
  getEntry: UnknownMock;
  getEntries: UnknownMock;
  getBranch: UnknownMock;
  getBoundaryCount: UnknownMock;
  branchAsync: UnknownMock;
  resetLeafAsync: UnknownMock;
  buildSessionContext: Mock<() => { messages: AgentMessage[] }>;
  appendThinkingLevelChange: UnknownMock;
  appendModelChange: UnknownMock;
  appendCustomEntryAsync: UnknownMock;
  appendMessageAsync: UnknownMock;
  appendSessionInfoAsync: UnknownMock;
  appendLabelChangeAsync: UnknownMock;
  flushPendingPersistence: UnknownMock;
  flushPendingToolResultsAsync: UnknownMock;
  clearPendingToolResults: UnknownMock;
  reloadPersistedTranscriptAsync: UnknownMock;
  clearNextUserMessagePersistenceSuppression: UnknownMock;
  removeTrailingEntriesAsync: UnknownMock;
};
