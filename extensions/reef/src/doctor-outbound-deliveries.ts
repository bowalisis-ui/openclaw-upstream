import path from "node:path";
import type {
  PluginDoctorStateMigration,
  PluginDoctorStateRowImport,
  PluginDoctorStateSourceRow,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { decryptAuditText, type AuditEntry } from "../protocol/audit.js";
import { fromBase64url } from "../protocol/encoding.js";
import {
  BadSignatureError,
  MalformedError,
  TooLargeError,
  bodyHash,
  validateMessageBody,
  verifySignedEnvelope,
} from "../protocol/envelope.js";
import { parseHandleEpoch } from "../protocol/identity.js";
import {
  REEF_AUDIT_HEAD_KEY,
  REEF_AUDIT_HEAD_MAX_ENTRIES,
  REEF_AUDIT_HEAD_NAMESPACE,
  REEF_AUDIT_NAMESPACE,
  REEF_AUDIT_STORE_MAX_ENTRIES,
  reefAuditEntryKey,
  type ReefAuditHeadRecord,
  type ReefAuditStateRecord,
} from "./audit-state.js";
import { parseReefRelayUrl, ReefChannelConfigSchema } from "./config-schema.js";
import { readStoredReefAudit } from "./doctor-durable-state.js";
import { legacyReefFileExists, resolveLegacyReefStateDir } from "./doctor-state-paths.js";
import { ReefPeerTrustSchema, reefPeerIdentity, sameReefPeerIdentity } from "./friend-types.js";
import {
  parseReefIdentityBinding,
  REEF_REGISTRATION_IDENTITY_KEY,
  REEF_REGISTRATION_NAMESPACE,
} from "./registration-state.js";
import {
  parseReefKeys,
  REEF_KEYS_KEY,
  REEF_KEYS_NAMESPACE,
  REEF_DURABLE_MIGRATION_NAMESPACE,
  REEF_DURABLE_MIGRATION_MAX_ENTRIES,
  REEF_OUTBOUND_MIGRATION_KEY,
  type ReefDurableMigrationRecord,
} from "./state.js";
import {
  ReefOutboundDeliverySchema,
  REEF_OUTBOUND_DELIVERY_MAX_ENTRIES,
  REEF_OUTBOUND_DELIVERY_STORE_NAMESPACE,
  REEF_OUTBOUND_DELIVERY_TTL_MS,
  REEF_TRUST_STORE_NAMESPACE,
  resolveReefTrustStoreKey,
} from "./trust-store.js";

type MigrationInput = Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0];

function pendingDeliveries(entries: readonly AuditEntry[], warnings: string[]) {
  const oldest = Math.floor((Date.now() - REEF_OUTBOUND_DELIVERY_TTL_MS) / 1_000);
  const sealed = new Map<string, AuditEntry>();
  const confirmed = new Set<string>();
  const ambiguous = new Set<string>();
  const candidates = new Map<
    string,
    {
      id: string;
      from: string;
      to: string;
      bodyHash: string;
      proposal: AuditEntry;
      envelope: AuditEntry;
    }[]
  >();
  for (const entry of entries.toReversed()) {
    const payload = asOptionalRecord(entry.event.payload);
    if (typeof payload?.id === "string" && ambiguous.has(payload.id)) {
      continue;
    }
    if (entry.event.type === "confirm_delivery" && entry.event.ts >= oldest) {
      const receipt = asOptionalRecord(payload?.receipt);
      if (typeof receipt?.id === "string") {
        confirmed.add(receipt.id);
        sealed.delete(receipt.id);
      }
    } else if (entry.event.type === "envelope" && typeof payload?.id === "string") {
      if (entry.event.ts >= oldest && !confirmed.has(payload.id)) {
        if (sealed.has(payload.id)) {
          ambiguous.add(payload.id);
          candidates.delete(payload.id);
          warnings.push(
            `Reef delivery ${payload.id} has overlapping historical attempts; journal rows were preserved. Inspect the original messages and receipts before retrying Doctor.`,
          );
          continue;
        }
        sealed.set(payload.id, entry);
      }
    } else if (entry.event.type === "proposal") {
      const envelope = typeof payload?.id === "string" ? sealed.get(payload.id) : undefined;
      if (
        envelope &&
        typeof payload?.id === "string" &&
        /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(payload.id) &&
        typeof payload.from === "string" &&
        typeof payload.to === "string" &&
        typeof payload.bodyHash === "string" &&
        /^[a-f0-9]{64}$/.test(payload.bodyHash)
      ) {
        sealed.delete(payload.id);
        const attempts = candidates.get(payload.id) ?? [];
        const previous = attempts[0];
        if (
          previous &&
          (previous.from !== payload.from ||
            previous.to !== payload.to ||
            previous.bodyHash !== payload.bodyHash)
        ) {
          ambiguous.add(payload.id);
          candidates.delete(payload.id);
          warnings.push(
            `Reef delivery ${payload.id} has conflicting historical bindings; journal rows were preserved. Inspect the original message and receipt before retrying Doctor.`,
          );
          continue;
        }
        attempts.push({
          id: payload.id,
          from: payload.from,
          to: payload.to,
          bodyHash: payload.bodyHash,
          proposal: entry,
          envelope,
        });
        candidates.set(payload.id, attempts);
      }
    }
  }
  return [...candidates.values()];
}

async function prepareImports(
  params: MigrationInput,
  warnings: string[],
  refusals: string[],
): Promise<PluginDoctorStateRowImport[]> {
  const configured = asOptionalRecord(params.config.channels?.reef);
  const parsedConfig = ReefChannelConfigSchema.safeParse({
    handle: configured?.handle,
    relayUrl: configured?.relayUrl,
  });
  const context = params.context;
  const audit = await readStoredReefAudit(
    context.openPluginStateKeyedStore<ReefAuditStateRecord>({
      namespace: REEF_AUDIT_NAMESPACE,
      maxEntries: REEF_AUDIT_STORE_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    }),
    context.openPluginStateKeyedStore<ReefAuditHeadRecord>({
      namespace: REEF_AUDIT_HEAD_NAMESPACE,
      maxEntries: REEF_AUDIT_HEAD_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    }),
  );
  const candidates = pendingDeliveries(audit, refusals);
  if (candidates.length === 0) {
    return [];
  }
  const readRows = context.readPluginStateEntriesInKeyRange;
  const inspectImported = context.inspectImportedPluginStateSources;
  if (!readRows || !inspectImported) {
    refusals.push(
      "Update the OpenClaw host and run openclaw doctor --fix to import Reef delivery bindings.",
    );
    return [];
  }
  const readSource = (namespace: string, key: string): PluginDoctorStateSourceRow => {
    const row = readRows(namespace, { prefix: key, limit: 1 })[0];
    if (!row || row.key !== key) {
      throw new Error("Reef state changed during Doctor inspection; run Doctor again.");
    }
    return { namespace, ...row };
  };
  const head = readSource(REEF_AUDIT_HEAD_NAMESPACE, REEF_AUDIT_HEAD_KEY);
  const headValue = asOptionalRecord(head.value);
  if (headValue?.hash !== audit.at(-1)?.entryHash || headValue?.seq !== audit.at(-1)?.event.seq) {
    throw new Error("Reef audit advanced during Doctor inspection; run Doctor again.");
  }
  const rawSources = candidates.map((attempts) =>
    attempts.map((candidate) =>
      readSource(REEF_AUDIT_NAMESPACE, reefAuditEntryKey(candidate.envelope.entryHash)),
    ),
  );
  const imported = new Set((await inspectImported(rawSources.flat())).map((source) => source.key));
  if (rawSources.flat().every((source) => imported.has(source.key))) {
    return [];
  }
  const plans: PluginDoctorStateRowImport[] = [];
  const pending = candidates.flatMap((attempts, index) => {
    const sources = rawSources[index]!;
    if (sources.every((source) => imported.has(source.key))) return [];
    // The predecessor retained the oldest eligible equivalent attempt's age.
    const candidate = attempts.at(-1)!;
    const expiresAt = candidate.envelope.event.ts * 1_000 + REEF_OUTBOUND_DELIVERY_TTL_MS;
    const sourcePlans: PluginDoctorStateRowImport[] = attempts.flatMap((attempt, attemptIndex) => {
      const source = sources[attemptIndex]!;
      if (imported.has(source.key)) return [];
      const proposal = readSource(
        REEF_AUDIT_NAMESPACE,
        reefAuditEntryKey(attempt.proposal.entryHash),
      );
      if (
        JSON.stringify(asOptionalRecord(source.value)?.entry) !==
          JSON.stringify(attempt.envelope) ||
        JSON.stringify(asOptionalRecord(proposal.value)?.entry) !== JSON.stringify(attempt.proposal)
      ) {
        throw new Error("Reef audit source changed during Doctor inspection; run Doctor again.");
      }
      return [{ source, checks: [head, proposal], target: null }];
    });
    // Previously handled or expired sends can never gain a new binding from another attempt.
    if (sources.some((source) => imported.has(source.key)) || expiresAt <= Date.now()) {
      plans.push(...sourcePlans);
      return [];
    }
    return [{ attempts, candidate, expiresAt, sourcePlans }];
  });
  if (pending.length === 0) return plans;
  if (!parsedConfig.success || !parsedConfig.data.handle) {
    refusals.push(
      "Reef delivery recovery requires the original configured handle and relay; restore them and rerun Doctor. Journal rows were preserved.",
    );
    return plans;
  }
  let keysSource: PluginDoctorStateSourceRow;
  let identitySource: PluginDoctorStateSourceRow;
  let keys: ReturnType<typeof parseReefKeys>;
  try {
    keysSource = readSource(REEF_KEYS_NAMESPACE, REEF_KEYS_KEY);
    keys = parseReefKeys(keysSource.value);
    identitySource = readSource(REEF_REGISTRATION_NAMESPACE, REEF_REGISTRATION_IDENTITY_KEY);
    const identity = parseReefIdentityBinding(identitySource.value);
    if (
      identity?.handle !== parsedConfig.data.handle ||
      identity.relayUrl !== parseReefRelayUrl(parsedConfig.data.relayUrl)
    ) {
      throw new Error("stored registration differs");
    }
  } catch {
    refusals.push(
      "Reef delivery import requires matching stored keys and registration; restore the original identity and matching configuration, then rerun Doctor. Journal rows were preserved.",
    );
    return plans;
  }
  for (const { attempts, candidate, expiresAt, sourcePlans } of pending) {
    const checkedPlans = sourcePlans.map((plan) => ({
      ...plan,
      checks: [...plan.checks, keysSource, identitySource],
    }));
    try {
      if (candidate.from !== `${parsedConfig.data.handle}#${keys.keyEpoch}`) {
        throw new Error("original local identity is unavailable");
      }
      let invalidEnvelopes = 0;
      for (const attempt of attempts) {
        const payload = asOptionalRecord(attempt.envelope.event.payload);
        let envelope: ReturnType<typeof verifySignedEnvelope>;
        try {
          envelope = verifySignedEnvelope(payload?.envelope, keys.signing.publicKey);
        } catch (error) {
          if (
            !(
              error instanceof BadSignatureError ||
              error instanceof MalformedError ||
              error instanceof TooLargeError
            )
          )
            throw error;
          invalidEnvelopes++;
          continue;
        }
        const proposal = asOptionalRecord(
          decryptAuditText(attempt.proposal, fromBase64url(keys.auditKey)).event.payload,
        );
        const body = proposal?.body;
        validateMessageBody(body);
        if (
          envelope.id !== candidate.id ||
          envelope.from !== candidate.from ||
          envelope.to !== candidate.to ||
          typeof proposal?.approvalDigest !== "string" ||
          !/^[a-f0-9]{64}$/.test(proposal.approvalDigest) ||
          proposal.approvalDigest !== payload?.approvalDigest ||
          bodyHash(body) !== candidate.bodyHash
        ) {
          throw new Error("signed envelope and proposal differ");
        }
      }
      if (invalidEnvelopes > 0) {
        if (invalidEnvelopes !== attempts.length)
          throw new Error("mixed valid and invalid attempts");
        warnings.push(
          `Reef delivery ${candidate.id} is invalid; recorded its journal source without creating a binding. Original rows were preserved.`,
        );
        plans.push(...checkedPlans);
        continue;
      }
    } catch {
      refusals.push(
        `Reef delivery ${candidate.id} could not be verified with the stored identity; journal rows were preserved. Restore the matching identity and journal before rerunning Doctor.`,
      );
      continue;
    }
    const recipient = parseHandleEpoch(candidate.to);
    const peerKey = resolveReefTrustStoreKey(parsedConfig.data, recipient.handle);
    const targetKey = `${peerKey}:${candidate.id}`;
    const peer = readRows(REEF_TRUST_STORE_NAMESPACE, { prefix: peerKey, limit: 1 })[0];
    if (!peer || peer.key !== peerKey) {
      refusals.push(
        `Reef delivery ${candidate.id} requires the original peer trust for @${recipient.handle}; restore it and rerun Doctor. Journal rows were preserved.`,
      );
      continue;
    }
    const trust = ReefPeerTrustSchema.safeParse(asOptionalRecord(peer.value)?.trust);
    if (
      !trust.success ||
      trust.data.safetyNumberChanged ||
      trust.data.keyEpoch !== recipient.keyEpoch
    ) {
      refusals.push(
        `Reef delivery ${candidate.id} has unverifiable peer trust for @${recipient.handle}; restore the matching peer identity and rerun Doctor. Journal rows were preserved.`,
      );
      continue;
    }
    const recipientIdentity = reefPeerIdentity(trust.data);
    const existing = readRows(REEF_OUTBOUND_DELIVERY_STORE_NAMESPACE, {
      prefix: targetKey,
      limit: 1,
    }).find((row) => row.key === targetKey);
    if (existing) {
      const binding = ReefOutboundDeliverySchema.safeParse(existing.value);
      if (
        !binding.success ||
        binding.data.bodyHash !== candidate.bodyHash ||
        !sameReefPeerIdentity(binding.data.recipient, recipientIdentity)
      ) {
        throw new Error(
          `Reef delivery binding ${candidate.id} conflicts with verified audit evidence; retained both records for inspection.`,
        );
      }
    }
    for (const plan of checkedPlans) {
      plans.push({
        ...plan,
        checks: [...plan.checks, { namespace: REEF_TRUST_STORE_NAMESPACE, ...peer }],
        target: {
          namespace: REEF_OUTBOUND_DELIVERY_STORE_NAMESPACE,
          maxEntries: REEF_OUTBOUND_DELIVERY_MAX_ENTRIES,
          key: targetKey,
          value: existing?.value ?? {
            bodyHash: candidate.bodyHash,
            recipient: recipientIdentity,
            resendDisabled: true,
          },
          createdAt: existing?.createdAt ?? candidate.envelope.event.ts * 1_000,
          expiresAt: existing ? existing.expiresAt : expiresAt,
        },
      });
    }
  }
  return plans;
}

function openReadinessStore(params: MigrationInput) {
  return params.context.openPluginStateKeyedStore<ReefDurableMigrationRecord>({
    namespace: REEF_DURABLE_MIGRATION_NAMESPACE,
    maxEntries: REEF_DURABLE_MIGRATION_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
}

export const reefOutboundDeliveryMigration: PluginDoctorStateMigration = {
  id: "reef-audit-to-outbound-bindings",
  label: "Reef outbound delivery bindings",
  collectBackupResources: () => [],
  async detectLegacyState(params) {
    try {
      if (await legacyReefFileExists(path.join(resolveLegacyReefStateDir(params), "audit.jsonl"))) {
        return {
          preview: ["- Import Reef delivery bindings after the legacy audit and peer imports"],
        };
      }
      const warnings: string[] = [];
      const refusals: string[] = [];
      const plans = await prepareImports(params, warnings, refusals);
      const pending = await openReadinessStore(params).lookup(REEF_OUTBOUND_MIGRATION_KEY);
      return plans.length > 0 || warnings.length > 0 || refusals.length > 0 || pending
        ? {
            preview: [
              `- Reef journal: ${plans.length} pending source receipts -> plugin state`,
              ...warnings,
              ...refusals,
            ],
          }
        : null;
    } catch {
      // The locked callback must install its admission blocker before reporting a refusal.
      return {
        preview: ["- Reef outbound delivery state requires offline verification before startup"],
      };
    }
  },
  async migrateLegacyState(params) {
    const readiness = openReadinessStore(params);
    await readiness.register(REEF_OUTBOUND_MIGRATION_KEY, { pending: true });
    const warnings: string[] = [];
    const refusals: string[] = [];
    const plans = await prepareImports(params, warnings, refusals);
    const changes: string[] = [];
    if (plans.length > 0) {
      if (!params.context.importPluginStateRows) {
        return {
          changes,
          warnings: [
            "Reef delivery binding import requires a newer OpenClaw host; update it and run openclaw doctor --fix before starting Reef.",
          ],
        };
      }
      const result = await params.context.importPluginStateRows(plans);
      if (result.backupPath)
        changes.push(`Saved Reef delivery migration backup: ${result.backupPath}`);
      changes.push(
        `Recorded ${plans.length} Reef journal source receipts (${result.imported} delivery bindings imported with resend disabled); preserved existing bindings.`,
      );
    }
    if (refusals.length > 0) {
      return { changes, warnings: [...warnings, ...refusals] };
    }
    await readiness.delete(REEF_OUTBOUND_MIGRATION_KEY);
    return { changes, warnings, warningDisposition: "recoverable" };
  },
};
