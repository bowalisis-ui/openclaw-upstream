export type RemoteModelCatalogStoreRow = {
  id: number;
  bundle_json: string;
  generated_at: number;
  min_version: string | null;
  source_url: string;
  etag: string | null;
  last_modified: string | null;
  checked_at: number;
};

export type ModelCatalogWorkerOperations = {
  "modelCatalog.remote.read": {
    input: { artifactPreservingReadOnly: boolean };
    output: RemoteModelCatalogStoreRow | undefined;
  };
};
