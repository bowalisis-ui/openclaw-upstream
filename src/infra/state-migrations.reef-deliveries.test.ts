import {
  createCipheriv,
  createHash,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  sign,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  coercePluginDoctorContractModule,
  type PluginDoctorContractModule,
} from "../plugins/doctor-contract-module.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as snapshots from "./sqlite-snapshot.js";
import { createPluginDoctorStateMigrationContext } from "./state-migrations.plugin-doctor-context.js";

const authority = { assertCurrent() {}, assertOwnedInTransaction() {} };

function historicalReefSend(
  id: string,
  ts: number,
  overrides: { id?: string; from?: string; to?: string } = {},
) {
  const signing = generateKeyPairSync("ed25519");
  const encryption = generateKeyPairSync("x25519");
  const recipient = generateKeyPairSync("x25519");
  const peerSigning = generateKeyPairSync("ed25519");
  const ephemeral = generateKeyPairSync("x25519");
  const encodeKey = (key: (typeof signing)["publicKey"]) =>
    key.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
  const encodeSecret = (key: (typeof signing)["privateKey"]) =>
    key.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64url");
  const auditKey = Buffer.alloc(32, 1);
  const nonce = Buffer.alloc(12, 2);
  const encrypt = (bytes: Buffer, key: Buffer | ArrayBuffer, encryptionNonce = nonce) => {
    const cipher = createCipheriv(
      "aes-256-gcm",
      key instanceof ArrayBuffer ? Buffer.from(key) : key,
      encryptionNonce,
    );
    return Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
  };
  const body = { text: "Retain this historical café message" };
  const bodyBytes = Buffer.from(JSON.stringify(body));
  const bodyHash = createHash("sha256").update(bodyBytes).digest("hex");
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipient.publicKey,
  });
  const key = hkdfSync("sha256", shared, Buffer.alloc(0), Buffer.from("reef-v1"), 32);
  const unsigned = {
    ct: encrypt(bodyBytes, key).toString("base64"),
    epk: ephemeral.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64"),
    from: "bob#1",
    id,
    n: nonce.toString("base64"),
    to: "alice#1",
    ts,
    v: 1,
    ...overrides,
  };
  const sig = sign(null, Buffer.from(reefJournalJson(unsigned)), signing.privateKey).toString(
    "base64",
  );
  return {
    bodyHash,
    body: {
      text: {
        enc: Buffer.concat([nonce, encrypt(Buffer.from(body.text), auditKey)]).toString("base64"),
      },
    },
    envelope: { ...unsigned, sig },
    repeat(text: string, repeatedTs: number) {
      const bytes = Buffer.from(JSON.stringify({ text }));
      const repeatedNonce = Buffer.alloc(12, 4);
      const repeated = {
        ...unsigned,
        ct: encrypt(bytes, key, repeatedNonce).toString("base64"),
        n: repeatedNonce.toString("base64"),
        ts: repeatedTs,
      };
      return {
        bodyHash: createHash("sha256").update(bytes).digest("hex"),
        body: {
          text: {
            enc: Buffer.concat([
              repeatedNonce,
              encrypt(Buffer.from(text), auditKey, repeatedNonce),
            ]).toString("base64"),
          },
        },
        envelope: {
          ...repeated,
          sig: sign(null, Buffer.from(reefJournalJson(repeated)), signing.privateKey).toString(
            "base64",
          ),
        },
      };
    },
    identity: {
      ed25519PublicKey: encodeKey(peerSigning.publicKey),
      x25519PublicKey: encodeKey(recipient.publicKey),
      keyEpoch: 1,
    },
    keys: {
      signing: {
        publicKey: encodeKey(signing.publicKey),
        secretKey: encodeSecret(signing.privateKey),
      },
      encryption: {
        publicKey: encodeKey(encryption.publicKey),
        secretKey: encodeSecret(encryption.privateKey),
      },
      auditKey: auditKey.toString("base64url"),
      replayKey: Buffer.alloc(32, 3).toString("base64url"),
      keyEpoch: 1,
    },
  };
}

function reefJournalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) => left.localeCompare(right)),
        )
      : item,
  );
}

describe("Reef historical delivery import", () => {
  it.each([
    "absent",
    "equivalent-relay-url",
    "matching",
    "body-conflict",
    "recipient-conflict",
    "malformed",
    "bad-signature",
    "oversized-envelope",
    "corrupt-chain",
    "wrong-envelope-id",
    "wrong-envelope-sender",
    "wrong-envelope-recipient",
    "wrong-body-hash",
    "wrong-approval",
    "wrong-epoch",
    "wrong-registration",
    "missing-config",
    "old-host",
    "keys-race",
    "registration-race",
    "trust-race",
    "repeated-id",
    "expiry-during-scan",
    "ambiguous-id",
    "overlapping-id",
    "trust-after-detection",
    "keys-after-detection",
    "registration-after-detection",
  ] as const)("imports audit receipts with a %s canonical binding", async (existing) => {
    await withOpenClawTestState(
      { label: "reef-outbound-import", applyEnv: false },
      async ({ env, stateDir }) => {
        const migrationId = "reef-audit-to-outbound-bindings";
        const config = {
          channels: {
            reef: {
              handle: "bob",
              relayUrl:
                existing === "equivalent-relay-url"
                  ? "HTTPS://REEFWIRE.AI/"
                  : "https://reefwire.ai",
            },
          },
        };
        const owner = createPluginDoctorStateMigrationContext({
          pluginId: "reef",
          migrationId,
          env,
          config,
          trustedForDurableStores: true,
          repairAuthority: authority,
        });
        const id = "01JZ0000000000000000000127";
        const ts = Math.floor(Date.now() / 1_000) - 3_600;
        const fixture = historicalReefSend(id, ts, {
          ...(existing === "wrong-envelope-id" ? { id: "01JZ0000000000000000000128" } : {}),
          ...(existing === "wrong-envelope-sender" ? { from: "stranger#1" } : {}),
          ...(existing === "wrong-envelope-recipient" ? { to: "alice#2" } : {}),
        });
        if (existing === "oversized-envelope") {
          Object.assign(fixture, fixture.repeat("x".repeat(34 * 1024), ts));
        }
        const { bodyHash, identity } = fixture;
        const approvalDigest = "e".repeat(64);
        if (existing === "bad-signature")
          fixture.envelope.sig = Buffer.alloc(64).toString("base64");
        if (existing === "wrong-epoch") fixture.keys.keyEpoch = 2;
        const ttlMs = 61 * 24 * 60 * 60 * 1_000;
        // Published pre-binding audit rows use canonical event JSON after the previous digest.
        const proposalEvent = {
          payload: {
            approvalDigest,
            body: fixture.body,
            bodyHash: existing === "wrong-body-hash" ? "f".repeat(64) : bodyHash,
            from: "bob#1",
            id,
            to: "alice#1",
          },
          seq: 1,
          ts: ts - ttlMs / 1_000 - 1,
          type: "proposal",
        };
        const envelopeEvent = {
          payload: {
            approvalDigest: existing === "wrong-approval" ? "f".repeat(64) : approvalDigest,
            envelope: fixture.envelope,
            id,
          },
          seq: 2,
          ts,
          type: "envelope",
        };
        const events = [proposalEvent, envelopeEvent];
        if (
          existing === "repeated-id" ||
          existing === "expiry-during-scan" ||
          existing === "ambiguous-id" ||
          existing === "overlapping-id"
        ) {
          const repeated = fixture.repeat(
            existing !== "repeated-id" && existing !== "expiry-during-scan"
              ? "A distinct authentic historical message"
              : "Retain this historical café message",
            ts + 60,
          );
          events.push(
            {
              ...proposalEvent,
              payload: {
                ...proposalEvent.payload,
                body: repeated.body,
                bodyHash: repeated.bodyHash,
              },
              ts: ts + 60,
            },
            {
              ...envelopeEvent,
              payload: { ...envelopeEvent.payload, envelope: repeated.envelope },
              ts: ts + 60,
            },
          );
          if (existing === "overlapping-id") {
            events.splice(0, 4, events[0]!, events[2]!, events[3]!, events[1]!);
          }
        }
        let previous = "";
        const entries = events.map((value, index) => {
          const event = { ...value, seq: index + 1 };
          const entryHash = createHash("sha256")
            .update(Buffer.from(previous, "hex"))
            .update(reefJournalJson(event))
            .digest("hex");
          const entry = { event, prevHash: previous, entryHash };
          previous = entryHash;
          return entry;
        });
        const envelopeHash = entries[1]!.entryHash;
        if (existing === "corrupt-chain") entries[1]!.event.ts++;
        const audit = owner.openPluginStateKeyedStore({
          namespace: "audit",
          maxEntries: 30_001,
          overflowPolicy: "reject-new",
        });
        for (const [index, entry] of entries.entries()) {
          await audit.register(`entry:${entry.entryHash}`, {
            kind: "entry",
            entry,
            ...(entries[index + 1] ? { nextHash: entries[index + 1]!.entryHash } : {}),
          });
        }
        await owner
          .openPluginStateKeyedStore({
            namespace: "audit-head",
            maxEntries: 1,
            overflowPolicy: "reject-new",
          })
          .register("head", {
            kind: "head",
            hash: previous,
            seq: entries.length,
            oldestHash: entries[0]!.entryHash,
          });
        const keys = owner.openPluginStateKeyedStore({ namespace: "identity", maxEntries: 1 });
        await keys.register("keys", fixture.keys);
        const registration = owner.openPluginStateKeyedStore({
          namespace: "registration",
          maxEntries: 2,
        });
        await registration.register("identity", {
          handle: existing === "wrong-registration" ? "stranger" : "bob",
          relayUrl: "https://reefwire.ai",
        });
        const scope = createHash("sha256").update("https://reefwire.ai\nbob").digest("hex");
        await owner
          .openPluginStateKeyedStore({
            namespace: "peer-state",
            maxEntries: 4_096,
            overflowPolicy: "reject-new",
          })
          .register(`${scope}:alice`, {
            revision: 1,
            trust: {
              ...identity,
              autonomy: "bounded",
              safetyNumberChanged: false,
              approvedAt: 1,
            },
          });
        const originalAudit = await audit.entries();
        const contract = coercePluginDoctorContractModule(
          await vi.importActual<PluginDoctorContractModule>(
            fileURLToPath(new URL("../../extensions/reef/doctor-contract-api.ts", import.meta.url)),
          ),
        );
        const migration = contract.stateMigrations.find((item) => item.id === migrationId);
        expect(migration).toBeDefined();
        if (!migration) {
          throw new Error("Missing registered Reef delivery migration");
        }
        const input = {
          config: existing === "missing-config" ? {} : config,
          env,
          stateDir,
          oauthDir: path.join(stateDir, "credentials"),
          context:
            existing === "old-host"
              ? { ...owner, inspectImportedPluginStateSources: undefined }
              : owner,
        };
        const target = owner.openPluginStateKeyedStore({
          namespace: "outbound-deliveries",
          maxEntries: 32_768,
          overflowPolicy: "reject-new",
          defaultTtlMs: ttlMs,
        });
        const targetKey = `${scope}:alice:${id}`;
        const readiness = owner.openPluginStateKeyedStore({
          namespace: "durable-migration",
          maxEntries: 2,
        });
        if (["matching", "body-conflict", "recipient-conflict", "malformed"].includes(existing)) {
          await target.register(targetKey, {
            bodyHash: existing === "body-conflict" ? "c".repeat(64) : bodyHash,
            recipient: existing === "recipient-conflict" ? { ...identity, keyEpoch: 2 } : identity,
            textHash: "d".repeat(64),
            sentAt: existing === "malformed" ? "invalid" : ts * 1_000 + 15,
            overdueNotifiedAt: ts * 1_000 + 30,
          });
        }
        const before = await target.entries();
        if (existing === "expiry-during-scan") {
          const inspectImported = owner.inspectImportedPluginStateSources;
          if (!inspectImported) throw new Error("Missing import inspection");
          const clock = vi.spyOn(Date, "now");
          try {
            const result = await migration.migrateLegacyState({
              ...input,
              context: {
                ...owner,
                async inspectImportedPluginStateSources(sources) {
                  const receipts = await inspectImported(sources);
                  clock.mockReturnValue(ts * 1_000 + ttlMs + 1_000);
                  return receipts;
                },
              },
            });
            expect(result.warnings).toEqual([]);
            expect(await target.entries()).toEqual([]);
            await expect(
              inspectImported(
                entries
                  .filter((entry) => entry.event.type === "envelope")
                  .map((entry) => ({ namespace: "audit", key: `entry:${entry.entryHash}` })),
              ),
            ).resolves.toHaveLength(2);
            expect(await migration.detectLegacyState(input)).toBeNull();
            expect(await audit.entries()).toEqual(originalAudit);
          } finally {
            clock.mockRestore();
          }
          return;
        }
        if (existing === "bad-signature" || existing === "oversized-envelope") {
          expect(await migration.detectLegacyState(input)).not.toBeNull();
          const result = await migration.migrateLegacyState(input);
          expect(result).toMatchObject({
            warnings: [expect.stringContaining("is invalid")],
            warningDisposition: "recoverable",
          });
          expect(await target.entries()).toEqual([]);
          expect(await audit.entries()).toEqual(originalAudit);
          expect(await readiness.lookup("outbound-deliveries")).toBeUndefined();
          await expect(
            owner.inspectImportedPluginStateSources?.([
              { namespace: "audit", key: `entry:${envelopeHash}` },
            ]),
          ).resolves.toHaveLength(1);
          expect(await migration.detectLegacyState(input)).toBeNull();
          return;
        }
        if (
          existing.startsWith("wrong-") ||
          existing === "missing-config" ||
          existing === "old-host"
        ) {
          expect(await migration.detectLegacyState(input)).not.toBeNull();
          const result = await migration.migrateLegacyState(input);
          expect(result).toMatchObject({
            changes: [],
            warnings: [
              expect.stringContaining(
                existing === "old-host"
                  ? "Update the OpenClaw host"
                  : existing === "missing-config"
                    ? "original configured handle"
                    : existing === "wrong-registration"
                      ? "matching stored keys and registration"
                      : "could not be verified",
              ),
            ],
          });
          expect(result.warningDisposition).toBeUndefined();
          expect(await readiness.lookup("outbound-deliveries")).toEqual({ pending: true });
          expect(await target.entries()).toEqual(before);
          expect(await audit.entries()).toEqual(originalAudit);
          await expect(
            owner.inspectImportedPluginStateSources?.([
              { namespace: "audit", key: `entry:${envelopeHash}` },
            ]),
          ).resolves.toEqual([]);
          return;
        }
        if (existing === "ambiguous-id" || existing === "overlapping-id") {
          expect(await migration.detectLegacyState(input)).not.toBeNull();
          const result = await migration.migrateLegacyState(input);
          expect(result).toMatchObject({
            changes: [],
            warnings: [
              expect.stringContaining(
                existing === "ambiguous-id"
                  ? "conflicting historical bindings"
                  : "overlapping historical attempts",
              ),
            ],
          });
          expect(result.warningDisposition).toBeUndefined();
          expect(await readiness.lookup("outbound-deliveries")).toEqual({ pending: true });
          expect(await target.entries()).toEqual([]);
          expect(await audit.entries()).toEqual(originalAudit);
          return;
        }
        if (existing.endsWith("-after-detection")) {
          const namespace =
            existing === "trust-after-detection"
              ? "peer-state"
              : existing === "keys-after-detection"
                ? "identity"
                : "registration";
          const key =
            namespace === "peer-state"
              ? `${scope}:alice`
              : namespace === "identity"
                ? "keys"
                : "identity";
          const dependency = owner.openPluginStateKeyedStore({ namespace, maxEntries: 4_096 });
          const original = await dependency.lookup(key);
          expect(original).toBeDefined();
          await dependency.delete(key);
          expect(await migration.detectLegacyState(input)).not.toBeNull();
          const result = await migration.migrateLegacyState(input);
          expect(result).toMatchObject({
            changes: [],
            warnings: [expect.any(String)],
          });
          expect(result.warningDisposition).toBeUndefined();
          expect(await readiness.lookup("outbound-deliveries")).toEqual({ pending: true });
          await dependency.register(key, original);
        }
        if (existing.endsWith("-race")) {
          const snapshot = snapshots.createVerifiedSqliteSnapshot;
          const observer = vi
            .spyOn(snapshots, "createVerifiedSqliteSnapshot")
            .mockImplementation(async (options) => {
              const saved = await snapshot(options);
              if (existing === "keys-race") {
                await keys.register("keys", { ...fixture.keys, keyEpoch: 2 });
              } else if (existing === "registration-race") {
                await registration.register("identity", {
                  handle: "stranger",
                  relayUrl: "https://reefwire.ai",
                });
              } else {
                await owner
                  .openPluginStateKeyedStore({ namespace: "peer-state", maxEntries: 4_096 })
                  .delete(`${scope}:alice`);
              }
              return saved;
            });
          try {
            await expect(migration.migrateLegacyState(input)).rejects.toThrow("state changed");
          } finally {
            observer.mockRestore();
          }
          expect(await target.entries()).toEqual([]);
          expect(await audit.entries()).toEqual(originalAudit);
          await expect(
            owner.inspectImportedPluginStateSources?.([
              { namespace: "audit", key: `entry:${envelopeHash}` },
            ]),
          ).resolves.toEqual([]);
          return;
        }
        if (
          existing.endsWith("conflict") ||
          existing === "malformed" ||
          existing === "corrupt-chain"
        ) {
          expect(await migration.detectLegacyState(input)).not.toBeNull();
          await expect(migration.migrateLegacyState(input)).rejects.toThrow(
            existing === "corrupt-chain"
              ? "invalid Reef audit chain"
              : "conflicts with verified audit",
          );
          expect(await readiness.lookup("outbound-deliveries")).toEqual({ pending: true });
          expect(await target.entries()).toEqual(before);
          expect(await audit.entries()).toEqual(originalAudit);
          await expect(
            owner.inspectImportedPluginStateSources?.([
              { namespace: "audit", key: `entry:${envelopeHash}` },
            ]),
          ).resolves.toEqual([]);
          return;
        }
        expect(await migration.detectLegacyState(input)).not.toBeNull();
        expect((await migration.migrateLegacyState(input)).warnings).toEqual([]);
        expect(await readiness.lookup("outbound-deliveries")).toBeUndefined();
        expect(await target.entries()).toEqual(
          existing === "matching"
            ? before
            : [
                {
                  key: targetKey,
                  value: { bodyHash, recipient: identity, resendDisabled: true },
                  createdAt: ts * 1_000,
                  expiresAt: ts * 1_000 + ttlMs,
                },
              ],
        );
        expect(await audit.entries()).toEqual(originalAudit);
        expect(
          (await fs.readdir(path.join(stateDir, "state"))).some((name) =>
            name.includes(".doctor-plugin-"),
          ),
        ).toBe(true);
        await target.consume(`${scope}:alice:${id}`);
        expect(await migration.detectLegacyState(input)).toBeNull();
        expect(await migration.migrateLegacyState(input)).toMatchObject({
          changes: [],
          warnings: [],
        });
        expect(await target.entries()).toEqual([]);
        if (existing === "repeated-id") {
          await expect(
            owner.inspectImportedPluginStateSources?.(
              entries
                .filter((entry) => entry.event.type === "envelope")
                .map((entry) => ({ namespace: "audit", key: `entry:${entry.entryHash}` })),
            ),
          ).resolves.toHaveLength(2);
          const clock = vi.spyOn(Date, "now").mockReturnValue(ts * 1_000 + ttlMs + 1_000);
          try {
            expect(await migration.detectLegacyState(input)).toBeNull();
            expect(await migration.migrateLegacyState(input)).toMatchObject({
              changes: [],
              warnings: [],
            });
            expect(await target.entries()).toEqual([]);
          } finally {
            clock.mockRestore();
          }
        }
      },
    );
  });
});
