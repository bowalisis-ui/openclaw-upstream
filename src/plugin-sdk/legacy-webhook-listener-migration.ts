import { AsyncLocalStorage } from "node:async_hooks";
import { asNullableRecord as asObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeChannelConfigEntries } from "../config/channel-config-normalization.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalAccountId } from "../routing/account-id.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "./channel-contract.js";

const implicitListenerMigrationKey = Symbol.for("openclaw.implicitLegacyWebhookMigration");
const createMigrationScope = () =>
  new AsyncLocalStorage<{
    enabled: boolean;
    onInspected?: (channelId: string) => void;
    onBlocked?: (channelId: string) => void;
  }>();

/** Doctor supplies prior-operation evidence; ordinary config normalization never invents a pin. */
export function withImplicitLegacyWebhookMigration<T>(
  enabled: boolean,
  run: () => T,
  onInspected?: (channelId: string) => void,
  onBlocked?: (channelId: string) => void,
): T {
  return resolveGlobalSingleton(implicitListenerMigrationKey, createMigrationScope).run(
    { enabled, onInspected, onBlocked },
    run,
  );
}

/** Preserve explicitly configured webhook listeners while moving ingress onto Gateway routes. */
export function createLegacyWebhookListenerDoctorContract(params: {
  channelKey: string;
  defaultPort: number;
  portKey?: string;
  hostKey?: string | null;
  webhookKey?: string;
  defaultHost?: string;
  /** Enabled webhook accounts; undefined selects a channel without account support. */
  implicitAccountIds?: (cfg: OpenClawConfig) => readonly (string | undefined)[];
}): {
  legacyConfigRules: ChannelDoctorLegacyConfigRule[];
  normalizeCompatibilityConfig: (params: { cfg: OpenClawConfig }) => ChannelDoctorConfigMutation;
} {
  const portKey = params.portKey ?? "webhookPort";
  const hostKey = params.hostKey === undefined ? "webhookHost" : params.hostKey;
  const source = (entry: Record<string, unknown>) =>
    params.webhookKey ? asObjectRecord(entry[params.webhookKey]) : entry;
  const hasLegacy = (value: unknown): boolean => {
    const entry = asObjectRecord(value);
    const listener = entry && source(entry);
    return Boolean(
      listener &&
      (Object.hasOwn(listener, portKey) || (hostKey && Object.hasOwn(listener, hostKey))),
    );
  };
  const prefix = `channels.${params.channelKey}`;
  return {
    legacyConfigRules: [
      {
        path: ["channels", params.channelKey],
        message: `${prefix} webhook listeners moved to Gateway routes. Run "openclaw doctor --fix" to preserve explicitly configured listener settings as legacyWebhook.`,
        match: (value) => {
          const accounts = asObjectRecord(asObjectRecord(value)?.accounts);
          return hasLegacy(value) || Object.values(accounts ?? {}).some(hasLegacy);
        },
      },
    ],
    normalizeCompatibilityConfig: ({ cfg }) => {
      const scope = Object.hasOwn(globalThis, implicitListenerMigrationKey)
        ? resolveGlobalSingleton(implicitListenerMigrationKey, createMigrationScope).getStore()
        : undefined;
      if (params.implicitAccountIds) {
        scope?.onInspected?.(params.channelKey);
      }
      const root = asObjectRecord(asObjectRecord(cfg.channels)?.[params.channelKey]);
      const inherited = root && source(root);
      const canonicalRoot = asObjectRecord(root?.legacyWebhook);
      const normalized = normalizeChannelConfigEntries({
        cfg,
        channelId: params.channelKey,
        normalizeEntry: ({ entry, accountId, pathPrefix, changes }) => {
          const listener = source(entry);
          if (!listener || !hasLegacy(entry)) {
            return { entry, changed: false };
          }
          const next = { ...entry };
          const port = Object.hasOwn(listener, portKey)
            ? listener[portKey]
            : ((accountId ? (canonicalRoot?.port ?? inherited?.[portKey]) : undefined) ??
              params.defaultPort);
          const inheritedHost = accountId
            ? canonicalRoot
              ? canonicalRoot.host
              : ((hostKey ? inherited?.[hostKey] : undefined) ?? params.defaultHost)
            : params.defaultHost;
          const host = hostKey ? (listener[hostKey] ?? inheritedHost) : inheritedHost;
          const legacyPath = [pathPrefix, params.webhookKey].filter(Boolean).join(".");
          if (Object.hasOwn(entry, "legacyWebhook")) {
            changes.push(
              `Removed ${legacyPath} legacy listener keys; ${pathPrefix}.legacyWebhook is already configured.`,
            );
          } else if (accountId && root?.legacyWebhook === false) {
            changes.push(
              `Removed ${legacyPath} legacy listener keys; ${prefix}.legacyWebhook: false keeps this account's inherited listener disabled.`,
            );
          } else {
            next.legacyWebhook = { port, ...(host !== undefined ? { host } : {}) };
            changes.push(
              `Moved ${legacyPath} listener settings to ${pathPrefix}.legacyWebhook. Point the external callback or reverse proxy at the Gateway port and webhook path, verify delivery, then set legacyWebhook: false to disable legacy forwarding.`,
            );
          }
          const updated = params.webhookKey ? { ...listener } : next;
          delete updated[portKey];
          if (hostKey) {
            delete updated[hostKey];
          }
          if (params.webhookKey) {
            if (Object.keys(updated).length) {
              next[params.webhookKey] = updated;
            } else {
              delete next[params.webhookKey];
            }
          }
          return { entry: next, changed: true };
        },
      });
      if (!scope?.enabled || !params.implicitAccountIds) {
        return normalized;
      }
      const channel = asObjectRecord(normalized.config.channels?.[params.channelKey]);
      if (!channel || channel.enabled === false || channel.legacyWebhook !== undefined) {
        return normalized;
      }
      const accounts = asObjectRecord(channel.accounts);
      let next = channel;
      for (const accountId of params.implicitAccountIds(normalized.config)) {
        const normalizedId = normalizeOptionalAccountId(accountId);
        const matchingKeys =
          accountId !== undefined && accounts && Object.hasOwn(accounts, accountId)
            ? [accountId]
            : normalizedId
              ? Object.keys(accounts ?? {}).filter(
                  (key) => normalizeOptionalAccountId(key) === normalizedId,
                )
              : [];
        if (matchingKeys.length > 1) {
          scope.onBlocked?.(params.channelKey);
          throw new Error(
            `Cannot pin ${prefix}.accounts.${accountId}: account keys ${matchingKeys.map((key) => JSON.stringify(key)).join(", ")} normalize to the same ID. Rename them to distinct account IDs before running Doctor again.`,
          );
        }
        const accountKey = matchingKeys[0] ?? accountId;
        const account =
          accountKey === undefined ? channel : (asObjectRecord(accounts?.[accountKey]) ?? {});
        if (account.enabled === false || account.legacyWebhook !== undefined) {
          continue;
        }
        const pinned = {
          ...account,
          legacyWebhook: {
            port: params.defaultPort,
            ...(params.defaultHost === undefined ? {} : { host: params.defaultHost }),
          },
        };
        next =
          accountKey === undefined
            ? pinned
            : { ...next, accounts: { ...asObjectRecord(next.accounts), [accountKey]: pinned } };
        const accountPath = accountKey === undefined ? prefix : `${prefix}.accounts.${accountKey}`;
        normalized.changes.push(
          `Pinned ${accountPath}.legacyWebhook to preserve the existing webhook endpoint. Move the external callback or reverse proxy to the Gateway route, verify delivery, then remove this pin. Doctor will not recreate it.`,
        );
      }
      return next === channel
        ? normalized
        : {
            config: {
              ...normalized.config,
              channels: { ...normalized.config.channels, [params.channelKey]: next },
            },
            changes: normalized.changes,
          };
    },
  };
}
