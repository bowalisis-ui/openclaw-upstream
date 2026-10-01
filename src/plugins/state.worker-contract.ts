import type { ZodError } from "zod";
import type {
  DeferredPluginMigration,
  DeferredPluginMigrationCompletion,
  DeferredPluginMigrationRecordInput,
  DeferredPluginMigrationTransitions,
} from "../infra/deferred-plugin-migrations.contract.js";
import type { OpenClawStateLeaseIdentity } from "../state/openclaw-state-lease.types.js";
import type { PluginBindingApprovalEntry } from "./conversation-binding-state.types.js";
import type { HostedOfficialExternalPluginCatalogSnapshot } from "./official-external-plugin-catalog.types.js";
import type { PluginSourceAdmissionPublication } from "./plugin-source-admission.types.js";

export type PluginRuntimeWorkerOperations = {
  "plugins.conversationBindingApprovals.read": {
    input: undefined;
    output: PluginBindingApprovalEntry[];
  };
  "plugins.conversationBindingApprovals.upsert": {
    input: PluginBindingApprovalEntry;
    output: void;
  };
  "plugins.catalogSnapshot.read": {
    input: { url: string };
    output: HostedOfficialExternalPluginCatalogSnapshot | null;
  };
  "plugins.catalogSnapshot.write": {
    input: { snapshot: HostedOfficialExternalPluginCatalogSnapshot; now: number };
    output: { ok: true } | { ok: false; message: string };
  };
  "plugins.metadata.sourceAdmission.publish": {
    input: PluginSourceAdmissionPublication;
    output: boolean;
  };
  "plugins.deferredMigrations.record": {
    input: Omit<DeferredPluginMigrationRecordInput, "env"> & {
      identity: OpenClawStateLeaseIdentity;
    };
    output:
      | { kind: "recorded"; transitions: DeferredPluginMigrationTransitions }
      | { kind: "conflict"; pending: readonly DeferredPluginMigration[] }
      | { kind: "invalid"; issues: ZodError["issues"] };
  };
  "plugins.deferredMigrations.read": {
    input: { artifactPreservingReadOnly: boolean };
    output: readonly DeferredPluginMigration[];
  };
  "plugins.deferredMigrations.completions.read": {
    input: undefined;
    output: DeferredPluginMigrationCompletion[];
  };
};
