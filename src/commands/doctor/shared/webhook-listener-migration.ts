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
  WEBHOOK_LISTENER_CHANNEL_IDS as CHANNEL_IDS,
  webhookListenerMigrationKey,
  type WebhookListenerMigrationProgress,
  type WebhookListenerMigrationReceipt as MigrationReceipt,
  type WebhookListenerPin,
} from "../../../infra/webhook-listener-migration-state.js";
import { hashStableJson } from "../../../plugins/installed-plugin-index-hash.js";
import type { PluginManifestRegistry } from "../../../plugins/manifest-registry.types.js";
import { writeConfigMachineState } from "../../../state/config-machine-state-write.js";
import { readConfigMachineState } from "../../../state/config-machine-state.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import { shouldSkipLegacyUpdateDoctorConfigWrite } from "./update-phase.js";

type MigrationResult = {
  changed: boolean;
  changes: string[];
  warnings: string[];
  needsMigration?: boolean;
  inspectionFailed?: boolean;
};

function completedChannelConfigHash(
  config: OpenClawConfig,
  before: WebhookListenerMigrationProgress,
  after: WebhookListenerMigrationProgress,
): string {
  // Writer metadata and unrelated channels do not change a completed listener decision.
  const completed = before.pendingChannelIds.filter((id) => !after.pendingChannelIds.includes(id));
  return hashStableJson(Object.fromEntries(completed.map((id) => [id, config.channels?.[id]])));
}

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

async function runWebhookListenerMigration(
  params: {
    snapshot?: ConfigFileSnapshot;
    env?: NodeJS.ProcessEnv;
    trigger?: "doctor" | "gateway-startup";
    config?: OpenClawConfig;
    manifestRegistry?: PluginManifestRegistry;
    publishConfig?: (config: OpenClawConfig) => Promise<void>;
    assertCurrent?: () => void;
  } = {},
): Promise<MigrationResult> {
  const env = params.env ?? process.env;
  const assertCurrent = () => params.assertCurrent?.();
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
  const prepareReceipt = () => {
    assertCurrent();
    return runOpenClawStateWriteTransaction(
      ({ db }) => prepareWebhookListenerMigrationInDatabase(db, env, configPath),
      { env },
      { operationLabel: "doctor.webhook-listeners.prepare" },
    );
  };
  const readOnly = resolveIsConfigReadOnly(env);
  const migrate = async (): Promise<MigrationResult> => {
    let receipt = readReceipt();
    if (receipt && (await rolledBack(receipt))) {
      // Compatible package rollback retains SQLite but restores the old config bytes.
      receipt = {
        state: "prepared",
        ...(receipt.updateRun?.rollbackProgress ?? {
          pendingChannelIds: receipt.pendingChannelIds,
          ambientTeamsDeferred: receipt.ambientTeamsDeferred,
        }),
        existingInstall: receipt.existingInstall,
      };
      assertCurrent();
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
      // An update can finish multiple channels; rollback restores its original pending set.
      if (updateRun && prepared.updateRun?.id !== updateRun.runId) {
        prepared = {
          ...prepared,
          updateRun: {
            id: updateRun.runId,
            rollbackProgress: {
              pendingChannelIds: prepared.pendingChannelIds,
              ambientTeamsDeferred: prepared.ambientTeamsDeferred,
            },
          },
        };
      }
    };
    const complete = async (progress: WebhookListenerMigrationProgress, publish = true) => {
      assertCurrent();
      if (readOnly) {
        assertBaseSnapshotStillCurrent(snapshot, configPath, fs, {
          hashes: writeOptions.includeFileHashesForWrite ?? {},
          targets: writeOptions.includeFileTargetsForWrite ?? {},
        });
      }
      if (publish) {
        await params.publishConfig?.(publicationConfig);
      }
      assertCurrent();
      writeConfigMachineState(
        key,
        {
          state: progress.pendingChannelIds.length ? "prepared" : "completed",
          ...progress,
          existingInstall: prepared.existingInstall,
          ...(prepared.updateRun ? { updateRun: prepared.updateRun } : {}),
        } satisfies MigrationReceipt,
        { env },
      );
    };
    const io = createConfigIO({ configPath, env, observe: false });
    const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite({ observe: false });
    if (!snapshot.valid && !params.config) {
      return unchanged();
    }
    let publicationConfig = params.config ?? snapshot.sourceConfig;
    const sourceHash = resolveConfigSnapshotHash(snapshot) ?? hashConfigRaw(snapshot.raw);
    if (
      params.config &&
      params.snapshot &&
      sourceHash !==
        (resolveConfigSnapshotHash(params.snapshot) ?? hashConfigRaw(params.snapshot.raw))
    ) {
      throw new Error("Config changed before plugin webhook listener migration publication.");
    }
    if (prepared.sourceHash !== undefined && prepared.sourceHash !== sourceHash) {
      if (
        (prepared.completionConfigHash !== undefined &&
          prepared.nextProgress !== undefined &&
          prepared.completionConfigHash ===
            completedChannelConfigHash(snapshot.sourceConfig, prepared, prepared.nextProgress)) ||
        (prepared.pins?.length &&
          prepared.pins.every((pin) => {
            const value = getConfigValueAtPath(snapshot.sourceConfig, pin.path);
            return pin.value === true
              ? typeof value === "boolean"
              : value === false || typeof asNullableRecord(value)?.port === "number";
          }))
      ) {
        const progress = prepared.nextProgress ?? prepared;
        await complete(progress, false);
        return progress.pendingChannelIds.length ? await migrate() : unchanged();
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
    let migrationInput = publicationConfig;
    const pending = new Set(prepared.pendingChannelIds);
    if (
      prepared.ambientTeamsDeferred &&
      prepared.sourceHash === undefined &&
      Object.hasOwn(snapshot.sourceConfig.channels ?? {}, "msteams")
    ) {
      // This source entry was authored after the initial migration inspected the installed channels.
      pending.delete("msteams");
    }
    if (
      prepared.existingInstall &&
      pending.has("msteams") &&
      !Object.hasOwn(migrationInput.channels ?? {}, "msteams")
    ) {
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
    const ambientTeamsDeferred =
      prepared.existingInstall &&
      pending.has("msteams") &&
      !Object.hasOwn(migrationInput.channels ?? {}, "msteams") &&
      params.trigger !== "gateway-startup";
    // Doctor cannot see service-only credentials; the first Gateway startup bounds that deferral.
    for (const channelId of pending) {
      if (
        !Object.hasOwn(migrationInput.channels ?? {}, channelId) &&
        !(channelId === "msteams" && ambientTeamsDeferred)
      ) {
        pending.delete(channelId);
      }
    }
    const configured = [...pending].filter((id) =>
      Object.hasOwn(migrationInput.channels ?? {}, id),
    );
    const progress = (): WebhookListenerMigrationProgress => ({
      pendingChannelIds: [...pending],
      ...(ambientTeamsDeferred ? { ambientTeamsDeferred: true } : {}),
    });
    if (!configured.length) {
      await associateUpdate();
      await complete(progress());
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
          manifestRegistry: params.manifestRegistry,
        }),
      (channelId) => inspected.add(channelId),
      (channelId) => blocked.add(channelId),
    );
    const previousTeams = snapshot.sourceConfig.channels?.msteams;
    const teams = migrated.config.channels?.msteams;
    const needsTeamsActivation =
      prepared.existingInstall &&
      configured.includes("msteams") &&
      !prepared.ambientTeamsDeferred &&
      previousTeams !== undefined &&
      Object.keys(previousTeams).some((field) => field !== "enabled") &&
      teams !== undefined &&
      teams.enabled === undefined &&
      Object.hasOwn(teams, "legacyWebhook") &&
      Object.keys(teams).every((field) => field === "enabled" || field === "legacyWebhook");
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
    const warnings = missing.length
      ? [
          `Webhook listener migration is pending for ${missing.join(", ")}. Update or repair those plugins, then run openclaw doctor --fix; their listener settings were preserved.`,
        ]
      : [];
    if (migrated.warnings?.length || blocked.size) {
      return {
        ...unchanged(),
        inspectionFailed: true,
        ...(pins.length || blocked.size ? { needsMigration: true } : {}),
        warnings: [
          ...(migrated.warnings ?? []),
          ...warnings,
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
    for (const channelId of configured) {
      if (inspected.has(channelId)) {
        pending.delete(channelId);
      }
    }
    publicationConfig = migrated.config;
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
      await complete(progress());
      return { ...unchanged(), warnings };
    }
    await associateUpdate();
    if (migrated.changes.length || params.publishConfig) {
      assertCurrent();
      writeConfigMachineState(
        key,
        {
          ...prepared,
          sourceHash,
          pins,
          nextProgress: progress(),
          ...(params.publishConfig
            ? {
                completionConfigHash: completedChannelConfigHash(
                  publicationConfig,
                  prepared,
                  progress(),
                ),
              }
            : {}),
        },
        { env },
      );
    }
    if (migrated.changes.length && !params.publishConfig) {
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
          assertConfigPathForWrite: () => {
            writeOptions.assertConfigPathForWrite?.();
            assertCurrent();
          },
        },
        transform: () => ({ nextConfig: migrated.config }),
      });
    }
    // Keep the config lock through receipt publication so an operator removal cannot interleave.
    await complete(progress());
    return { changed: migrated.changes.length > 0, changes: migrated.changes, warnings };
  };
  return readOnly ? await migrate() : await withConfigWriteLock(configPath, migrate, env);
}

/** Doctor and boot admission share this one-shot writer; runtime consumes explicit endpoints. */
export async function migrateImplicitWebhookListeners(
  params: {
    snapshot?: ConfigFileSnapshot;
    env?: NodeJS.ProcessEnv;
    trigger?: "doctor" | "gateway-startup";
  } = {},
): Promise<MigrationResult> {
  return await runWebhookListenerMigration(params);
}

/** Install publication owns the config backup and must finish before a channel's receipt. */
export async function publishImplicitWebhookListenerMigration<T>(
  params: {
    config: OpenClawConfig;
    snapshot: ConfigFileSnapshot;
    manifestRegistry: PluginManifestRegistry;
    pluginIds: readonly string[];
    assertCurrent: () => void;
  },
  publish: (config: OpenClawConfig) => Promise<T>,
): Promise<T> {
  params.assertCurrent();
  if (!params.pluginIds.some((id) => CHANNEL_IDS.some((channelId) => channelId === id))) {
    return await publish(params.config);
  }
  let publication: Promise<T> | undefined;
  const migration = await runWebhookListenerMigration({
    ...params,
    publishConfig: async (config) => {
      params.assertCurrent();
      publication = publish(config);
      await publication;
    },
  });
  if (migration.needsMigration || migration.inspectionFailed) {
    throw new Error(migration.warnings.join("\n"));
  }
  params.assertCurrent();
  return await (publication ?? publish(params.config));
}
