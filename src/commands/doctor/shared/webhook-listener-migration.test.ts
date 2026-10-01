import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createConfigIO } from "../../../config/io.factory.js";
import { resolveConfigWidePluginMetadataSnapshot } from "../../../config/io.plugin-metadata.js";
import * as configWrite from "../../../config/io.write.js";
import { transformConfigFile } from "../../../config/mutate.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveIdentityPathViaExistingAncestorSync } from "../../../infra/boundary-path.js";
import { recordGatewayBootStart } from "../../../infra/gateway-boot-lifecycle.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import { withSqliteReadOnlyWorkerScope } from "../../../infra/sqlite-readonly-worker.js";
import { createUpdateRun, finishUpdateRun } from "../../../infra/update-run-ledger.js";
import { readConfigMachineState } from "../../../state/config-machine-state.js";
import type { DB } from "../../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import {
  migrateImplicitWebhookListeners,
  publishImplicitWebhookListenerMigration,
} from "./webhook-listener-migration.js";

const config: OpenClawConfig = {
  channels: {
    feishu: {
      enabled: true,
      connectionMode: "webhook",
      appId: "synthetic-webhook-app",
      appSecret: "synthetic-webhook-app-secret",
      verificationToken: "synthetic-verification-token",
      encryptKey: "synthetic-encrypt-key",
    },
  },
};

const env = {
  OPENCLAW_UPDATE_IN_PROGRESS: "0",
  OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "0",
  OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "0",
};

const teamsEnv = {
  MSTEAMS_APP_ID: "synthetic-teams-app",
  MSTEAMS_APP_PASSWORD: "synthetic-teams-password",
  MSTEAMS_TENANT_ID: "synthetic-teams-tenant",
};

const noTeamsEnv = {
  MSTEAMS_APP_ID: undefined,
  MSTEAMS_APP_PASSWORD: undefined,
  MSTEAMS_TENANT_ID: undefined,
};

async function withMigrationState(label: string, run: (state: OpenClawTestState) => Promise<void>) {
  await withOpenClawTestState({ label, env }, (state) =>
    withSqliteReadOnlyWorkerScope(() => run(state)),
  );
}

function readReceipt(state: OpenClawTestState) {
  const suffix = createHash("sha256")
    .update(resolveIdentityPathViaExistingAncestorSync(state.configPath))
    .digest("hex");
  return readConfigMachineState<{ state: string; existingInstall?: boolean }>(
    `doctor.webhook-listeners.v1:${suffix}`,
    { env: state.env },
  );
}

function recordPriorBoot(state: OpenClawTestState) {
  runOpenClawStateWriteTransaction(
    ({ db }) =>
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .insertInto("gateway_boot_lifecycle")
          .values({
            boot_id: randomUUID(),
            pid: process.pid,
            started_at_ms: Date.now() - 48 * 60 * 60_000,
            completed_at_ms: Date.now() - 25 * 60 * 60_000,
            outcome: "clean_stop",
            reason: null,
            startup_reason: null,
          }),
      ),
    { env: state.env },
  );
}

async function readPersisted(state: OpenClawTestState): Promise<OpenClawConfig> {
  return JSON.parse(await fs.readFile(state.configPath, "utf8"));
}

describe("one-shot webhook listener migration", () => {
  it("recovers a committed zero-pin publication without treating writer metadata as an operator edit", async () => {
    await withMigrationState("webhook-zero-pin-publication", async (state) => {
      const authored: OpenClawConfig = {
        ...config,
        channels: {
          ...config.channels,
          feishu: { ...config.channels?.feishu, legacyWebhook: false },
        },
      };
      await state.writeConfig(authored);
      recordPriorBoot(state);
      const { snapshot } = await createConfigIO({
        configPath: state.configPath,
        env: state.env,
      }).readConfigFileSnapshotForWrite();
      const metadata = resolveConfigWidePluginMetadataSnapshot({ config: snapshot.sourceConfig });
      const failure = new Error("synthetic failure after config commit");
      await expect(
        publishImplicitWebhookListenerMigration(
          {
            config: snapshot.sourceConfig,
            snapshot,
            manifestRegistry: metadata.manifestRegistry,
            pluginIds: ["feishu"],
            assertCurrent: () => {},
          },
          async (nextConfig) => {
            await transformConfigFile({
              base: "source",
              transform: () => ({ nextConfig }),
            });
            throw failure;
          },
        ),
      ).rejects.toBe(failure);
      expect((await readPersisted(state)).meta?.lastTouchedVersion).toEqual(expect.any(String));
      expect((await migrateImplicitWebhookListeners({ env: state.env })).warnings).toEqual([]);
      await transformConfigFile({
        base: "source",
        transform: (current) => {
          const nextConfig = structuredClone(current);
          delete nextConfig.channels?.feishu?.legacyWebhook;
          return { nextConfig };
        },
      });
      await migrateImplicitWebhookListeners({ env: state.env });
      expect((await readPersisted(state)).channels?.feishu?.legacyWebhook).toBeUndefined();
      expect(
        (await readPersisted(state)).channels?.feishu?.accounts?.default?.legacyWebhook,
      ).toBeUndefined();
    });
  });
  it("backs up and pins prior listeners through the loaded plugin, then respects removal", async () => {
    await withMigrationState("webhook-existing", async (state) => {
      await state.writeConfig(config);
      const original = await fs.readFile(state.configPath, "utf8");
      recordPriorBoot(state);
      // Boot prunes this 48-hour-old row; the one-shot decision must survive that pruning.
      expect(recordGatewayBootStart(state.env)).toBeDefined();

      const migrated = await migrateImplicitWebhookListeners({ env: state.env });

      expect(migrated.changed).toBe(true);
      expect(migrated.warnings).toEqual([]);
      expect(
        (await readPersisted(state)).channels?.feishu?.accounts?.default?.legacyWebhook,
      ).toEqual({
        host: "127.0.0.1",
        port: 3000,
      });
      expect(await fs.readFile(`${state.configPath}.bak`, "utf8")).toBe(original);
      expect(readReceipt(state)).toMatchObject({
        state: "prepared",
        pendingChannelIds: ["msteams"],
        ambientTeamsDeferred: true,
      });

      await transformConfigFile({
        base: "source",
        transform: (current) => {
          const nextConfig = structuredClone(current);
          delete nextConfig.channels?.feishu?.accounts?.default?.legacyWebhook;
          return { nextConfig };
        },
      });
      expect(await migrateImplicitWebhookListeners({ env: state.env })).toEqual({
        changed: false,
        changes: [],
        warnings: [],
      });
      expect(
        (await readPersisted(state)).channels?.feishu?.accounts?.default?.legacyWebhook,
      ).toBeUndefined();
      const alias = state.path("config-alias");
      await fs.symlink(path.dirname(state.configPath), alias, "dir");
      await migrateImplicitWebhookListeners({
        env: {
          ...state.env,
          OPENCLAW_CONFIG_PATH: path.join(alias, path.basename(state.configPath)),
        },
      });
      expect(
        (await readPersisted(state)).channels?.feishu?.accounts?.default?.legacyWebhook,
      ).toBeUndefined();
    });
  });

  it("does not mistake its first boot or an old version stamp for an existing installation", async () => {
    await withMigrationState("webhook-fresh", async (state) => {
      await state.writeConfig({ ...config, meta: { lastTouchedVersion: "2026.9.1" } });
      expect(recordGatewayBootStart(state.env)).toBeDefined();

      const migrated = await migrateImplicitWebhookListeners({ env: state.env });

      expect(migrated).toEqual({ changed: false, changes: [], warnings: [] });
      expect(readReceipt(state)).toMatchObject({ state: "completed" });
      expect(
        (await readPersisted(state)).channels?.feishu?.accounts?.default?.legacyWebhook,
      ).toBeUndefined();

      recordPriorBoot(state);
      await migrateImplicitWebhookListeners({ env: state.env });
      expect(
        (await readPersisted(state)).channels?.feishu?.accounts?.default?.legacyWebhook,
      ).toBeUndefined();
    });
  });

  it("pins only Telegram accounts whose routes cannot use the configured public Gateway origin", async () => {
    await withMigrationState("webhook-telegram-routes", async (state) => {
      const telegram = {
        enabled: true,
        webhookSecret: "synthetic-webhook-secret",
        accounts: {
          default: { webhookUrl: "https://gateway.example.test/telegram-webhook" },
          proxy: { webhookUrl: "https://callback.example.test/telegram-webhook" },
          proxyPath: { webhookUrl: "https://gateway.example.test/proxy?route=telegram" },
          reserved: {
            webhookUrl: "https://gateway.example.test/readyz?token=known",
            webhookPath: "/readyz?token=known",
          },
          protected: {
            webhookUrl: "https://gateway.example.test/%61pi/channels/telegram",
            webhookPath: "/%61pi/channels/telegram",
          },
          disabled: {
            enabled: false,
            webhookUrl: "https://callback.example.test/disabled",
            webhookPath: "/ready",
          },
        },
      } satisfies NonNullable<OpenClawConfig["channels"]>["telegram"];
      await state.writeConfig({
        gateway: { publicOrigin: "https://gateway.example.test" },
        channels: { telegram },
      });
      recordPriorBoot(state);

      const migrated = await migrateImplicitWebhookListeners({ env: state.env });

      expect(migrated.changed).toBe(true);
      expect(migrated.warnings).toEqual([]);
      expect((await readPersisted(state)).channels?.telegram).toEqual({
        ...telegram,
        accounts: {
          ...telegram.accounts,
          proxy: {
            ...telegram.accounts.proxy,
            legacyWebhook: { host: "127.0.0.1", port: 8787 },
          },
          proxyPath: {
            ...telegram.accounts.proxyPath,
            legacyWebhook: { host: "127.0.0.1", port: 8787 },
          },
          reserved: {
            ...telegram.accounts.reserved,
            legacyWebhook: { host: "127.0.0.1", port: 8787 },
          },
          protected: {
            ...telegram.accounts.protected,
            legacyWebhook: { host: "127.0.0.1", port: 8787 },
          },
        },
      });
      expect(readReceipt(state)).toMatchObject({
        state: "prepared",
        pendingChannelIds: ["msteams"],
        ambientTeamsDeferred: true,
      });
    });
  });

  it("blocks startup when account aliases prevent safely preserving an existing listener", async () => {
    await withMigrationState("webhook-ambiguous-accounts", async (state) => {
      await state.writeConfig({
        channels: {
          telegram: {
            enabled: true,
            webhookSecret: "synthetic-webhook-secret",
            accounts: {
              Ops: { webhookUrl: "https://callback.example.test/first" },
              OPS: { webhookUrl: "https://callback.example.test/second" },
            },
          },
        },
      });
      const original = await fs.readFile(state.configPath, "utf8");
      recordPriorBoot(state);

      const migrated = await migrateImplicitWebhookListeners({ env: state.env });

      expect(migrated).toMatchObject({ changed: false, changes: [], needsMigration: true });
      expect(migrated.warnings.join("\n")).toContain(
        'account keys "Ops", "OPS" normalize to the same ID',
      );
      const { loadGatewayStartupConfigSnapshot } =
        await import("../../../gateway/server-startup-config-helpers.js");
      await expect(
        loadGatewayStartupConfigSnapshot({
          minimalTestGateway: false,
          ambientEnvTriggers: "suppress",
          log: { info: vi.fn(), warn: vi.fn() },
        }),
      ).rejects.toThrow('account keys "Ops", "OPS" normalize to the same ID');
      expect(await fs.readFile(state.configPath, "utf8")).toBe(original);
      expect(readReceipt(state)).toMatchObject({ state: "prepared", existingInstall: true });
    });
  });

  it.each([false, true])(
    "preserves ambient Teams activation through migration, startup, and reload (existing=%s)",
    async (existing) => {
      await withEnvAsync(teamsEnv, () =>
        withMigrationState("webhook-ambient-teams", async (state) => {
          await state.writeConfig(config);
          if (existing) {
            recordPriorBoot(state);
          }
          await withEnvAsync(noTeamsEnv, () =>
            migrateImplicitWebhookListeners({ env: { ...state.env, ...noTeamsEnv } }),
          );
          expect((await readPersisted(state)).channels?.msteams).toBeUndefined();
          if (existing) {
            expect(
              (await readPersisted(state)).channels?.feishu?.accounts?.default?.legacyWebhook,
            ).toBeDefined();
            await transformConfigFile({
              base: "source",
              transform: (current) => {
                const nextConfig = structuredClone(current);
                delete nextConfig.channels?.feishu?.accounts?.default?.legacyWebhook;
                return { nextConfig };
              },
            });
          }
          const { loadGatewayStartupConfigSnapshot } =
            await import("../../../gateway/server-startup-config-helpers.js");
          const { resolveGatewayReloadPluginActivationCandidate } =
            await import("../../../gateway/plugin-activation-runtime-config.js");
          const { listGatewayActivatedChannelIds } =
            await import("../../../plugins/channel-presence-policy.js");

          if (existing) {
            await withEnvAsync({ OPENCLAW_CONFIG_READONLY: "1" }, async () => {
              await expect(
                loadGatewayStartupConfigSnapshot({
                  minimalTestGateway: false,
                  ambientEnvTriggers: "allow",
                  log: { info: vi.fn(), warn: vi.fn() },
                }),
              ).rejects.toThrow("channels.msteams.legacyWebhook");
            });
            const refused = vi
              .spyOn(configWrite, "writeConfigFileFromContext")
              .mockRejectedValueOnce(new Error("synthetic ambient pin write refusal"));
            try {
              await expect(migrateImplicitWebhookListeners({ env: state.env })).rejects.toThrow(
                "synthetic ambient pin write refusal",
              );
            } finally {
              refused.mockRestore();
            }
          }
          for (const ambientEnvTriggers of ["suppress", "allow"] as const) {
            const startup = await loadGatewayStartupConfigSnapshot({
              minimalTestGateway: false,
              ambientEnvTriggers,
              log: { info: vi.fn(), warn: vi.fn() },
            });
            const sourceConfig = startup.snapshot.sourceConfig;
            expect(sourceConfig.channels?.msteams).toEqual(
              existing ? { legacyWebhook: { port: 3978 } } : undefined,
            );
            expect(sourceConfig.channels?.feishu?.accounts?.default?.legacyWebhook).toBeUndefined();
            const reload = resolveGatewayReloadPluginActivationCandidate({
              sourceConfig,
              env: state.env,
              manifestRegistry: startup.pluginMetadataSnapshot?.manifestRegistry,
              discovery: startup.pluginMetadataSnapshot?.discovery,
              ambientEnvTriggers,
            });
            for (const runtimeConfig of [startup.snapshot.config, reload]) {
              expect(runtimeConfig.channels?.msteams?.enabled === true).toBe(
                ambientEnvTriggers === "allow",
              );
              expect(
                listGatewayActivatedChannelIds({
                  config: runtimeConfig,
                  activationSourceConfig: sourceConfig,
                  env: state.env,
                  manifestRecords: startup.pluginMetadataSnapshot?.plugins,
                  discovery: startup.pluginMetadataSnapshot?.discovery,
                  ambientEnvTriggers,
                }).includes("msteams"),
              ).toBe(ambientEnvTriggers === "allow");
            }
          }
          expect(readReceipt(state)).toMatchObject({ state: "completed" });
          if (existing) {
            await transformConfigFile({
              base: "source",
              transform: (current) => {
                const nextConfig = structuredClone(current);
                delete nextConfig.channels?.msteams?.legacyWebhook;
                return { nextConfig };
              },
            });
            expect((await migrateImplicitWebhookListeners({ env: state.env })).changed).toBe(false);
            expect((await readPersisted(state)).channels?.msteams?.legacyWebhook).toBeUndefined();
            expect(
              (await readPersisted(state)).channels?.feishu?.accounts?.default?.legacyWebhook,
            ).toBeUndefined();
          }
        }),
      );
    },
  );

  it.each(["gateway startup", "authored configuration"] as const)(
    "settles deferred Teams after %s without pinning later additions",
    async (settledBy) => {
      await withEnvAsync(noTeamsEnv, () =>
        withMigrationState("webhook-ambient-teams-cutoff", async (state) => {
          await state.writeConfig(config);
          recordPriorBoot(state);
          await migrateImplicitWebhookListeners({ env: state.env });
          await transformConfigFile({
            base: "source",
            transform: (current) => {
              const nextConfig = structuredClone(current);
              delete nextConfig.channels?.feishu?.accounts?.default?.legacyWebhook;
              return { nextConfig };
            },
          });
          const { loadGatewayStartupConfigSnapshot } =
            await import("../../../gateway/server-startup-config-helpers.js");
          const startupParams = {
            minimalTestGateway: false,
            ambientEnvTriggers: "allow" as const,
            log: { info: vi.fn(), warn: vi.fn() },
          };
          if (settledBy === "gateway startup") {
            const original = await fs.readFile(state.configPath, "utf8");
            await withEnvAsync({ OPENCLAW_CONFIG_READONLY: "1" }, () =>
              loadGatewayStartupConfigSnapshot(startupParams),
            );
            expect(await fs.readFile(state.configPath, "utf8")).toBe(original);
          } else {
            const source = await readPersisted(state);
            await state.writeConfig({
              ...source,
              channels: { ...source.channels, msteams: { enabled: true } },
            });
            expect((await migrateImplicitWebhookListeners({ env: state.env })).changed).toBe(false);
          }

          await withEnvAsync(teamsEnv, async () => {
            const configuredEnv = { ...state.env, ...teamsEnv };
            await migrateImplicitWebhookListeners({ env: configuredEnv });
            const startup = await loadGatewayStartupConfigSnapshot(startupParams);
            expect(startup.snapshot.config.channels?.msteams?.enabled).toBe(true);
            expect(startup.snapshot.sourceConfig.channels?.msteams?.legacyWebhook).toBeUndefined();
            expect(
              startup.snapshot.sourceConfig.channels?.feishu?.accounts?.default?.legacyWebhook,
            ).toBeUndefined();
            const source = await readPersisted(state);
            await state.writeConfig({
              ...source,
              channels: { ...source.channels, msteams: { enabled: true } },
            });
            await migrateImplicitWebhookListeners({ env: configuredEnv });
            expect((await readPersisted(state)).channels?.msteams).toEqual({ enabled: true });
          });
          expect(readReceipt(state)).toMatchObject({ state: "completed", pendingChannelIds: [] });
        }),
      );
    },
  );

  it("settles pending Teams without pinning an operator-disabled channel", async () => {
    await withMigrationState("webhook-disabled-ambient-teams", async (state) => {
      await state.writeConfig({});
      recordPriorBoot(state);
      await migrateImplicitWebhookListeners({ env: state.env });
      await state.writeConfig({ channels: { msteams: { enabled: false } } });
      const configuredEnv = { ...state.env, ...teamsEnv };

      expect((await migrateImplicitWebhookListeners({ env: configuredEnv })).changed).toBe(false);
      expect((await readPersisted(state)).channels?.msteams).toEqual({ enabled: false });
      expect(readReceipt(state)).toMatchObject({ state: "completed", pendingChannelIds: [] });

      await state.writeConfig({ channels: { msteams: { enabled: true } } });
      await migrateImplicitWebhookListeners({ env: configuredEnv });
      expect((await readPersisted(state)).channels?.msteams).toEqual({ enabled: true });
    });
  });

  it.each([
    { name: "explicit endpoint", legacyWebhook: { port: 3978 } },
    { name: "explicit opt-out", legacyWebhook: false },
    { name: "implicit listener beside Feishu", legacyWebhook: undefined },
  ] as const)(
    "preserves $name with a selected older Teams Doctor contract",
    async ({ legacyWebhook }) => {
      await withMigrationState("webhook-older-teams", async (state) => {
        const pluginDir = state.path("msteams-9.7");
        await fs.mkdir(pluginDir);
        await fs.writeFile(
          path.join(pluginDir, "package.json"),
          JSON.stringify({
            name: "@openclaw/msteams",
            version: "2026.9.7",
            type: "module",
            openclaw: { extensions: ["./index.ts"] },
          }),
        );
        await fs.writeFile(
          path.join(pluginDir, "openclaw.plugin.json"),
          JSON.stringify({
            id: "msteams",
            channels: ["msteams"],
            configSchema: { type: "object", properties: {}, additionalProperties: false },
            doctorContract: { configRepair: true },
          }),
        );
        await fs.writeFile(
          path.join(pluginDir, "index.ts"),
          'export default { id: "msteams", register() {} };\n',
        );
        await fs.writeFile(
          path.join(pluginDir, "doctor-contract-api.ts"),
          `import { createLegacyWebhookListenerDoctorContract } from "openclaw/plugin-sdk/runtime-doctor-migrations";
export const { legacyConfigRules, normalizeCompatibilityConfig } = createLegacyWebhookListenerDoctorContract({
  channelKey: "msteams", defaultPort: 3978, webhookKey: "webhook", portKey: "port", hostKey: null,
});\n`,
        );
        await state.writeConfig({
          plugins: { load: { paths: [pluginDir] } },
          channels: {
            ...(legacyWebhook === undefined ? config.channels : {}),
            msteams: legacyWebhook === undefined ? { enabled: true } : { legacyWebhook },
          },
        });
        const original = await fs.readFile(state.configPath, "utf8");
        recordPriorBoot(state);
        const { loadGatewayStartupConfigSnapshot } =
          await import("../../../gateway/server-startup-config-helpers.js");
        const startupParams = {
          minimalTestGateway: false,
          ambientEnvTriggers: "suppress" as const,
          log: { info: vi.fn(), warn: vi.fn() },
        };
        const requiredSetting =
          legacyWebhook === undefined
            ? "channels.feishu.accounts.default.legacyWebhook"
            : "channels.msteams.enabled=true";
        await withEnvAsync({ OPENCLAW_CONFIG_READONLY: "1" }, async () => {
          await expect(loadGatewayStartupConfigSnapshot(startupParams)).rejects.toThrow(
            requiredSetting,
          );
        });
        expect(await fs.readFile(state.configPath, "utf8")).toBe(original);
        if (legacyWebhook === undefined) {
          const startup = await loadGatewayStartupConfigSnapshot(startupParams);
          expect(
            startup.snapshot.sourceConfig.channels?.feishu?.accounts?.default?.legacyWebhook,
          ).toEqual({ port: 3000, host: "127.0.0.1" });
          expect(startup.snapshot.sourceConfig.channels?.msteams).toEqual({ enabled: true });
          expect(readReceipt(state)).toMatchObject({
            state: "prepared",
            pendingChannelIds: ["msteams"],
          });
          await transformConfigFile({
            base: "source",
            transform: (current) => {
              const nextConfig = structuredClone(current);
              delete nextConfig.channels?.feishu?.accounts?.default?.legacyWebhook;
              return { nextConfig };
            },
          });
          await migrateImplicitWebhookListeners({ env: state.env });
          expect(
            (await readPersisted(state)).channels?.feishu?.accounts?.default?.legacyWebhook,
          ).toBeUndefined();
          const upgradedPlugin = state.path("msteams-9.8");
          await fs.cp(pluginDir, upgradedPlugin, { recursive: true });
          const contractPath = path.join(upgradedPlugin, "doctor-contract-api.ts");
          await fs.writeFile(
            contractPath,
            (await fs.readFile(contractPath, "utf8")).replace(
              'channelKey: "msteams",',
              'channelKey: "msteams", implicitAccountIds: () => [undefined],',
            ),
          );
          await transformConfigFile({
            base: "source",
            transform: (current) => ({
              nextConfig: { ...current, plugins: { load: { paths: [upgradedPlugin] } } },
            }),
          });
          await migrateImplicitWebhookListeners({ env: state.env });
          expect((await readPersisted(state)).channels?.msteams?.legacyWebhook).toEqual({
            port: 3978,
          });
          expect(
            (await readPersisted(state)).channels?.feishu?.accounts?.default?.legacyWebhook,
          ).toBeUndefined();
          expect(readReceipt(state)).toMatchObject({ state: "completed", pendingChannelIds: [] });
          return;
        }
        const startup = await loadGatewayStartupConfigSnapshot(startupParams);

        expect(startup.pluginMetadataSnapshot?.plugins).toContainEqual(
          expect.objectContaining({ id: "msteams", rootDir: pluginDir, origin: "config" }),
        );
        expect(startup.snapshot.sourceConfig.channels?.msteams).toEqual({
          legacyWebhook,
          enabled: true,
        });
        expect(startup.snapshot.config.channels?.msteams?.enabled).toBe(true);
        expect(await fs.readFile(`${state.configPath}.bak`, "utf8")).toBe(original);
        expect(readReceipt(state)).toMatchObject({ state: "completed" });
      });
    },
  );

  it("keeps a failed fresh startup fresh when the config is repaired later", async () => {
    await withMigrationState("webhook-fresh-invalid", async (state) => {
      await state.writeConfig({ gateway: { port: "invalid" } });
      await migrateImplicitWebhookListeners({ env: state.env });
      expect(readReceipt(state)).toEqual({
        state: "prepared",
        pendingChannelIds: ["feishu", "msteams", "nextcloud-talk", "telegram"],
        existingInstall: false,
      });

      recordPriorBoot(state);
      await state.writeConfig(config);
      await migrateImplicitWebhookListeners({ env: state.env });

      expect(readReceipt(state)).toMatchObject({ state: "completed" });
      expect(
        (await readPersisted(state)).channels?.feishu?.accounts?.default?.legacyWebhook,
      ).toBeUndefined();
    });
  });

  it.each([false, true])(
    "preserves refused writes and subsequent edits (operator edit=%s)",
    async (operatorEdit) => {
      await withMigrationState("webhook-write-failure", async (state) => {
        await state.writeConfig(config);
        const original = await fs.readFile(state.configPath, "utf8");
        recordPriorBoot(state);
        const refused = vi
          .spyOn(configWrite, "writeConfigFileFromContext")
          .mockRejectedValueOnce(new Error("synthetic config write refusal"));
        try {
          await expect(migrateImplicitWebhookListeners({ env: state.env })).rejects.toThrow(
            "synthetic config write refusal",
          );
        } finally {
          refused.mockRestore();
        }

        expect(readReceipt(state)).toMatchObject({ state: "prepared", existingInstall: true });
        expect(await fs.readFile(state.configPath, "utf8")).toBe(original);
        if (operatorEdit) {
          await state.writeConfig({ ...config, gateway: { mode: "local" } });
          const { loadGatewayStartupConfigSnapshot } =
            await import("../../../gateway/server-startup-config-helpers.js");
          await expect(
            loadGatewayStartupConfigSnapshot({
              minimalTestGateway: false,
              ambientEnvTriggers: "suppress",
              log: { info: vi.fn(), warn: vi.fn() },
            }),
          ).rejects.toThrow("Set each planned endpoint explicitly");
          expect(
            (await readPersisted(state)).channels?.feishu?.accounts?.default?.legacyWebhook,
          ).toBeUndefined();
          await state.writeConfig({
            ...config,
            gateway: { mode: "local" },
            channels: {
              feishu: {
                ...config.channels?.feishu,
                accounts: { default: { legacyWebhook: false } },
              },
            },
          });
          await migrateImplicitWebhookListeners({ env: state.env });
          expect(readReceipt(state)).toMatchObject({
            state: "prepared",
            pendingChannelIds: ["msteams"],
            ambientTeamsDeferred: true,
          });
          expect(
            (await readPersisted(state)).channels?.feishu?.accounts?.default?.legacyWebhook,
          ).toBe(false);
          return;
        }
        await migrateImplicitWebhookListeners({ env: state.env });
        expect(readReceipt(state)).toMatchObject({
          state: "prepared",
          pendingChannelIds: ["msteams"],
          ambientTeamsDeferred: true,
        });
        expect(
          (await readPersisted(state)).channels?.feishu?.accounts?.default?.legacyWebhook,
        ).toEqual({
          host: "127.0.0.1",
          port: 3000,
        });
      });
    },
  );

  it("reopens only the channels changed by a rolled-back update", async () => {
    await withMigrationState("webhook-update-rollback", async (state) => {
      await state.writeConfig(config);
      const original = await fs.readFile(state.configPath, "utf8");
      const ambientEnv = {
        ...state.env,
        ...teamsEnv,
      };
      const first = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const firstEnv = { ...state.env, OPENCLAW_UPDATE_RUN_ID: first.runId };
      await migrateImplicitWebhookListeners({ env: firstEnv });
      expect(
        (await readPersisted(state)).channels?.feishu?.accounts?.default?.legacyWebhook,
      ).toBeDefined();
      await migrateImplicitWebhookListeners({
        env: { ...ambientEnv, OPENCLAW_UPDATE_RUN_ID: first.runId },
      });
      expect((await readPersisted(state)).channels?.msteams?.legacyWebhook).toEqual({ port: 3978 });

      await fs.writeFile(state.configPath, original);
      finishUpdateRun(first.runId, { status: "rolled-back" }, { env: state.env });
      const second = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const secondEnv = { ...state.env, OPENCLAW_UPDATE_RUN_ID: second.runId };
      expect((await migrateImplicitWebhookListeners({ env: secondEnv })).changed).toBe(true);
      expect(
        (await readPersisted(state)).channels?.feishu?.accounts?.default?.legacyWebhook,
      ).toBeDefined();

      finishUpdateRun(second.runId, { status: "succeeded" }, { env: state.env });
      await transformConfigFile({
        base: "source",
        transform: (current) => {
          const nextConfig = structuredClone(current);
          delete nextConfig.channels?.feishu?.accounts?.default?.legacyWebhook;
          return { nextConfig };
        },
      });
      expect((await migrateImplicitWebhookListeners({ env: secondEnv })).changed).toBe(false);
      expect(
        (await readPersisted(state)).channels?.feishu?.accounts?.default?.legacyWebhook,
      ).toBeUndefined();
      const beforeAmbient = await fs.readFile(state.configPath, "utf8");
      const waiting = createUpdateRun({ trigger: "cli" }, { env: state.env });
      await migrateImplicitWebhookListeners({
        env: { ...state.env, OPENCLAW_UPDATE_RUN_ID: waiting.runId },
      });
      finishUpdateRun(waiting.runId, { status: "rolled-back" }, { env: state.env });

      const ambient = createUpdateRun({ trigger: "cli" }, { env: state.env });
      await migrateImplicitWebhookListeners({
        env: { ...ambientEnv, OPENCLAW_UPDATE_RUN_ID: ambient.runId },
      });
      expect((await readPersisted(state)).channels?.msteams?.legacyWebhook).toEqual({ port: 3978 });
      expect(
        (await readPersisted(state)).channels?.feishu?.accounts?.default?.legacyWebhook,
      ).toBeUndefined();

      await fs.writeFile(state.configPath, beforeAmbient);
      finishUpdateRun(ambient.runId, { status: "rolled-back" }, { env: state.env });
      const retried = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const retriedEnv = { ...ambientEnv, OPENCLAW_UPDATE_RUN_ID: retried.runId };
      expect((await migrateImplicitWebhookListeners({ env: retriedEnv })).changed).toBe(true);
      expect((await readPersisted(state)).channels?.msteams?.legacyWebhook).toEqual({ port: 3978 });
      expect(
        (await readPersisted(state)).channels?.feishu?.accounts?.default?.legacyWebhook,
      ).toBeUndefined();

      finishUpdateRun(retried.runId, { status: "succeeded" }, { env: state.env });
      await transformConfigFile({
        base: "source",
        transform: (current) => {
          const nextConfig = structuredClone(current);
          delete nextConfig.channels?.msteams?.legacyWebhook;
          return { nextConfig };
        },
      });
      expect((await migrateImplicitWebhookListeners({ env: retriedEnv })).changed).toBe(false);
      expect((await readPersisted(state)).channels?.msteams?.legacyWebhook).toBeUndefined();
    });
  });

  it("pins the include-owned channel and backs up its original fragment", async () => {
    await withMigrationState("webhook-include", async (state) => {
      const fragmentPath = state.statePath("feishu.json");
      const fragment = `${JSON.stringify(config.channels?.feishu, null, 2)}\n`;
      await fs.writeFile(fragmentPath, fragment);
      await state.writeConfig({ channels: { feishu: { $include: "./feishu.json" } } });
      const original = await fs.readFile(state.configPath, "utf8");
      recordPriorBoot(state);

      expect((await migrateImplicitWebhookListeners({ env: state.env })).changed).toBe(true);

      expect(await fs.readFile(state.configPath, "utf8")).toBe(original);
      expect(
        JSON.parse(await fs.readFile(fragmentPath, "utf8")).accounts.default.legacyWebhook,
      ).toEqual({
        host: "127.0.0.1",
        port: 3000,
      });
      expect(await fs.readFile(`${fragmentPath}.bak`, "utf8")).toBe(fragment);
      expect(readReceipt(state)).toMatchObject({
        state: "prepared",
        pendingChannelIds: ["msteams"],
        ambientTeamsDeferred: true,
      });
    });
  });

  it.each([false, true])(
    "admits read-only startup only when no endpoint pin is required (existing=%s)",
    async (existing) => {
      await withMigrationState("webhook-readonly", async (state) => {
        await state.writeConfig(config);
        const original = await fs.readFile(state.configPath, "utf8");
        if (existing) {
          recordPriorBoot(state);
        }
        const { loadGatewayStartupConfigSnapshot } =
          await import("../../../gateway/server-startup-config-helpers.js");
        await withEnvAsync({ OPENCLAW_CONFIG_READONLY: "1" }, async () => {
          const startup = loadGatewayStartupConfigSnapshot({
            minimalTestGateway: false,
            ambientEnvTriggers: "suppress",
            log: { info: vi.fn(), warn: vi.fn() },
          });
          if (existing) {
            await expect(startup).rejects.toThrow("channels.feishu.accounts.default.legacyWebhook");
            expect(readReceipt(state)).toMatchObject({ state: "prepared", existingInstall: true });
          } else {
            const result = await startup;
            expect(
              result.snapshot.sourceConfig.channels?.feishu?.accounts?.default?.legacyWebhook,
            ).toBeUndefined();
            expect(readReceipt(state)).toMatchObject({
              state: "completed",
              existingInstall: false,
            });
          }
        });
        expect(await fs.readFile(state.configPath, "utf8")).toBe(original);
      });
    },
  );
});
