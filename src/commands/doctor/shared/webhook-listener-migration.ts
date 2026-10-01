import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { getConfigValueAtPath } from "../../../config/config-paths.js";
import { createConfigIO } from "../../../config/io.factory.js";
import { hashConfigRaw, resolveConfigSnapshotHash } from "../../../config/io.read-helpers.js";
import { assertBaseSnapshotStillCurrent } from "../../../config/io.write-safety.js";
import { transformConfigFile } from "../../../config/mutate.js";
import { resolveConfigPath, resolveIsConfigReadOnly } from "../../../config/paths.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.openclaw.js";
import { withConfigWriteLock } from "../../../config/write-lock.js";
import {
  prepareWebhookListenerMigrationInDatabase,
  webhookListenerMigrationKey,
  type WebhookListenerMigrationReceipt as MigrationReceipt,
  type WebhookListenerPin,
} from "../../../infra/webhook-listener-migration-state.js";
import { writeConfigMachineState } from "../../../state/config-machine-state-write.js";
import { readConfigMachineState } from "../../../state/config-machine-state.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import { shouldSkipLegacyUpdateDoctorConfigWrite } from "./update-phase.js";

const CHANNEL_IDS = ["feishu", "msteams", "nextcloud-talk", "telegram"] as const;

type MigrationResult = {
  changed: boolean;
  changes: string[];
  warnings: string[];
  needsMigration?: boolean;
};

function collectPins(before: OpenClawConfig, after: OpenClawConfig): WebhookListenerPin[] {
  const pins: WebhookListenerPin[] = [];
  for (const channelId of CHANNEL_IDS) {
    const channel = asNullableRecord(after.channels?.[channelId]);
    if (!channel) {
      continue;
    }
    const collect = (entry: Record<string, unknown>, prefix: string[]) => {
      const value = entry.legacyWebhook;
      const path = [...prefix, "legacyWebhook"];
      if (value && !isDeepStrictEqual(getConfigValueAtPath(before, path), value)) {
        pins.push({ path, value });
      }
      const enabledPath = [...prefix, "enabled"];
      if (entry.enabled === true && getConfigValueAtPath(before, enabledPath) !== true) {
        pins.push({ path: enabledPath, value: true });
      }
    };
    collect(channel, ["channels", channelId]);
    for (const [accountId, value] of Object.entries(asNullableRecord(channel.accounts) ?? {})) {
      const account = asNullableRecord(value);
      if (account) {
        collect(account, ["channels", channelId, "accounts", accountId]);
      }
    }
  }
  return pins;
}

/** Doctor and boot admission share this one-shot config writer; runtime reads only explicit pins. */
export async function migrateImplicitWebhookListeners(
  params: {
    snapshot?: ConfigFileSnapshot;
    env?: NodeJS.ProcessEnv;
    trigger?: "doctor" | "gateway-startup";
  } = {},
): Promise<MigrationResult> {
  const env = params.env ?? process.env;
  const configPath = params.snapshot?.path ?? resolveConfigPath(env);
  const key = webhookListenerMigrationKey(configPath);
  const readReceipt = () =>
    readConfigMachineState<MigrationReceipt>(key, { env }, { artifactPreservingReadOnly: true });
  const unchanged = (): MigrationResult => ({ changed: false, changes: [], warnings: [] });
  const rolledBack = async (receipt: MigrationReceipt | undefined) => {
    if (!receipt?.updateRun) {
      return false;
    }
    const { getUpdateRunAsync } = await import("../../../infra/update-run-reader.js");
    return (await getUpdateRunAsync(receipt.updateRun.id, { env }))?.status === "rolled-back";
  };
  const initial = readReceipt();
  if (
    (initial?.state === "completed" && !(await rolledBack(initial))) ||
    shouldSkipLegacyUpdateDoctorConfigWrite(env)
  ) {
    return unchanged();
  }
  const prepareReceipt = () =>
    runOpenClawStateWriteTransaction(
      ({ db }) => prepareWebhookListenerMigrationInDatabase(db, env, configPath),
      { env },
      { operationLabel: "doctor.webhook-listeners.prepare" },
    );
  const readOnly = resolveIsConfigReadOnly(env);
  const migrate = async (): Promise<MigrationResult> => {
    let receipt = readReceipt();
    if (receipt && (await rolledBack(receipt))) {
      // Compatible package rollback retains SQLite but restores the old config bytes.
      receipt = {
        state: "prepared",
        phase: receipt.updateRun?.rollbackPhase ?? receipt.phase,
        existingInstall: receipt.existingInstall,
      };
      writeConfigMachineState(key, receipt, { env });
    }
    if (receipt?.state === "completed") {
      return unchanged();
    }
    if (!receipt) {
      receipt = prepareReceipt();
    }
    if (receipt.state === "completed") {
      return unchanged();
    }
    let prepared = receipt;
    const associateUpdate = async () => {
      const { resolveDoctorUpdateRun } = await import("../../../infra/update-doctor-run.js");
      const updateRun = resolveDoctorUpdateRun(env);
      // One update can finish both phases; its rollback still restores the pre-migration config.
      if (updateRun && prepared.updateRun?.id !== updateRun.runId) {
        prepared = {
          ...prepared,
          updateRun: { id: updateRun.runId, rollbackPhase: prepared.phase },
        };
      }
    };
    const complete = (nextPhase: "ambient-teams" | undefined) => {
      if (readOnly) {
        assertBaseSnapshotStillCurrent(snapshot, configPath, fs, {
          hashes: writeOptions.includeFileHashesForWrite ?? {},
          targets: writeOptions.includeFileTargetsForWrite ?? {},
        });
      }
      writeConfigMachineState(
        key,
        {
          state: nextPhase ? "prepared" : "completed",
          phase: nextPhase ?? prepared.phase,
          existingInstall: prepared.existingInstall,
          ...(prepared.updateRun ? { updateRun: prepared.updateRun } : {}),
        } satisfies MigrationReceipt,
        { env },
      );
    };
    const io = createConfigIO({ configPath, env, observe: false });
    const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite({ observe: false });
    if (!snapshot.valid) {
      return unchanged();
    }
    const sourceHash = resolveConfigSnapshotHash(snapshot) ?? hashConfigRaw(snapshot.raw);
    if (prepared.sourceHash !== undefined && prepared.sourceHash !== sourceHash) {
      if (
        prepared.pins?.length &&
        prepared.pins.every((pin) => {
          const value = getConfigValueAtPath(snapshot.sourceConfig, pin.path);
          return pin.value === true
            ? typeof value === "boolean"
            : value === false || typeof asNullableRecord(value)?.port === "number";
        })
      ) {
        complete(prepared.nextPhase);
        return prepared.nextPhase ? await migrate() : unchanged();
      }
      return {
        ...unchanged(),
        needsMigration: true,
        warnings: [
          `Webhook listener migration was interrupted and its source config changed. Existing settings were preserved. ${
            prepared.pins?.length
              ? `Set each planned endpoint explicitly, using its desired endpoint object or false to retire it: ${prepared.pins
                  .map((pin) => `${pin.path.join(".")}=${JSON.stringify(pin.value)} or false`)
                  .join(", ")}.`
              : "Review the adjacent config backup and restore its source to retry the migration."
          } Then run openclaw doctor --fix. Removed pins were not recreated.`,
        ],
      };
    }
    let migrationInput = snapshot.sourceConfig;
    if (
      prepared.phase === "ambient-teams" &&
      prepared.sourceHash === undefined &&
      Object.hasOwn(migrationInput.channels ?? {}, "msteams")
    ) {
      // This source entry was authored after the initial migration inspected the installed channels.
      await associateUpdate();
      complete(undefined);
      return unchanged();
    }
    if (prepared.existingInstall && !Object.hasOwn(migrationInput.channels ?? {}, "msteams")) {
      const { applyPluginAutoEnable } = await import("../../../config/plugin-auto-enable.js");
      const activation = applyPluginAutoEnable({
        config: migrationInput,
        env,
        ambientEnvTriggers: "allow",
      }).config;
      if (activation.channels?.msteams?.enabled === true) {
        // Preserve transport without converting invocation-scoped activation into source intent.
        migrationInput = {
          ...migrationInput,
          channels: { ...migrationInput.channels, msteams: {} },
        };
      }
    }
    const nextPhase =
      prepared.existingInstall &&
      !Object.hasOwn(migrationInput.channels ?? {}, "msteams") &&
      params.trigger !== "gateway-startup"
        ? "ambient-teams"
        : undefined;
    // Doctor cannot see service-only credentials; the first Gateway startup bounds that deferral.
    if (prepared.phase === "ambient-teams" && nextPhase) {
      return unchanged();
    }
    const configured = (prepared.phase === "ambient-teams" ? ["msteams"] : CHANNEL_IDS).filter(
      (id) => Object.hasOwn(migrationInput.channels ?? {}, id),
    );
    if (!configured.length) {
      await associateUpdate();
      complete(nextPhase);
      return unchanged();
    }
    const [{ withImplicitLegacyWebhookMigration }, { applyPluginDoctorCompatibilityMigrations }] =
      await Promise.all([
        import("../../../plugin-sdk/legacy-webhook-listener-migration.js"),
        import("../../../plugins/doctor-contract-registry.js"),
      ]);
    const inspected = new Set<string>();
    const blocked = new Set<string>();
    const migrated = withImplicitLegacyWebhookMigration(
      prepared.existingInstall,
      () =>
        applyPluginDoctorCompatibilityMigrations(migrationInput, {
          config: migrationInput,
          env,
          pluginIds: [...configured],
        }),
      (channelId) => inspected.add(channelId),
      (channelId) => blocked.add(channelId),
    );
    const previousTeams = snapshot.sourceConfig.channels?.msteams;
    const teams = migrated.config.channels?.msteams;
    const needsTeamsActivation =
      prepared.existingInstall &&
      prepared.phase === "all" &&
      previousTeams !== undefined &&
      Object.keys(previousTeams).some((key) => key !== "enabled") &&
      teams !== undefined &&
      teams.enabled === undefined &&
      Object.hasOwn(teams, "legacyWebhook") &&
      Object.keys(teams).every((key) => key === "enabled" || key === "legacyWebhook");
    const teamsListener = teams?.legacyWebhook;
    if (teamsListener === false || (teamsListener && typeof teamsListener.port === "number")) {
      // Explicit canonical settings do not depend on the installed plugin's implicit-default hook.
      inspected.add("msteams");
    }
    if (needsTeamsActivation && teams) {
      migrated.config = {
        ...migrated.config,
        channels: { ...migrated.config.channels, msteams: { ...teams, enabled: true } },
      };
      migrated.changes.push(
        "Set channels.msteams.enabled to preserve activation previously implied by its listener settings.",
      );
    }
    const pins = collectPins(snapshot.sourceConfig, migrated.config);
    const missing = configured.filter((id) => !inspected.has(id));
    if (missing.length || migrated.warnings?.length || blocked.size) {
      return {
        ...unchanged(),
        ...(pins.length || blocked.size ? { needsMigration: true } : {}),
        warnings: [
          ...(migrated.warnings ?? []),
          ...(missing.length
            ? [
                `Webhook listener migration is pending for ${missing.join(", ")}. Update or repair those plugins, then run openclaw doctor --fix; their listener settings were preserved.`,
              ]
            : []),
          ...(pins.length
            ? [
                `Webhook listeners require these explicit settings before startup: ${pins
                  .map((pin) => `${pin.path.join(".")}=${JSON.stringify(pin.value)}`)
                  .join(
                    ", ",
                  )}. Repair the listed plugins and run openclaw doctor --fix before restarting, or configure these settings explicitly (false opts out). No partial migration was written.`,
              ]
            : []),
        ],
      };
    }
    if (readOnly) {
      if (pins.length) {
        return {
          ...unchanged(),
          needsMigration: true,
          warnings: [
            `Webhook listeners need explicit endpoints before this read-only config can start: ${pins
              .map((pin) => `${pin.path.join(".")}=${JSON.stringify(pin.value)}`)
              .join(
                ", ",
              )}. Add these pins in the external config source, or enable config writes and run openclaw doctor --fix. Keep the previous Gateway running until this migration succeeds.`,
          ],
        };
      }
      await associateUpdate();
      complete(nextPhase);
      return unchanged();
    }
    await associateUpdate();
    if (migrated.changes.length) {
      writeConfigMachineState(key, { ...prepared, sourceHash, pins, nextPhase }, { env });
      await transformConfigFile({
        base: "source",
        baseHash: sourceHash,
        io,
        afterWrite: { mode: "none", reason: "automatic migration" },
        writeOptions: {
          ...writeOptions,
          auditOrigin: "doctor",
          expectedConfigPath: configPath,
          observe: false,
          skipRuntimeSnapshotRefresh: true,
        },
        transform: () => ({ nextConfig: migrated.config }),
      });
    }
    // Keep the config lock through receipt publication so an operator removal cannot interleave.
    complete(nextPhase);
    return { changed: migrated.changes.length > 0, changes: migrated.changes, warnings: [] };
  };
  return readOnly ? await migrate() : await withConfigWriteLock(configPath, migrate, env);
}
