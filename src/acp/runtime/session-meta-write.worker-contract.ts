import type {
  AcpSessionMutationCommit,
  AcpSessionMutationPreparation,
  AcpSessionMutationPrepareInput,
} from "./session-meta-write.types.js";

export type AcpSessionWriteOperations = {
  "acp.prepareMutation": {
    input: AcpSessionMutationPrepareInput;
    output: AcpSessionMutationPreparation;
  };
  "acp.commitMutation": {
    input: AcpSessionMutationCommit & { nonce: string };
    output: { nonce: string };
  };
};
