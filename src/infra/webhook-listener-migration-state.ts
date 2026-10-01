import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { resolveConfigPath } from "../config/paths.js";
import { updateConfigMachineStateInDatabase } from "../state/config-machine-state-write.js";
import { readConfigMachineStateRowInDatabase } from "../state/config-machine-state.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./boundary-path.js";
import { isTruthyEnvValue } from "./env.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";

export type WebhookListenerPin = { path: string[]; value: unknown };
type WebhookListenerMigrationPhase = "all" | "ambient-teams";
export type WebhookListenerMigrationReceipt = {
  existingInstall: boolean;
  phase: WebhookListenerMigrationPhase;
  updateRun?: { id: string; rollbackPhase: WebhookListenerMigrationPhase };
} & (
  | { state: "completed" }
  | {
      state: "prepared";
      sourceHash?: string;
      pins?: WebhookListenerPin[];
      nextPhase?: "ambient-teams";
    }
);

export function webhookListenerMigrationKey(configPath: string): string {
  return `doctor.webhook-listeners.v1:${createHash("sha256")
    .update(resolveIdentityPathViaExistingAncestorSync(configPath))
    .digest("hex")}`;
}

function hasPriorOperation(db: DatabaseSync, env: NodeJS.ProcessEnv): boolean {
  if (
    isTruthyEnvValue(env.OPENCLAW_UPDATE_IN_PROGRESS) ||
    isTruthyEnvValue(env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE) ||
    isTruthyEnvValue(env.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE)
  ) {
    return true;
  }
  const query = getNodeSqliteKysely<DB>(db);
  const processStartedAt = Date.now() - process.uptime() * 1_000;
  if (
    tableExists(db, "gateway_boot_lifecycle") &&
    executeSqliteQueryTakeFirstSync(
      db,
      query
        .selectFrom("gateway_boot_lifecycle")
        .select("boot_id")
        .where((eb) =>
          eb.or([eb("pid", "!=", process.pid), eb("started_at_ms", "<", processStartedAt)]),
        )
        .where((eb) => eb.or([eb("outcome", "is", null), eb("outcome", "!=", "startup_failed")]))
        .limit(1),
    )
  ) {
    return true;
  }
  return Boolean(
    (tableExists(db, "channel_ingress_events") &&
      executeSqliteQueryTakeFirstSync(
        db,
        query.selectFrom("channel_ingress_events").select("event_id").limit(1),
      )) ||
    (tableExists(db, "update_runs") &&
      executeSqliteQueryTakeFirstSync(
        db,
        query.selectFrom("update_runs").select("run_id").limit(1),
      )),
  );
}

/** Freeze prior-operation evidence before boot history is pruned or the first boot is recorded. */
export function prepareWebhookListenerMigrationInDatabase(
  db: DatabaseSync,
  env: NodeJS.ProcessEnv,
  configPath = resolveConfigPath(env),
): WebhookListenerMigrationReceipt {
  const key = webhookListenerMigrationKey(configPath);
  const row = readConfigMachineStateRowInDatabase(db, key);
  if (row) {
    // SAFETY: This migration is the sole writer of this namespaced, versioned receipt.
    return JSON.parse(row.value_json) as WebhookListenerMigrationReceipt;
  }
  return updateConfigMachineStateInDatabase<WebhookListenerMigrationReceipt>(
    db,
    key,
    (current) =>
      current ?? { state: "prepared", phase: "all", existingInstall: hasPriorOperation(db, env) },
    Date.now(),
  );
}
