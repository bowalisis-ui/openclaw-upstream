import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { formatCliCommand } from "../cli/command-format.js";
import { sha256Hex } from "./crypto-digest.js";
import {
  MigrationArtifactSchema,
  type MigrationArtifactIdentity,
} from "./session-sqlite-migration-artifact.js";

export const DeferredPluginSessionImportSchema = z.object({
  databaseIdentity: z.string(),
  pluginIds: z.array(z.string()),
  sources: z.array(
    z.object({ path: z.string(), identity: MigrationArtifactSchema.shape.identity }),
  ),
});
export type DeferredPluginSessionImport = z.infer<typeof DeferredPluginSessionImportSchema>;

/** Old receipts bind bytes, not row identities; only a proven original JSON value can rebind. */
export function preservesRecordedIndexValue(
  bytes: Buffer,
  identity: MigrationArtifactIdentity,
): boolean {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  const pretty = JSON.stringify(value, null, 2);
  const candidates = [
    bytes.subarray(0, identity.size),
    bytes.subarray(-identity.size),
    ...[JSON.stringify(value), pretty, pretty.replaceAll("\n", "\r\n")].flatMap((encoded) =>
      ["", "\n", "\r\n"].map((ending) => Buffer.from(encoded + ending)),
    ),
  ];
  return candidates.some(
    (original) =>
      original.length === identity.size &&
      sha256Hex(original) === identity.sha256 &&
      isDeepStrictEqual(JSON.parse(original.toString("utf8")), value),
  );
}

export function databaseIdentity(sqlitePath: string): string {
  const file = fs.lstatSync(sqlitePath, { bigint: true, throwIfNoEntry: false });
  if (!file?.isFile()) {
    throw new Error(
      `The imported session database is missing or no longer a regular file: ${sqlitePath}. Run ${formatCliCommand("openclaw doctor --session-sqlite recover --session-sqlite-all-agents")} against the same state/config before retrying repair.`,
    );
  }
  return `${file.dev}:${file.ino}`;
}

export function sameSourceContent(
  left: MigrationArtifactIdentity,
  right: MigrationArtifactIdentity,
) {
  return left.sha256 === right.sha256 && left.size === right.size;
}
