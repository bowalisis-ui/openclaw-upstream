import type {
  DoctorConfigPreflightOptions,
  DoctorConfigPreflightResult,
} from "./doctor/shared/config-migration-result.js";

export async function withDoctorConfigPreflightWorkerScope(
  options: DoctorConfigPreflightOptions,
  run: (options: DoctorConfigPreflightOptions) => Promise<DoctorConfigPreflightResult>,
): Promise<DoctorConfigPreflightResult> {
  // Reuse child imports for this state operation; every read still acquires fresh admission.
  if (options.migrateState !== false && options.doctorOnlyStateMigrations === true) {
    const { withSqliteReadOnlyWorkerScope } = await import("../infra/sqlite-readonly-worker.js");
    return await withSqliteReadOnlyWorkerScope(async () => {
      const result = await run(options);
      const { migrateImplicitWebhookListeners } =
        await import("./doctor/shared/webhook-listener-migration.js");
      const migration = await migrateImplicitWebhookListeners({ snapshot: result.snapshot });
      if (migration.needsMigration) {
        throw new Error(migration.warnings.join("\n"));
      }
      if (migration.changes.length || migration.warnings.length) {
        const { note } = await import("../../packages/terminal-core/src/note.js");
        if (migration.changes.length) {
          note(migration.changes.join("\n"), "Doctor changes");
        }
        if (migration.warnings.length) {
          note(migration.warnings.join("\n"), "Doctor warnings");
        }
      }
      if (!migration.changed) {
        return result;
      }
      const { readConfigFileSnapshotWithPluginMetadata } = await import("../config/io.js");
      const refreshed = await readConfigFileSnapshotWithPluginMetadata({
        observe: false,
        allowCurrentPluginMetadata: false,
        deferredPluginMigrations: result.deferredPluginMigrations,
      });
      return {
        ...result,
        snapshot: refreshed.snapshot,
        baseConfig: refreshed.snapshot.sourceConfig,
        pluginMetadataSnapshot: refreshed.pluginMetadataSnapshot,
      };
    });
  }
  return await run(options);
}
