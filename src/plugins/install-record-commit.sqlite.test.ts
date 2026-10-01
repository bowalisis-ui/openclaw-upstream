import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateImplicitWebhookListeners } from "../commands/doctor/shared/webhook-listener-migration.js";
import {
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
  type OpenClawConfig,
} from "../config/config.js";
import { transformConfigFile } from "../config/mutate.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { withSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolvePluginArtifactDeclaredSurface } from "./capability-artifact.js";
import { resolvePluginCapabilityConsent } from "./capability-consent.js";
import { computeDeclaredSurfaceHash } from "./capability-summary.js";
import { enablePluginWithCapabilityConsent } from "./enable.js";
import { persistPluginInstall } from "./install-persistence.js";
import {
  commitConfigWithPendingPluginInstalls,
  commitConfigWriteWithPendingPluginInstalls,
} from "./install-record-commit.js";
import { writePersistedInstalledPluginIndexInstallRecordsWithLease } from "./installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index.js";
import type { PluginLifecycleRuntimeApply } from "./lifecycle.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
});

function runChild(scriptPath: string, args: string[]) {
  const child = spawn(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  expectDefined(child.stdout, "piped child stdout").on("data", (chunk) => (output += chunk));
  expectDefined(child.stderr, "piped child stderr").on("data", (chunk) => (output += chunk));
  const ready = new Promise<void>((resolve, reject) => {
    child.on("message", (message) => {
      if (message === "ready") {
        resolve();
      }
    });
    child.on("error", reject);
    child.on("close", () => {
      reject(new Error(`install-record commit child exited before ready: ${output}`));
    });
  });
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`install-record commit child exited ${code}: ${output}`));
      }
    });
  });
  return { ready, done };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function waitForFile(filePath: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fileExists(filePath)) {
      return;
    }
    await delay(10);
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function expectFileToStayAbsent(filePath: string, durationMs = 500): Promise<void> {
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    expect(await fileExists(filePath)).toBe(false);
    await delay(10);
  }
}

describe("plugin install record commit rollback", () => {
  it.each([
    { pendingRecords: false, legacy: false },
    { pendingRecords: true, legacy: false },
    { pendingRecords: true, legacy: true },
  ])(
    "preserves consent at config commit (pending: $pendingRecords, legacy: $legacy)",
    async ({ pendingRecords, legacy }) => {
      await withOpenClawTestState({ label: "plugin-consent-commit" }, async (state) => {
        const pluginId = "consent-commit";
        const installPath = state.statePath("extensions", pluginId);
        await fs.promises.mkdir(installPath, { recursive: true });
        await fs.promises.writeFile(
          path.join(installPath, "package.json"),
          JSON.stringify({
            name: "@example/consent-commit",
            openclaw: { extensions: ["./index.cjs"] },
          }),
        );
        await fs.promises.writeFile(path.join(installPath, "index.cjs"), "module.exports = {};");
        const manifestPath = path.join(installPath, "openclaw.plugin.json");
        const manifest = {
          id: pluginId,
          configSchema: { type: "object" },
          contracts: { tools: ["read"] },
        };
        await fs.promises.writeFile(manifestPath, JSON.stringify(manifest));
        const config = { plugins: { entries: { [pluginId]: { enabled: legacy } } } };
        await state.writeConfig(config);
        await withEnvAsync(state.env, async () => {
          const acceptedSurface = resolvePluginArtifactDeclaredSurface(installPath);
          const oldRecord = {
            source: "path" as const,
            installPath,
            ...(legacy
              ? {}
              : {
                  acceptedSurface,
                  acceptedSurfaceHash: computeDeclaredSurfaceHash(acceptedSurface),
                }),
          };
          await withPluginLifecycleLease({}, async (lease) => {
            await writePersistedInstalledPluginIndexInstallRecordsWithLease(
              { [pluginId]: oldRecord },
              { config, lease },
            );
          });
          const enabled = await enablePluginWithCapabilityConsent(config, pluginId);
          expect(enabled.enabled).toBe(true);
          if (legacy) {
            let commits = 0;
            await commitConfigWriteWithPendingPluginInstalls({
              nextConfig: {
                plugins: {
                  ...config.plugins,
                  installs: {
                    [pluginId]: { ...oldRecord, installedAt: "2026-08-26T00:00:00.000Z" },
                  },
                },
              },
              commit: async (nextConfig) => {
                commits += 1;
                return await replaceConfigFile({ sourceConfig: nextConfig });
              },
            });
            expect(commits).toBe(1);
            return;
          }
          await withPluginLifecycleLease({}, async (lease) => {
            await fs.promises.writeFile(
              manifestPath,
              JSON.stringify({ ...manifest, contracts: { tools: ["read", "write"] } }),
            );
            await writePersistedInstalledPluginIndexInstallRecordsWithLease(
              { [pluginId]: { source: "path", installPath } },
              { config, lease },
            );
          });
          let commits = 0;
          const commit = async (nextConfig: OpenClawConfig) => {
            commits += 1;
            return await replaceConfigFile({ sourceConfig: nextConfig });
          };
          await expect(
            commitConfigWriteWithPendingPluginInstalls({
              nextConfig: pendingRecords
                ? {
                    ...enabled.config,
                    plugins: { ...enabled.config.plugins, installs: { [pluginId]: oldRecord } },
                  }
                : enabled.config,
              commit,
            }),
          ).rejects.toMatchObject({ capabilityConsent: { pluginId } });
          expect(commits).toBe(0);
          expect(
            (await readPersistedInstalledPluginIndex({ env: state.env }))?.installRecords[pluginId]
              ?.acceptedSurface,
          ).toBeUndefined();
          await resolvePluginCapabilityConsent({
            config,
            pluginId,
            acknowledge: {
              reviewToken: computeDeclaredSurfaceHash(
                resolvePluginArtifactDeclaredSurface(installPath),
              ),
            },
          });
          await commitConfigWriteWithPendingPluginInstalls({ nextConfig: enabled.config, commit });
          expect(commits).toBe(1);
        });
      });
    },
  );

  it("serializes two failing direct config commits and restores the original index", async () => {
    await withOpenClawTestState({ label: "plugin-record-failing-commits" }, async (state) => {
      const commitModuleUrl = pathToFileURL(
        path.resolve("src/plugins/install-record-commit.ts"),
      ).href;
      const childScript = await state.writeText(
        "fail-config-commit.mts",
        `
          import fs from "node:fs";
          import { setTimeout as delay } from "node:timers/promises";
          import { commitConfigWriteWithPendingPluginInstalls } from ${JSON.stringify(commitModuleUrl)};
          const [stateDir, pluginId, enteredPath, releasePath] = process.argv.slice(2);
          process.env.OPENCLAW_STATE_DIR = stateDir;
          process.send?.("ready");
          process.disconnect?.();
          try {
            await commitConfigWriteWithPendingPluginInstalls({
              nextConfig: {
                plugins: {
                  installs: {
                    [pluginId]: {
                      source: "path",
                      spec: pluginId,
                      sourcePath: "/tmp/" + pluginId,
                      installPath: "/tmp/" + pluginId,
                    },
                  },
                },
              },
              commit: async () => {
                await fs.promises.writeFile(enteredPath, "entered");
                while (true) {
                  try {
                    await fs.promises.access(releasePath);
                    break;
                  } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                      throw error;
                    }
                  }
                  await delay(10);
                }
                throw new Error("config failed " + pluginId);
              },
            });
            throw new Error("config commit unexpectedly succeeded");
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "config failed " + pluginId) {
              throw error;
            }
          }
        `,
      );
      const firstEntered = path.join(state.stateDir, "first-entered");
      const firstRelease = path.join(state.stateDir, "first-release");
      const secondEntered = path.join(state.stateDir, "second-entered");
      const secondRelease = path.join(state.stateDir, "second-release");

      await withEnvAsync(state.env, async () => {
        await withPluginLifecycleLease({}, async (lease) => {
          await writePersistedInstalledPluginIndexInstallRecordsWithLease(
            {
              original: {
                source: "path",
                spec: "original",
                sourcePath: "/tmp/original",
                installPath: "/tmp/original",
              },
            },
            { config: {}, lease },
          );
        });

        const first = runChild(childScript, [state.stateDir, "first", firstEntered, firstRelease]);
        const firstDone = first.done;
        let secondDone: Promise<void> | undefined;
        try {
          // Bootstrap readiness is outside lock assertions; slow TS imports are not blocked writers.
          await first.ready;
          await waitForFile(firstEntered);
          const second = runChild(childScript, [
            state.stateDir,
            "second",
            secondEntered,
            secondRelease,
          ]);
          secondDone = second.done;
          await second.ready;

          // The second writer must stay outside its config commit until the
          // first writer rolls its tentative index state back.
          await expectFileToStayAbsent(secondEntered);

          await fs.promises.writeFile(firstRelease, "release");
          await firstDone;
          await waitForFile(secondEntered);
          await fs.promises.writeFile(secondRelease, "release");
          await secondDone;
        } finally {
          await Promise.all([
            fs.promises.writeFile(firstRelease, "release"),
            fs.promises.writeFile(secondRelease, "release"),
          ]);
          await Promise.allSettled([firstDone, ...(secondDone ? [secondDone] : [])]);
        }
      });

      const persisted = await readPersistedInstalledPluginIndex({ env: state.env });
      expect(persisted?.installRecords).toEqual({
        original: {
          source: "path",
          spec: "original",
          sourcePath: "/tmp/original",
          installPath: "/tmp/original",
        },
      });
      expect(persisted?.policyHash).toBe(resolveInstalledPluginIndexPolicyHash({}));
    });
  });
});

describe("committed plugin configuration", () => {
  it.each([
    {
      mode: "install",
      name: "publishes a pending webhook pin before runtime activation and never recreates a removed pin",
    },
    {
      mode: "unchanged-cli",
      name: "publishes a late webhook pin for an unchanged CLI update and never recreates a removed pin",
    },
  ] as const)("$name", async ({ mode }) => {
    await withOpenClawTestState({ label: "plugin-webhook-publication" }, async (state) =>
      withSqliteReadOnlyWorkerScope(async () => {
        const pluginId = "msteams";
        const oldPath = state.statePath("npm", "old-teams");
        const newPath = state.statePath("npm", "new-teams");
        for (const [rootDir, implicit] of [
          [oldPath, false],
          [newPath, true],
        ] as const) {
          await fs.promises.mkdir(rootDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(rootDir, "package.json"),
            JSON.stringify({
              name: "@openclaw/msteams",
              version: implicit ? "2026.9.8" : "2026.9.7",
              type: "module",
              openclaw: { extensions: ["./index.js"] },
            }),
          );
          await fs.promises.writeFile(
            path.join(rootDir, "index.js"),
            'export default { id: "msteams", register() {} };\n',
          );
          await fs.promises.writeFile(
            path.join(rootDir, "openclaw.plugin.json"),
            JSON.stringify({
              id: pluginId,
              channels: [pluginId],
              configSchema: { type: "object", properties: {}, additionalProperties: false },
              doctorContract: { configRepair: true },
            }),
          );
          await fs.promises.writeFile(
            path.join(rootDir, "doctor-contract-api.ts"),
            `import { createLegacyWebhookListenerDoctorContract } from "openclaw/plugin-sdk/runtime-doctor-migrations";
export const { legacyConfigRules, normalizeCompatibilityConfig } = createLegacyWebhookListenerDoctorContract({
  channelKey: "msteams", defaultPort: 3978, webhookKey: "webhook", portKey: "port", hostKey: null,
  ${implicit ? "implicitAccountIds: () => [undefined]," : ""}
});\n`,
          );
        }
        const config: OpenClawConfig = {
          plugins: { allow: [pluginId], entries: { [pluginId]: { enabled: true } } },
          channels: { msteams: { enabled: true } },
        };
        await state.writeConfig(config);
        const original = await fs.promises.readFile(state.configPath, "utf8");
        await withPluginLifecycleLease({}, (lease) =>
          writePersistedInstalledPluginIndexInstallRecordsWithLease(
            {
              [pluginId]: {
                source: "npm",
                spec: "@openclaw/msteams@2026.9.7",
                version: "2026.9.7",
                installPath: oldPath,
              },
            },
            { config, lease },
          ),
        );
        runOpenClawStateWriteTransaction(
          ({ db }) =>
            executeSqliteQuerySync(
              db,
              getNodeSqliteKysely<DB>(db)
                .insertInto("gateway_boot_lifecycle")
                .values({
                  boot_id: randomUUID(),
                  pid: process.pid + 1,
                  started_at_ms: Date.now() - 60_000,
                  completed_at_ms: Date.now() - 30_000,
                  outcome: "clean_stop",
                  reason: null,
                  startup_reason: null,
                }),
            ),
          { env: state.env },
        );
        expect((await migrateImplicitWebhookListeners({ env: state.env })).changed).toBe(false);
        const nextInstall = {
          source: "npm" as const,
          spec: "@openclaw/msteams@2026.9.8",
          version: "2026.9.8",
          installPath: newPath,
        };
        let activations = 0;
        let expectedPin: { port: number } | undefined = { port: 3978 };
        const applyRuntime: PluginLifecycleRuntimeApply = async ({
          config: runtimeConfig,
          write,
        }) => {
          expect(runtimeConfig.channels?.msteams?.legacyWebhook).toEqual(expectedPin);
          expect(write?.persistedSourceConfig?.channels?.msteams?.legacyWebhook).toEqual(
            expectedPin,
          );
          const persisted = JSON.parse(await fs.promises.readFile(state.configPath, "utf8"));
          expect(persisted.channels.msteams.legacyWebhook).toEqual(expectedPin);
          activations += 1;
          return {
            operationId: "webhook-publication",
            generation: activations,
            pluginIds: [pluginId],
          };
        };
        const install = async (beforePersistentEffect?: () => void) => {
          const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
          return await persistPluginInstall({
            snapshot: { config: snapshot.sourceConfig, baseHash: snapshot.hash, writeOptions },
            pluginId,
            install: nextInstall,
            enable: false,
            applyRuntime,
            beforePersistentEffect,
          });
        };
        let publish: () => Promise<unknown> = install;
        const gatewayCall = vi.fn();
        if (mode === "install") {
          const failure = new Error("synthetic pre-publication refusal");
          await expect(
            install(() => {
              throw failure;
            }),
          ).rejects.toBe(failure);
          expect(activations).toBe(0);
          expect(await fs.promises.readFile(state.configPath, "utf8")).toBe(original);
          expect(
            (await readPersistedInstalledPluginIndex())?.installRecords[pluginId]?.installPath,
          ).toBe(oldPath);
        } else {
          await withPluginLifecycleLease({}, (lease) =>
            writePersistedInstalledPluginIndexInstallRecordsWithLease(
              { [pluginId]: nextInstall },
              { config, lease },
            ),
          );
          const updates = await import("./update.js");
          vi.spyOn(updates, "updateNpmInstalledPlugins").mockImplementation(
            async ({ config: current }) => ({
              config: current,
              changed: false,
              outcomes: [{ pluginId, status: "unchanged", message: "Teams package is current." }],
            }),
          );
          gatewayCall.mockImplementation(async (method: string) => {
            if (method === "plugins.list") {
              return {};
            }
            expect(method).toBe("plugins.refresh");
            const persisted = JSON.parse(await fs.promises.readFile(state.configPath, "utf8"));
            expect(persisted.channels.msteams.legacyWebhook).toEqual({ port: 3978 });
            expect(await fs.promises.readFile(`${state.configPath}.bak`, "utf8")).toBe(original);
            activations += 1;
            return { runtime: { generation: activations } };
          });
          const lifecycle = await import("../cli/plugins-lifecycle-client.js");
          vi.spyOn(lifecycle, "resolvePluginLifecycleGateway").mockResolvedValue(gatewayCall);
          const { runPluginUpdateCommand } = await import("../cli/plugins-update-command.js");
          publish = () => runPluginUpdateCommand({ ids: [pluginId], opts: {} });
        }
        await publish();
        expect(activations).toBe(1);
        expect(await fs.promises.readFile(`${state.configPath}.bak`, "utf8")).toBe(original);
        await transformConfigFile({
          base: "source",
          transform: (current) => {
            const nextConfig = structuredClone(current);
            delete nextConfig.channels?.msteams?.legacyWebhook;
            return { nextConfig };
          },
        });
        expectedPin = undefined;
        await publish();
        expect(activations).toBe(mode === "install" ? 2 : 1);
        expect(
          JSON.parse(await fs.promises.readFile(state.configPath, "utf8")).channels.msteams
            .legacyWebhook,
        ).toBeUndefined();
        if (mode === "unchanged-cli") {
          expect(gatewayCall.mock.calls.map(([method]) => method)).toEqual([
            "plugins.list",
            "plugins.refresh",
            "plugins.list",
          ]);
        }
      }),
    );
  });

  it.each([false, true])(
    "returns committed source separately from authored configuration (pending records: %s)",
    async (pending) => {
      await withOpenClawTestState({ label: "committed-plugin-config" }, async (state) => {
        await state.writeConfig({ gateway: { mode: "local" } });
        const nextConfig: OpenClawConfig = {
          gateway: { mode: "local" },
          ...(pending
            ? {
                plugins: {
                  installs: { fixture: { source: "npm" as const, spec: "fixture@1.0.0" } },
                },
              }
            : {}),
        };

        const result = await commitConfigWithPendingPluginInstalls({ nextConfig });
        const persisted = JSON.parse(await fs.promises.readFile(state.configPath, "utf8"));

        const { meta: _meta, ...authoredConfig } = persisted;
        expect(authoredConfig).toEqual({ gateway: { mode: "local" } });
        // The committed source resolves the implicit roster without writing it into authored JSON.
        const resolvedSource = { ...persisted, agents: { entries: { main: {} } } };
        expect(result.path).toBe(state.configPath);
        expect(result.nextConfig).toEqual(resolvedSource);
        expect(result.persistedSourceConfig).toEqual(resolvedSource);
        expect(result.nextConfig.meta?.lastTouchedVersion).toEqual(expect.any(String));
        expect(result.movedInstallRecords).toBe(pending);
        expect(result.nextConfig.plugins?.installs).toBeUndefined();
      });
    },
  );
});
