import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { readOpenClawDatabaseQuarantineFailure } from "../../state/openclaw-quarantine-store.js";
import { readSessionTranscriptCurrentTurnEntry } from "./session-accessor.sqlite-current-turn.js";
import { readSessionTranscriptMaintenance } from "./session-transcript-maintenance-read.js";
import type { SessionHistoryWorkerInput } from "./session-transcript-worker.types.js";

export function readSessionTranscriptNavigationInWorker(
  request: Extract<
    SessionHistoryWorkerInput,
    { kind: "transcript-maintenance" | "current-turn-entry" }
  >,
) {
  if (request.kind === "transcript-maintenance") {
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) => readSessionTranscriptMaintenance(database, request.target, request.request),
      { ...request.database, env: request.target.env },
    );
    if (!result.found) {
      throw new Error("Session transcript is unavailable for maintenance planning");
    }
    return result.value;
  }
  const quarantine = readOpenClawDatabaseQuarantineFailure("agent", request.database.path, {
    env: request.target.env,
  });
  if (quarantine) {
    throw quarantine;
  }
  return readSessionTranscriptCurrentTurnEntry(request.target, {
    entryId: request.entryId,
    version: request.version,
    includeEntry: request.includeEntry,
    readOnly: true,
    resolvedScope: request.resolvedScope,
  });
}
