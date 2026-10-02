import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PluginDoctorStateRowImport } from "../plugin-state/plugin-state-doctor-import.js";
import type { PluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import { type PluginDoctorStateMigrationContext } from "../plugins/doctor-contract-module.js";
import * as doctorRegistry from "../plugins/doctor-contract-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import * as snapshots from "./sqlite-snapshot.js";
import { createPluginDoctorStateMigrationContext } from "./state-migrations.plugin-doctor-context.js";
import {
  runPluginDoctorStateMigrationPlans,
  runPostSessionPluginDoctorStateRepairs,
} from "./state-migrations.plugin-doctor.js";

const authority = { assertCurrent() {}, assertOwnedInTransaction() {} };

function createOwnerContext(env: NodeJS.ProcessEnv, repairAuthority = authority) {
  return createPluginDoctorStateMigrationContext({
    pluginId: "example",
    migrationId: "row-import",
    env,
    config: {},
    trustedForDurableStores: true,
    repairAuthority,
  });
}

async function seedImport(env: NodeJS.ProcessEnv) {
  const owner = createOwnerContext(env);
  const source = owner.openPluginStateKeyedStore({ namespace: "old", maxEntries: 10 });
  await source.register("source", { text: "preserved" });
  const observed = owner.readPluginStateEntriesInKeyRange?.("old", {
    prefix: "source",
    limit: 1,
  })[0];
  if (!observed) {
    throw new Error("Missing source fixture");
  }
  const plan = {
    source: { namespace: "old", ...observed },
    checks: [],
    target: {
      namespace: "canonical",
      maxEntries: 10,
      key: "imported",
      value: { text: "preserved", normalized: true },
      createdAt: observed.createdAt,
      expiresAt: null,
    },
  } satisfies PluginDoctorStateRowImport;
  return { owner, source, plan };
}

describe("Doctor plugin row imports", () => {
  it("backs up and receipts a source without creating or resurrecting a canonical row", async () => {
    await withOpenClawTestState(
      { label: "plugin-source-receipt", applyEnv: false },
      async ({ env }) => {
        const { owner, source, plan } = await seedImport(env);
        const before = await source.entries();
        const result = await owner.importPluginStateRows?.([{ ...plan, target: null }]);
        expect(result).toMatchObject({ imported: 0, backupPath: expect.any(String) });
        await expect(owner.inspectImportedPluginStateSources?.([plan.source])).resolves.toEqual([
          { namespace: "old", key: "source" },
        ]);
        await expect(owner.importPluginStateRows?.([plan])).resolves.toEqual({
          imported: 0,
          skipped: 1,
        });
        expect(await source.entries()).toEqual(before);
        await expect(
          owner
            .openPluginStateKeyedStore({ namespace: "canonical", maxEntries: 10 })
            .lookup("imported"),
        ).resolves.toBeUndefined();
      },
    );
  });

  it("refuses differing targets shared by distinct source rows before backup", async () => {
    await withOpenClawTestState(
      { label: "plugin-row-conflicting-targets", applyEnv: false },
      async ({ env }) => {
        const { owner, source, plan } = await seedImport(env);
        await source.register("another", { text: "another source" });
        const observed = owner.readPluginStateEntriesInKeyRange?.("old", {
          prefix: "another",
          limit: 1,
        })[0];
        if (!observed) throw new Error("Missing second source fixture");
        const conflicting = {
          ...plan,
          source: { namespace: "old", ...observed },
          target: { ...plan.target, value: { text: "different target" } },
        };
        await expect(owner.importPluginStateRows?.([plan, conflicting])).rejects.toThrow(
          "identical shared targets",
        );
        await expect(
          owner.openPluginStateKeyedStore({ namespace: "canonical", maxEntries: 10 }).entries(),
        ).resolves.toEqual([]);
        await expect(
          owner.inspectImportedPluginStateSources?.([plan.source, conflicting.source]),
        ).resolves.toEqual([]);
      },
    );
  });

  it.each([undefined, "after-session-repair"] as const)(
    "keeps %s detection read-only",
    async (phase) => {
      await withOpenClawTestState(
        { label: "plugin-detection-read-only", applyEnv: false },
        async ({ env, stateDir }) => {
          const { source } = await seedImport(env);
          const before = await source.entries();
          const registry = vi
            .spyOn(doctorRegistry, "listPluginDoctorStateMigrationEntries")
            .mockReturnValue([
              {
                pluginId: "example",
                channelIds: [],
                trustedForDurableStores: true,
                migration: {
                  id: "detection-read-only",
                  label: "Read-only detection",
                  phase,
                  async detectLegacyState({ context }) {
                    const store = context.openPluginStateKeyedStore({
                      namespace: "old",
                      maxEntries: 10,
                    });
                    await expect(store.entries()).resolves.toEqual(before);
                    await expect(store.register("source", "unauthorized")).rejects.toThrow(
                      "active migration callback",
                    );
                    await expect(store.consume("source")).rejects.toThrow(
                      "active migration callback",
                    );
                    expect(() =>
                      context.importPluginStateEntries?.({ namespace: "old", maxEntries: 10 }, [
                        { key: "source", value: "unauthorized", createdAt: 1 },
                      ]),
                    ).toThrow("active migration callback");
                    expect(context.repairCronJobs).toBeUndefined();
                    expect(context.updateAcpSessionIdentity).toBeUndefined();
                    return null;
                  },
                  migrateLegacyState: vi.fn(() => ({ changes: [], warnings: [] })),
                },
              },
            ]);
          try {
            const result = phase
              ? await runPostSessionPluginDoctorStateRepairs({
                  config: {},
                  env,
                  maintenanceAuthority: authority,
                })
              : await runPluginDoctorStateMigrationPlans({
                  detected: { stateDir, oauthDir: path.join(stateDir, "credentials") },
                  config: {},
                  env,
                });
            expect(result.warnings).toEqual([]);
            expect(result.changes).toEqual([]);
            expect(await source.entries()).toEqual(before);
          } finally {
            registry.mockRestore();
          }
        },
      );
    },
  );

  it.each([undefined, "after-session-repair"] as const)(
    "expires %s import handles before the next migration callback",
    async (phase) => {
      await withOpenClawTestState(
        { label: "plugin-row-normal-phase", applyEnv: false },
        async ({ env, stateDir }) => {
          const { owner, plan } = await seedImport(env);
          let retained: PluginDoctorStateMigrationContext["importPluginStateRows"];
          let retainedContext: PluginDoctorStateMigrationContext | undefined;
          let consumerBound: PluginStateKeyedStore<unknown, 2>;
          let retainedStore: ReturnType<
            PluginDoctorStateMigrationContext["openPluginStateKeyedStore"]
          >;
          const registry = vi
            .spyOn(doctorRegistry, "listPluginDoctorStateMigrationEntries")
            .mockReturnValue([
              {
                pluginId: "example",
                channelIds: [],
                trustedForDurableStores: true,
                migration: {
                  id: "row-import",
                  label: "Example row import",
                  phase,
                  detectLegacyState: async () => ({ preview: ["pending"] }),
                  async migrateLegacyState({ context }) {
                    if (!phase) {
                      expect(context.updateAcpSessionIdentity).toBeUndefined();
                      expect(context.deletePluginStateEntriesIfUnchanged).toBeUndefined();
                    }
                    retainedContext = context;
                    retainedStore = context.openPluginStateKeyedStore({
                      namespace: "retained",
                      maxEntries: 10,
                    });
                    if (!retainedStore.withCurrent) {
                      throw new Error("Missing composable migration authority");
                    }
                    let consumerActive = true;
                    consumerBound = retainedStore.withCurrent({
                      assertCurrent() {
                        if (!consumerActive) {
                          throw new Error("consumer authority expired");
                        }
                      },
                    });
                    const observed = await consumerBound.observe("composed");
                    await expect(
                      consumerBound.compareAndApply("composed", observed.comparison, {
                        operation: "update",
                        action: "set",
                        value: "authorized",
                      }),
                    ).resolves.toEqual({ status: "applied" });
                    consumerActive = false;
                    await expect(
                      consumerBound.register("composed", "unauthorized"),
                    ).rejects.toThrow("consumer authority expired");
                    consumerActive = true;
                    retained = context.importPluginStateRows;
                    if (!retained) {
                      throw new Error("Missing normal-phase row import capability");
                    }
                    const result = await retained([plan]);
                    return { changes: [`Imported ${result.imported}`], warnings: [] };
                  },
                },
              },
              {
                pluginId: "example",
                channelIds: [],
                trustedForDurableStores: true,
                migration: {
                  id: "later-migration",
                  label: "Later migration",
                  phase,
                  detectLegacyState: async () => ({ preview: ["pending"] }),
                  async migrateLegacyState() {
                    await expect(retained?.([plan])).rejects.toThrow("expired");
                    await expect(
                      owner
                        .openPluginStateKeyedStore({ namespace: "retained", maxEntries: 10 })
                        .lookup("composed"),
                    ).resolves.toBe("authorized");
                    await expect(consumerBound.register("composed", "late")).rejects.toThrow(
                      "expired",
                    );
                    await expect(retainedStore.register("late", { value: "late" })).rejects.toThrow(
                      "expired",
                    );
                    expect(() =>
                      retainedContext?.openPluginStateKeyedStore({
                        namespace: "late",
                        maxEntries: 10,
                      }),
                    ).toThrow("expired");
                    expect(() =>
                      retainedContext?.importPluginStateEntries?.(
                        { namespace: "late", maxEntries: 10 },
                        [{ key: "late", value: "late", createdAt: 1 }],
                      ),
                    ).toThrow("expired");
                    if (phase) {
                      expect(() =>
                        retainedContext?.deletePluginStateEntriesIfUnchanged?.("old", []),
                      ).toThrow("expired");
                    }
                    return { changes: ["Checked expired callback"], warnings: [] };
                  },
                },
              },
            ]);
          try {
            const result = phase
              ? await runPostSessionPluginDoctorStateRepairs({
                  config: {},
                  env,
                  maintenanceAuthority: authority,
                })
              : await runPluginDoctorStateMigrationPlans({
                  detected: { stateDir, oauthDir: path.join(stateDir, "credentials") },
                  config: {},
                  env,
                });
            expect(result.warnings).toEqual([]);
            expect(result.changes).toEqual(["Imported 1", "Checked expired callback"]);
            await expect(retained?.([plan])).rejects.toThrow("expired");
            await expect(
              owner
                .openPluginStateKeyedStore({ namespace: "canonical", maxEntries: 10 })
                .lookup("imported"),
            ).resolves.toEqual(plan.target.value);
          } finally {
            registry.mockRestore();
          }
        },
      );
    },
  );

  it("backs up exact source rows and keeps receipts after consumption", async () => {
    await withOpenClawTestState(
      { label: "plugin-row-receipts", applyEnv: false },
      async ({ env }) => {
        const { owner, plan } = await seedImport(env);
        const result = await owner.importPluginStateRows?.([plan]);
        expect(result).toMatchObject({ imported: 1, skipped: 0, backupPath: expect.any(String) });
        if (!result?.backupPath) {
          throw new Error("Missing import backup");
        }
        const backup = openNodeSqliteDatabase(result.backupPath, { readOnly: true });
        try {
          expect(
            backup
              .prepare("SELECT value_json FROM plugin_state_entries WHERE namespace = 'old'")
              .get(),
          ).toEqual({ value_json: plan.source.valueJson });
          expect(
            backup
              .prepare(
                "SELECT count(*) AS count FROM plugin_state_entries WHERE namespace = 'canonical'",
              )
              .get(),
          ).toEqual({ count: 0 });
        } finally {
          backup.close();
        }
        const target = owner.openPluginStateKeyedStore({ namespace: "canonical", maxEntries: 10 });
        await expect(target.consume("imported")).resolves.toEqual(plan.target.value);
        await expect(owner.importPluginStateRows?.([plan])).resolves.toEqual({
          imported: 0,
          skipped: 1,
        });
        await expect(target.lookup("imported")).resolves.toBeUndefined();
        await expect(owner.inspectImportedPluginStateSources?.([plan.source])).resolves.toEqual([
          { namespace: "old", key: "source" },
        ]);
      },
    );
  });

  it.each(["source", "authority", "target", "commit-authority"] as const)(
    "refuses changed %s after backup without committing a row or receipt",
    async (changed) => {
      await withOpenClawTestState(
        { label: `plugin-row-${changed}`, applyEnv: false },
        async ({ env }) => {
          const { source, plan } = await seedImport(env);
          let active = true;
          let commits = 0;
          const owner = createOwnerContext(env, {
            assertCurrent() {
              if (!active) {
                throw new Error("repair owner expired");
              }
            },
            assertOwnedInTransaction() {
              if (!active || (changed === "commit-authority" && ++commits === 3)) {
                throw new Error("repair owner expired");
              }
            },
          });
          const target = owner.openPluginStateKeyedStore({
            namespace: "canonical",
            maxEntries: 10,
          });
          const snapshot = snapshots.createVerifiedSqliteSnapshot;
          const observer = vi
            .spyOn(snapshots, "createVerifiedSqliteSnapshot")
            .mockImplementation(async (options) => {
              const saved = await snapshot(options);
              if (changed === "source") {
                await source.register("source", { text: "new generation" });
              } else if (changed === "target") {
                await target.register("imported", { text: "canonical wins" });
              } else if (changed === "authority") {
                active = false;
              }
              return saved;
            });
          try {
            await expect(owner.importPluginStateRows?.([plan])).rejects.toThrow(
              changed === "source"
                ? "state changed"
                : changed === "target"
                  ? "target differs"
                  : "owner expired",
            );
          } finally {
            observer.mockRestore();
          }
          const reader = createOwnerContext(env).openPluginStateKeyedStore({
            namespace: "canonical",
            maxEntries: 10,
          });
          await expect(reader.lookup("imported")).resolves.toEqual(
            changed === "target" ? { text: "canonical wins" } : undefined,
          );
          await expect(
            createOwnerContext(env).inspectImportedPluginStateSources?.([plan.source]),
          ).resolves.toEqual([]);
        },
      );
    },
  );
});
