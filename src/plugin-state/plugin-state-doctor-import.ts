import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { createVerifiedSqliteSnapshot } from "../infra/sqlite-snapshot.js";
import {
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
} from "../infra/state-migrations.receipts.js";
import type { PluginDoctorRepairAuthority } from "../infra/state-migrations.types.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { sanitizeOpenClawStateLeaseRows } from "../state/openclaw-state-snapshot-sanitizer.js";
import { withPluginStateDatabaseReadOnly } from "./plugin-state-store.database.js";
import {
  bindPluginStateEntry,
  getPluginStateKysely,
  insertPluginStateEntryIfAbsent,
  type PluginStateReadRow,
} from "./plugin-state-store.kernel.js";
import { assertCanInsertPluginStateEntry } from "./plugin-state-store.retention.js";
import type { PluginDoctorRawStateEntry } from "./plugin-state-store.sqlite.js";
import {
  prepareRegisterParams,
  validateKey,
  validateMaxEntries,
  validateNamespace,
} from "./plugin-state-store.validation.js";

export type PluginDoctorStateSourceKey = { namespace: string; key: string };
export type PluginDoctorStateSourceRow = PluginDoctorRawStateEntry & { namespace: string };
export type PluginDoctorStateRowImport = {
  source: PluginDoctorStateSourceRow;
  /** Additional observed rows that must remain unchanged through the import. */
  checks: readonly PluginDoctorStateSourceRow[];
  /** Null records a permanent receipt without creating or changing canonical state. */
  target: {
    namespace: string;
    maxEntries: number;
    key: string;
    value: unknown;
    createdAt: number;
    expiresAt: number | null;
  } | null;
};

type DoctorImportScope = {
  pluginId: string;
  migrationId: string;
  env: NodeJS.ProcessEnv;
};

function sourceKey(
  scope: DoctorImportScope,
  source: PluginDoctorStateSourceKey,
  row: PluginStateReadRow,
): string {
  return `plugin-state-row:${createHash("sha256")
    .update(
      JSON.stringify([
        scope.pluginId,
        scope.migrationId,
        source.namespace,
        source.key,
        sourceDigest(row),
      ]),
    )
    .digest("hex")}`;
}

function readRow(db: DatabaseSync, pluginId: string, source: PluginDoctorStateSourceKey) {
  return executeSqliteQueryTakeFirstSync(
    db,
    getPluginStateKysely(db)
      .selectFrom("plugin_state_entries")
      .select(["entry_key", "value_json", "created_at", "expires_at"])
      .where("plugin_id", "=", pluginId)
      .where("namespace", "=", source.namespace)
      .where("entry_key", "=", source.key),
  );
}

function rowMatches(row: PluginStateReadRow | undefined, expected: PluginDoctorStateSourceRow) {
  return (
    row?.value_json === expected.valueJson &&
    row.created_at === expected.createdAt &&
    row.expires_at === expected.expiresAt
  );
}

function sourceDigest(row: PluginStateReadRow): string {
  return createHash("sha256")
    .update(JSON.stringify([row.value_json, row.created_at, row.expires_at]))
    .digest("hex");
}

function validateSource(source: PluginDoctorStateSourceRow): void {
  validateNamespace(source.namespace);
  validateKey(source.key);
  if (
    typeof source.valueJson !== "string" ||
    !Number.isSafeInteger(source.createdAt) ||
    source.createdAt < 0 ||
    (source.expiresAt !== null && !Number.isSafeInteger(source.expiresAt))
  ) {
    throw new Error("Plugin Doctor import requires exact observed source rows.");
  }
}

/** Receipts outlive canonical row consumption and namespace retention. */
export function inspectImportedPluginStateSources(
  scope: DoctorImportScope,
  sources: readonly PluginDoctorStateSourceKey[],
): PluginDoctorStateSourceKey[] {
  if (scope.pluginId.startsWith("core:")) {
    throw new Error("Plugin Doctor imports cannot access reserved core state.");
  }
  return (
    withPluginStateDatabaseReadOnly(
      "entries",
      ({ db }) =>
        sources
          .filter((source) => {
            validateNamespace(source.namespace);
            validateKey(source.key);
            const row = readRow(db, scope.pluginId, source);
            return (
              row !== undefined &&
              readLegacyMigrationReceiptFromDatabase(db, sourceKey(scope, source, row)) !== null
            );
          })
          .map(({ namespace, key }) => ({ namespace, key })),
      { env: scope.env },
    ) ?? []
  );
}

/** Offline import of plugin-owned rows; the host owns paths, backup, authority, and receipts. */
export async function importPluginStateRowsForDoctor(
  scope: DoctorImportScope,
  authority: PluginDoctorRepairAuthority,
  requested: readonly PluginDoctorStateRowImport[],
): Promise<{ imported: number; skipped: number; backupPath?: string }> {
  authority.assertCurrent();
  if (scope.pluginId.startsWith("core:")) {
    throw new Error("Plugin Doctor imports cannot access reserved core state.");
  }
  const seenSources = new Set<string>();
  const seenTargets = new Map<string, string>();
  const plans = structuredClone(requested).map((plan) => {
    for (const source of [plan.source, ...plan.checks]) {
      validateSource(source);
    }
    const sourceIdentity = JSON.stringify([plan.source.namespace, plan.source.key]);
    if (seenSources.has(sourceIdentity)) {
      throw new Error("Plugin Doctor import requires distinct sources.");
    }
    seenSources.add(sourceIdentity);
    if (plan.target === null) {
      return { source: plan.source, checks: plan.checks, sourceIdentity, target: null };
    }
    const namespace = validateNamespace(plan.target.namespace);
    const prepared = prepareRegisterParams(plan.target.key, plan.target.value);
    const maxEntries = validateMaxEntries(plan.target.maxEntries);
    if (
      !Number.isSafeInteger(plan.target.createdAt) ||
      plan.target.createdAt < 0 ||
      (plan.target.expiresAt !== null && !Number.isSafeInteger(plan.target.expiresAt))
    ) {
      throw new Error("Plugin Doctor import requires valid target timestamps.");
    }
    const targetKey = JSON.stringify([namespace, prepared.key]);
    const targetDigest = JSON.stringify([
      prepared.valueJson,
      plan.target.createdAt,
      plan.target.expiresAt,
      maxEntries,
    ]);
    const previousTarget = seenTargets.get(targetKey);
    if (previousTarget !== undefined && previousTarget !== targetDigest) {
      throw new Error("Plugin Doctor import requires identical shared targets.");
    }
    seenTargets.set(targetKey, targetDigest);
    return {
      source: plan.source,
      checks: plan.checks,
      sourceIdentity,
      target: {
        namespace,
        ...prepared,
        maxEntries,
        createdAt: plan.target.createdAt,
        expiresAt: plan.target.expiresAt,
      },
    };
  });
  const importedSources = new Set(
    inspectImportedPluginStateSources(
      scope,
      plans.map((plan) => plan.source),
    ).map((source) => JSON.stringify([source.namespace, source.key])),
  );
  const pending = plans.filter((plan) => !importedSources.has(plan.sourceIdentity));
  if (pending.length === 0) {
    return { imported: 0, skipped: plans.length };
  }
  const assertSourcesUnchanged = (db: DatabaseSync) => {
    for (const plan of pending) {
      for (const source of [plan.source, ...plan.checks]) {
        if (!rowMatches(readRow(db, scope.pluginId, source), source)) {
          throw new Error(
            "Plugin state changed during Doctor import; inspect again before retrying.",
          );
        }
      }
    }
  };
  const sourcePath = resolveOpenClawStateSqlitePath(scope.env);
  const backupPath = `${sourcePath}.doctor-plugin-${Date.now()}-${randomUUID()}.bak`;
  await createVerifiedSqliteSnapshot({
    sourcePath,
    targetPath: backupPath,
    preserveRowIds: true,
    transform: sanitizeOpenClawStateLeaseRows,
    requireNonEmptySource: true,
    validate: assertSourcesUnchanged,
    beforePublish: () => authority.assertCurrent(),
    afterPublish: (guard) => guard.assertTargetUnchanged(() => authority.assertCurrent()),
  });
  try {
    authority.assertCurrent();
    const imported = runOpenClawStateWriteTransaction(
      ({ db }) => {
        authority.assertOwnedInTransaction(db);
        assertSourcesUnchanged(db);
        let written = 0;
        for (const plan of pending) {
          const source = readRow(db, scope.pluginId, plan.source);
          if (!source) {
            throw new Error("Plugin Doctor import source disappeared.");
          }
          const receiptKey = sourceKey(scope, plan.source, source);
          const receipt = readLegacyMigrationReceiptFromDatabase(db, receiptKey);
          if (receipt) {
            continue;
          }
          const now = Date.now();
          const target = plan.target;
          if (target) {
            const existing = readRow(db, scope.pluginId, target);
            if (existing && !rowMatches(existing, target)) {
              throw new Error(
                "Plugin Doctor import target differs; existing rows and sources were preserved.",
              );
            }
            if (!existing && (target.expiresAt === null || target.expiresAt > now)) {
              assertCanInsertPluginStateEntry({
                store: { db, path: sourcePath },
                pluginId: scope.pluginId,
                namespace: target.namespace,
                maxEntries: target.maxEntries,
                overflowPolicy: "reject-new",
                now,
              });
              authority.assertOwnedInTransaction(db);
              if (
                insertPluginStateEntryIfAbsent(
                  db,
                  bindPluginStateEntry({ pluginId: scope.pluginId, ...target }),
                )
              ) {
                written++;
              }
            }
          }
          recordLegacyMigrationReceipt(db, {
            sourceKey: receiptKey,
            migrationKind: `plugin-state:${scope.pluginId}:${scope.migrationId}`,
            sourcePath: `${sourcePath}#${JSON.stringify([plan.source.namespace, plan.source.key])}`,
            targetTable: target ? "plugin_state_entries" : "migration_sources",
            sourceSha256: sourceDigest(source),
            sourceSizeBytes: Buffer.byteLength(source.value_json),
            sourceRecordCount: 1,
            runId: randomUUID(),
            now,
            reportJson: JSON.stringify(
              target
                ? { namespace: target.namespace, key: target.key }
                : { disposition: "receipt-only" },
            ),
          });
        }
        authority.assertOwnedInTransaction(db);
        return written;
      },
      { env: scope.env },
      { operationLabel: "plugin-state.doctor-import" },
    );
    return { imported, skipped: plans.length - imported, backupPath };
  } catch (error) {
    throw new Error(
      `Plugin Doctor import failed; verified backup retained at ${backupPath}: ${String(error)}`,
      { cause: error },
    );
  }
}
