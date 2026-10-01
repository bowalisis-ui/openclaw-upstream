import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import type { WorkerOperationHandlersFor } from "../state/worker-operation-registry.js";
import { readRemoteModelCatalog } from "./remote-store.js";
import type { ModelCatalogWorkerOperations } from "./remote-store.types.js";

export const modelCatalogOperations = {
  "modelCatalog.remote.read": (input, { stateOptions }) => {
    const read = () => readRemoteModelCatalog(stateOptions());
    return input.artifactPreservingReadOnly ? withArtifactPreservingStateReads(read) : read();
  },
} satisfies WorkerOperationHandlersFor<ModelCatalogWorkerOperations>;
