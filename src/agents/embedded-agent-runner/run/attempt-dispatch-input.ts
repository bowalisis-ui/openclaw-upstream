import type { ContextEngine } from "../../../context-engine/types.js";
import type { ToolOutcomeObserver } from "../../agent-tools.before-tool-call.js";
import type { EmbeddedRunReplayState } from "../replay-state.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import type { prepareEmbeddedRunRuntime } from "./runtime-preparation.js";
import type { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";
import type { createEmbeddedRunTerminalRetryState } from "./terminal-retry-state.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/** Prepared runtime and lifecycle owners required to dispatch one embedded attempt. */
export type EmbeddedRunAttemptDispatchInput = {
  runInput: PreparedEmbeddedRunInput;
  preparedRuntime: Awaited<ReturnType<typeof prepareEmbeddedRunRuntime>>;
  contextEngine: ContextEngine;
  sessionPromptState: Awaited<ReturnType<typeof createEmbeddedRunSessionPromptState>>;
  terminalRetryState: ReturnType<typeof createEmbeddedRunTerminalRetryState>;
  replayState: EmbeddedRunReplayState;
  provider: string;
  modelId: string;
  startupStagesEmitted: boolean;
  bootstrapPromptWarningSignaturesSeen: string[];
  resolveRuntimeFallbackReason: () => string | null;
  observeToolOutcome: ToolOutcomeObserver;
  isTurnTainted: () => boolean;
  allocateToolOutcomeOrdinal: NonNullable<EmbeddedRunAttemptParams["allocateToolOutcomeOrdinal"]>;
  getPostCompactionAbortError: () => Error | undefined;
  setPostCompactionAbortController: (controller: AbortController | undefined) => void;
  clearPostCompactionAbortController: (controller: AbortController) => void;
  permissionChange?: EmbeddedRunAttemptParams["permissionChange"];
};
