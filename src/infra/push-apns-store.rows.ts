import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { Insertable, Selectable } from "kysely";
import { z } from "zod";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import type { ApnsEnvironment, ApnsRegistration } from "./push-apns-store.types.js";
import {
  normalizeApnsRelayBaseUrl,
  normalizePersistedApnsRelayBaseUrl,
} from "./push-apns.relay.js";

type ApnsRegistrationInsert = Insertable<OpenClawStateKyselyDatabase["apns_registrations"]>;

export function apnsRegistrationToRow(registration: ApnsRegistration): ApnsRegistrationInsert {
  const base = {
    node_id: registration.nodeId,
    transport: registration.transport,
    topic: registration.topic,
    environment: registration.environment,
    updated_at_ms: registration.updatedAtMs,
  };
  if (registration.transport === "direct") {
    const { token } = registration;
    return {
      ...base,
      token,
      relay_handle: null,
      send_grant: null,
      installation_id: null,
      relay_origin: null,
      distribution: null,
      token_debug_suffix: null,
    };
  }
  return {
    ...base,
    token: null,
    relay_handle: registration.relayHandle,
    send_grant: registration.sendGrant,
    installation_id: registration.installationId,
    relay_origin: registration.relayOrigin ?? null,
    distribution: registration.distribution,
    token_debug_suffix: registration.tokenDebugSuffix ?? null,
  };
}

type ApnsRegistrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "apns_registrations" | "apns_registration_tombstones"
>;
type ApnsRegistrationRow = Selectable<ApnsRegistrationDatabase["apns_registrations"]>;

const MAX_NODE_ID_LENGTH = 256;
const MAX_TOPIC_LENGTH = 255;
const MAX_APNS_TOKEN_HEX_LENGTH = 512;
const MAX_RELAY_IDENTIFIER_LENGTH = 256;
export const MAX_SEND_GRANT_LENGTH = 1024;
const APNS_REGISTRATION_LOOKUP_CHUNK_SIZE = 500;

export function normalizeApnsNodeId(value: string): string {
  return value.trim();
}

export function isValidApnsNodeId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_NODE_ID_LENGTH;
}

export function normalizeApnsToken(value: string): string {
  return normalizeLowercaseStringOrEmpty(value.trim().replace(/[<>\s]/g, ""));
}

export function validateRelayIdentifier(
  value: string,
  fieldName: string,
  maxLength: number = MAX_RELAY_IDENTIFIER_LENGTH,
): string {
  if (!value) {
    throw new Error(`${fieldName} required`);
  }
  if (value.length > maxLength) {
    throw new Error(`${fieldName} too long`);
  }
  if (/[^\x21-\x7e]/.test(value)) {
    throw new Error(`${fieldName} invalid`);
  }
  return value;
}

function isValidRelayIdentifier(
  value: string,
  maxLength: number = MAX_RELAY_IDENTIFIER_LENGTH,
): boolean {
  return value.length > 0 && value.length <= maxLength && !/[^\x21-\x7e]/.test(value);
}

export function normalizeApnsTopic(value: string): string {
  return value.trim();
}

export function isValidApnsTopic(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TOPIC_LENGTH;
}

export function normalizeTokenDebugSuffix(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeLowercaseStringOrEmpty(value.trim()).replace(/[^0-9a-z]/g, "");
  return normalized.length > 0 ? normalized.slice(-8) : undefined;
}

export function isLikelyApnsToken(value: string): boolean {
  return value.length <= MAX_APNS_TOKEN_HEX_LENGTH && /^[0-9a-f]{32,}$/i.test(value);
}

export function normalizeDistribution(value: unknown): "official" | null {
  return normalizeLowercaseStringOrEmpty(value) === "official" ? "official" : null;
}

export function normalizeRelayOrigin(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const normalized = normalizeApnsRelayBaseUrl(trimmed, env);
  return normalized.ok ? normalized.value : undefined;
}

function normalizePersistedRelayOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const normalized = normalizePersistedApnsRelayBaseUrl(trimmed);
  return normalized.ok ? normalized.value : undefined;
}

/** Normalizes the APNs environment string accepted by registration inputs. */
export function normalizeApnsEnvironment(value: unknown): ApnsEnvironment | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = normalizeLowercaseStringOrEmpty(value);
  if (normalized === "sandbox" || normalized === "production") {
    return normalized;
  }
  return null;
}

const apnsNodeIdSchema = z.string().transform(normalizeApnsNodeId).refine(isValidApnsNodeId);
const apnsTopicSchema = z.string().transform(normalizeApnsTopic).refine(isValidApnsTopic);
const apnsEnvironmentSchema = z
  .unknown()
  .transform(normalizeApnsEnvironment)
  .pipe(z.enum(["sandbox", "production"]));
const apnsUpdatedAtSchema = z
  .number()
  .refine(Number.isSafeInteger)
  .refine((value) => value >= 0);
const directApnsRegistrationSchema = z.object({
  nodeId: apnsNodeIdSchema,
  transport: z.string().transform(normalizeLowercaseStringOrEmpty).pipe(z.literal("direct")),
  token: z.string().transform(normalizeApnsToken).refine(isLikelyApnsToken),
  topic: apnsTopicSchema,
  environment: apnsEnvironmentSchema,
  updatedAtMs: apnsUpdatedAtSchema,
});
const relayApnsRegistrationSchema = z.object({
  nodeId: apnsNodeIdSchema,
  transport: z.string().transform(normalizeLowercaseStringOrEmpty).pipe(z.literal("relay")),
  relayHandle: z
    .string()
    .transform((value) => value.trim())
    .refine(isValidRelayIdentifier),
  sendGrant: z
    .string()
    .transform((value) => value.trim())
    .refine((value) => isValidRelayIdentifier(value, MAX_SEND_GRANT_LENGTH)),
  installationId: z
    .string()
    .transform((value) => value.trim())
    .refine(isValidRelayIdentifier),
  topic: apnsTopicSchema,
  environment: apnsEnvironmentSchema,
  distribution: z.unknown().transform(normalizeDistribution).pipe(z.literal("official")),
  updatedAtMs: apnsUpdatedAtSchema,
  relayOrigin: z.unknown().optional(),
  tokenDebugSuffix: z.unknown().optional().transform(normalizeTokenDebugSuffix),
});
const canonicalApnsRegistrationSchema = z.union([
  directApnsRegistrationSchema,
  relayApnsRegistrationSchema,
]);

function normalizeCanonicalApnsRegistrationWithRelayOrigin(
  record: unknown,
  normalizeOrigin: (value: unknown) => string | undefined,
): ApnsRegistration | null {
  const result = canonicalApnsRegistrationSchema.safeParse(record);
  if (!result.success) {
    return null;
  }
  if (result.data.transport === "direct") {
    return result.data;
  }
  const relayOrigin = normalizeOrigin(result.data.relayOrigin);
  const { relayOrigin: _rawRelayOrigin, ...registration } = result.data;
  return {
    ...registration,
    ...(relayOrigin ? { relayOrigin } : {}),
  };
}

/** Normalizes one canonical registration with an explicit transport discriminator. */
export function normalizeCanonicalApnsRegistration(
  record: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ApnsRegistration | null {
  return normalizeCanonicalApnsRegistrationWithRelayOrigin(record, (value) =>
    normalizeRelayOrigin(value, env),
  );
}

export function apnsRegistrationFromRow(row: ApnsRegistrationRow): ApnsRegistration {
  const { token } = row;
  const normalized = normalizeCanonicalApnsRegistrationWithRelayOrigin(
    {
      nodeId: row.node_id,
      transport: row.transport,
      token,
      relayHandle: row.relay_handle ?? undefined,
      sendGrant: row.send_grant ?? undefined,
      installationId: row.installation_id ?? undefined,
      relayOrigin: row.relay_origin ?? undefined,
      topic: row.topic,
      environment: row.environment,
      distribution: row.distribution ?? undefined,
      tokenDebugSuffix: row.token_debug_suffix ?? undefined,
      updatedAtMs: row.updated_at_ms,
    },
    normalizePersistedRelayOrigin,
  );
  if (!normalized) {
    throw new Error("invalid APNs registration row");
  }
  const canonical = apnsRegistrationToRow(normalized);
  if (
    canonical.node_id !== row.node_id ||
    canonical.transport !== row.transport ||
    canonical.token !== row.token ||
    canonical.relay_handle !== row.relay_handle ||
    canonical.send_grant !== row.send_grant ||
    canonical.installation_id !== row.installation_id ||
    canonical.relay_origin !== row.relay_origin ||
    canonical.topic !== row.topic ||
    canonical.environment !== row.environment ||
    canonical.distribution !== row.distribution ||
    canonical.token_debug_suffix !== row.token_debug_suffix ||
    canonical.updated_at_ms !== row.updated_at_ms
  ) {
    throw new Error("non-canonical APNs registration row");
  }
  return normalized;
}

export function readApnsRegistrationFromDatabase(
  db: OpenClawStateDatabase["db"],
  normalizedNodeId: string,
): ApnsRegistration | null {
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<ApnsRegistrationDatabase>(db)
      .selectFrom("apns_registrations")
      .selectAll()
      .where("node_id", "=", normalizedNodeId),
  );
  return row ? apnsRegistrationFromRow(row) : null;
}

/** Decode each bounded query before advancing to the next requested chunk. */
export function readApnsRegistrationsFromDatabase(
  db: OpenClawStateDatabase["db"],
  uniqueNodeIds: readonly string[],
): Map<string, ApnsRegistration> {
  const registrations = new Map<string, ApnsRegistration>();
  const stateDb = getNodeSqliteKysely<ApnsRegistrationDatabase>(db);
  for (
    let offset = 0;
    offset < uniqueNodeIds.length;
    offset += APNS_REGISTRATION_LOOKUP_CHUNK_SIZE
  ) {
    const rows = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("apns_registrations")
        .selectAll()
        .where(
          "node_id",
          "in",
          uniqueNodeIds.slice(offset, offset + APNS_REGISTRATION_LOOKUP_CHUNK_SIZE),
        ),
    ).rows;
    for (const row of rows) {
      registrations.set(row.node_id, apnsRegistrationFromRow(row));
    }
  }
  return registrations;
}
