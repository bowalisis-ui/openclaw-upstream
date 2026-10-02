import type { SessionEntryCurrentSource } from "../../config/sessions/session-entry-current.types.js";
import type { WorkerSessionTurnClaim, WorkerTurnClaimInput } from "./placement-record.js";
import type { PlacementTurnClaimReceipt } from "./placement-turn-claims.types.js";

type ClaimInput = { claim: WorkerSessionTurnClaim; nowMs?: number };
type PlacementTurnClaimInputs = {
  "placementTurns.claim": { claim: WorkerTurnClaimInput; nowMs?: number };
  "placementTurns.updateWorkspaceBaseManifest": ClaimInput & {
    manifestRef: string;
    sessionEntryCurrentSource?: SessionEntryCurrentSource;
  };
  "placementTurns.recordStagedResult": ClaimInput & {
    stagedResultRef: string;
    repositoryWorkspaceId?: string;
    sessionEntryCurrentSource?: SessionEntryCurrentSource;
  };
  "placementTurns.recoverWorkspace": ClaimInput & { gatewayInstanceId: string };
  "placementTurns.handoffRuntimeRefreshResult": ClaimInput & {
    expectedGeneration: number;
    gatewayInstanceId: string;
    nowMs: number;
  };
  "placementTurns.releaseIfOwned": ClaimInput;
  "placementTurns.release": ClaimInput;
};

export type PlacementTurnClaimWorkerOperations = {
  [Key in keyof PlacementTurnClaimInputs]: {
    input: PlacementTurnClaimInputs[Key];
    output: PlacementTurnClaimReceipt;
  };
};
