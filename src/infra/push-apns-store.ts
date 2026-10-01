// Canonical worker-backed store for APNs device and relay registrations.
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "../state/openclaw-state-worker-store.js";
import { ApnsRegistrationPairingChangedError } from "./push-apns-store.errors.js";
import {
  isLikelyApnsToken,
  isValidApnsNodeId,
  isValidApnsTopic,
  MAX_SEND_GRANT_LENGTH,
  normalizeApnsEnvironment,
  normalizeApnsNodeId,
  normalizeApnsToken,
  normalizeApnsTopic,
  normalizeDistribution,
  normalizeRelayOrigin,
  normalizeTokenDebugSuffix,
  validateRelayIdentifier,
} from "./push-apns-store.rows.js";
import type { ApnsRegistration } from "./push-apns-store.types.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";

type RegisterApnsParams = {
  nodeId: string;
  topic: string;
  environment?: unknown;
  expectedPairingGeneration?: string;
  assertCurrent?: () => void;
  baseDir?: string;
} & (
  | { transport?: "direct"; token: string }
  | {
      transport: "relay";
      relayHandle: string;
      sendGrant: string;
      installationId: string;
      distribution?: unknown;
      relayOrigin?: unknown;
      tokenDebugSuffix?: unknown;
    }
);

function apnsStateDatabaseOptions(stateDir?: string): OpenClawStateDatabaseOptions {
  return stateDir
    ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } }
    : { env: process.env };
}

/** Persists a validated direct or relay APNs registration for one node id. */
export async function registerApnsRegistration(
  params: RegisterApnsParams,
): Promise<ApnsRegistration> {
  const nodeId = normalizeApnsNodeId(params.nodeId);
  const topic = normalizeApnsTopic(params.topic);
  if (!isValidApnsNodeId(nodeId)) {
    throw new Error("nodeId required");
  }
  if (!isValidApnsTopic(topic)) {
    throw new Error("topic required");
  }

  let candidate: ApnsRegistration;
  if (params.transport === "relay") {
    const relayHandle = validateRelayIdentifier(params.relayHandle.trim(), "relayHandle");
    const sendGrant = validateRelayIdentifier(
      params.sendGrant.trim(),
      "sendGrant",
      MAX_SEND_GRANT_LENGTH,
    );
    const installationId = validateRelayIdentifier(params.installationId.trim(), "installationId");
    const environment = normalizeApnsEnvironment(params.environment);
    const distribution = normalizeDistribution(params.distribution);
    const relayOrigin = normalizeRelayOrigin(params.relayOrigin);
    if (!environment) {
      throw new Error("relay registrations must use valid APNs environment");
    }
    if (distribution !== "official") {
      throw new Error("relay registrations must use official distribution");
    }
    candidate = {
      nodeId,
      transport: "relay",
      relayHandle,
      sendGrant,
      installationId,
      topic,
      environment,
      distribution,
      updatedAtMs: 0,
      ...(relayOrigin ? { relayOrigin } : {}),
      tokenDebugSuffix: normalizeTokenDebugSuffix(params.tokenDebugSuffix),
    };
  } else {
    const token = normalizeApnsToken(params.token);
    const environment = normalizeApnsEnvironment(params.environment) ?? "sandbox";
    if (!isLikelyApnsToken(token)) {
      throw new Error("invalid APNs token");
    }
    candidate = {
      nodeId,
      transport: "direct",
      token,
      topic,
      environment,
      updatedAtMs: 0,
    };
  }

  const context = captureOpenClawStateWorkerContext(apnsStateDatabaseOptions(params.baseDir));
  const nowMs = Date.now();
  const expectedPairingGeneration = params.expectedPairingGeneration;
  const assertCurrent = params.assertCurrent;
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "apns.registration.register",
        input: { candidate, expectedPairingGeneration, nowMs },
      }),
    {
      assertCurrent,
      createAdmission: () => ({
        nativeLocations: [context.admission.databasePath],
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          if (request.stage !== "transaction" && request.stage !== "commit") {
            throw new Error("APNs registration requires transaction admission");
          }
          context.admission.assertCurrent();
          assertCurrent?.();
          grant();
        }),
      }),
    },
  );
  if (result.status === "pairing-changed") {
    throw new ApnsRegistrationPairingChangedError();
  }
  return result.registration;
}

export async function loadApnsRegistration(
  nodeId: string,
  baseDir?: string,
): Promise<ApnsRegistration | null> {
  const normalizedNodeId = normalizeApnsNodeId(nodeId);
  if (!normalizedNodeId) {
    return null;
  }
  const context = captureOpenClawStateWorkerContext(apnsStateDatabaseOptions(baseDir));
  return executeOpenClawStateWorker(context, {
    type: "apns.registration.read",
    input: normalizedNodeId,
  });
}

/** Loads normalized APNs registrations for the requested node ids, preserving request order. */
export async function loadApnsRegistrations(
  nodeIds: readonly string[],
  baseDir?: string,
): Promise<Array<{ nodeId: string; registration: ApnsRegistration }>> {
  const normalizedByInput = nodeIds.map((nodeId) => ({
    nodeId,
    normalizedNodeId: normalizeApnsNodeId(nodeId),
  }));
  const uniqueNodeIds = [
    ...new Set(normalizedByInput.map((entry) => entry.normalizedNodeId).filter(isValidApnsNodeId)),
  ];
  if (uniqueNodeIds.length === 0) {
    return [];
  }
  const context = captureOpenClawStateWorkerContext(apnsStateDatabaseOptions(baseDir));
  const registrations = await executeOpenClawStateWorker(context, {
    type: "apns.registrations.read",
    input: uniqueNodeIds,
  });
  return normalizedByInput.flatMap(({ nodeId, normalizedNodeId }) => {
    const registration = registrations.get(normalizedNodeId);
    return registration ? [{ nodeId, registration }] : [];
  });
}

/** Clears a registration only if storage still contains the caller's observed value. */
export async function clearApnsRegistrationIfCurrent(params: {
  nodeId: string;
  registration: ApnsRegistration;
  baseDir?: string;
}): Promise<boolean> {
  const normalizedNodeId = normalizeApnsNodeId(params.nodeId);
  if (!normalizedNodeId) {
    return false;
  }
  const context = captureOpenClawStateWorkerContext(apnsStateDatabaseOptions(params.baseDir));
  const input = {
    nodeId: normalizedNodeId,
    registration: { ...params.registration },
    nowMs: Date.now(),
  };
  return executeOpenClawStateWorker(context, { type: "apns.registration.clearIfCurrent", input });
}
