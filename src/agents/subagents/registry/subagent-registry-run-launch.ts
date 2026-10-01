import { isDeepStrictEqual } from "node:util";
import { resolvePhysicalSessionStorePath } from "../../../config/sessions/session-store-path.js";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-dispatch.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import {
  normalizeAgentIdStrict,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../../routing/session-key.js";
import { emitSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { normalizeDeliveryContext } from "../../../utils/delivery-context.shared.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import {
  prepareTerminatedCollectorLaunch,
  updateSwarmCollectorCompletion,
} from "../swarm/swarm-collector.js";
import { bindSwarmRunReservation, ownsSwarmRunReservation } from "../swarm/swarm-scheduler.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { subagentRuns, waitForSubagentRetirementPublication } from "./subagent-registry-memory.js";
import {
  SubagentRegistryWriteError,
  assertSubagentRegistryWriteSourceCurrent,
  replaceSubagentRunRecord,
  waitForPendingSubagentKillClaim,
  waitForPendingSubagentRegistryWrites,
} from "./subagent-registry-persistence.js";
import { registerRequiredQueuedSubagent } from "./subagent-registry-queued-registration.js";
import {
  createSubagentRegistrationRecord,
  type RegisterSubagentRunParams,
} from "./subagent-registry-run-launch-record.js";
import { SubagentRecoveryManager } from "./subagent-registry-run-recovery.js";
import type { RegisterSubagentRunOptions, SubagentRunRecord } from "./subagent-registry.types.js";
import {
  compareSubagentRunGeneration,
  latestSubagentRun,
  nextSubagentRunGeneration,
} from "./subagent-run-generation.js";

function resolveSwarmWaitOwnerSessionKeys(
  getRunsForChildSession: (childSessionKey: string) => Iterable<SubagentRunRecord>,
  requesterSessionKey: string,
): string[] {
  const ownerSessionKeys: string[] = [];
  const visited = new Set<string>();
  let currentSessionKey = requesterSessionKey.trim();
  while (currentSessionKey && !visited.has(currentSessionKey)) {
    visited.add(currentSessionKey);
    ownerSessionKeys.push(currentSessionKey);
    const latestOwner = latestSubagentRun(getRunsForChildSession(currentSessionKey));
    currentSessionKey =
      latestOwner?.controllerSessionKey?.trim() || latestOwner?.requesterSessionKey.trim() || "";
  }
  return ownerSessionKeys;
}

/** Owns subagent registration and queued collector launch transitions. */
export class SubagentLaunchManager extends SubagentRecoveryManager {
  private findRunByIdentity(runId: string): SubagentRunRecord | undefined {
    return (
      this.options.runs.get(runId) ??
      [...this.options.runs.values()].find((candidate) => candidate.swarmRunId === runId)
    );
  }

  private async registerRunningSubagent(params: {
    entry: SubagentRunRecord;
    previous: SubagentRunRecord | undefined;
    context: OpenClawStateWorkerContext;
    ownership: ReturnType<typeof subagentRuns.captureRegistrationOwnership>;
    publishAuthority: () => void;
    activate: () => void;
    options: RegisterSubagentRunOptions;
  }): Promise<void> {
    const { entry, previous, context, ownership, options } = params;
    const runId = entry.runId;
    const lifecycleGeneration = entry.execution.lifecycleGeneration;
    const resolver = getGatewayContextResolver(entry);
    const previousState = previous && structuredClone(previous);
    const previousCurrent = () =>
      this.options.runs.get(runId) === previous && isDeepStrictEqual(previous, previousState);
    const originals = new Map<SubagentRunRecord, SubagentRunRecord>();
    const snapshot = new Map([[runId, structuredClone(entry)]]);
    for (const candidate of this.options.getRunsForChildSession(entry.childSessionKey)) {
      if (
        candidate.runId !== runId &&
        compareSubagentRunGeneration(candidate, entry) < 0 &&
        candidate.killReconciliation
      ) {
        const original = structuredClone(candidate);
        originals.set(candidate, original);
        snapshot.set(candidate.runId, {
          ...original,
          killReconciliation: {
            ...original.killReconciliation!,
            supersededAt: Math.min(
              original.killReconciliation?.supersededAt ?? entry.createdAt,
              entry.createdAt,
            ),
          },
        });
      }
    }
    let acknowledged = false;
    let uncertain = false;
    let activated = false;
    const exactEntry = () => this.options.runs.get(runId) === entry;
    const ownsSession = () =>
      !ownership.superseded &&
      (!this.options.runs.has(runId) || exactEntry()) &&
      !Array.from(this.options.getRunsForChildSession(entry.childSessionKey)).some(
        (candidate) => candidate !== entry && compareSubagentRunGeneration(candidate, entry) > 0,
      );
    const assertRegistryCurrent = () => {
      context.admission.assertCurrent();
      if (
        captureOpenClawStateWorkerContext().admission.identity.key !==
          context.admission.identity.key ||
        !lifecycleGeneration ||
        !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)
      ) {
        throw new Error("Subagent registration lost its original registry owner");
      }
    };
    const registryCurrent = () => {
      try {
        assertRegistryCurrent();
        return true;
      } catch {
        return false;
      }
    };
    const observeRetainedRun = () => {
      if (acknowledged && registryCurrent() && exactEntry()) {
        this.options.ensureListener();
        this.options.startSweeper();
      }
    };
    options.retainOwnership?.({
      waitForClaim: () => undefined,
      waitForRetirementPublication: () => waitForSubagentRetirementPublication(entry),
      canLaunch: () => activated && registryCurrent() && exactEntry() && ownsSession(),
      canAcceptLaunch: () =>
        acknowledged &&
        !subagentRuns.isCompletionAuthorityRetired(entry) &&
        registryCurrent() &&
        exactEntry() &&
        ownsSession(),
      canAbortAcceptedRun: () => registryCurrent() && ownsSession(),
      canCleanupSession: () => !uncertain && registryCurrent() && ownsSession() && !exactEntry(),
      canRetireReservation: () => ownsSwarmRunReservation(entry.schedulerSlotId ?? runId, entry),
      settleFailedLaunch: async () => {
        if (uncertain) {
          throw new Error("Subagent registration requires recovery before launch settlement");
        }
      },
    });
    try {
      await this.options.persistAsyncOrThrow(
        context,
        {
          snapshot,
          assertCurrent: () => {
            assertRegistryCurrent();
            ownership.assertCurrent();
            options.assertCurrent?.();
            if (!previousCurrent()) {
              throw new Error("Subagent registration owner changed before commit");
            }
            for (const [candidate, original] of originals) {
              if (
                this.options.runs.get(candidate.runId) !== candidate ||
                !isDeepStrictEqual(candidate, original)
              ) {
                throw new Error("Subagent registration predecessor changed before commit");
              }
            }
          },
          onCommitted: (runIds) => {
            for (const [candidate, original] of originals) {
              if (
                runIds.includes(candidate.runId) &&
                this.options.runs.get(candidate.runId) === candidate &&
                isDeepStrictEqual(candidate, original)
              ) {
                candidate.killReconciliation = snapshot.get(candidate.runId)?.killReconciliation;
              }
            }
            if (!runIds.includes(runId) || !previousCurrent() || ownership.sameRunSuperseded) {
              return;
            }
            assertRegistryCurrent();
            this.options.runs.set(runId, entry);
            acknowledged = true;
            try {
              options.assertPublicationCurrent?.();
              params.publishAuthority();
            } catch (error) {
              subagentRuns.retireCompletionAuthority(entry);
              throw error;
            }
            if (!ownership.superseded) {
              ownership.accept(entry);
            }
          },
        },
        ...snapshot.keys(),
      );
      if (!acknowledged) {
        uncertain = true;
        throw new Error("Subagent registration was superseded before acknowledgement");
      }
      assertRegistryCurrent();
      ownership.assertCurrent();
      options.assertCurrent?.();
      if (
        !exactEntry() ||
        !ownsSession() ||
        entry.killIntent ||
        entry.killReconciliation ||
        getGatewayContextResolver(entry) !== resolver ||
        (resolver && !resolver())
      ) {
        throw new Error("Subagent registration lost its original run owner");
      }
      params.activate();
      activated = true;
    } catch (error) {
      if (error instanceof SubagentRegistryWriteError) {
        uncertain = error.outcome === "unknown" || (error.outcome === "committed" && !acknowledged);
      }
      if (acknowledged && !activated) {
        subagentRuns.retireCompletionAuthority(entry);
      }
      // A committed row still needs terminal observation when its caller cannot launch.
      observeRetainedRun();
      throw error;
    }
  }

  readonly registerSubagentRun = (
    registerParams: RegisterSubagentRunParams,
    options: RegisterSubagentRunOptions = {},
  ): void | Promise<void> => {
    const runId = registerParams.runId.trim();
    const childSessionKey = registerParams.childSessionKey.trim();
    const requesterSessionKey = registerParams.requesterSessionKey.trim();
    if (!runId || !childSessionKey || !requesterSessionKey) {
      return;
    }
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const registrationContext = captureOpenClawStateWorkerContext();
    const pendingWrite = waitForPendingSubagentRegistryWrites(
      [runId],
      registrationContext.admission,
    );
    if (pendingWrite) {
      const captured = { ...registerParams };
      const capturedOptions = { ...options };
      return pendingWrite.then(() => {
        capturedOptions.assertCurrent?.();
        assertSubagentRegistryWriteSourceCurrent(registrationContext);
        if (!isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) {
          throw new Error(
            "Subagent registration lifecycle changed while awaiting its earlier write",
          );
        }
        return this.registerSubagentRun(captured, capturedOptions);
      });
    }
    const cfg = this.options.getRuntimeConfig();
    const now = Date.now();
    const runTimeoutSeconds = registerParams.runTimeoutSeconds ?? 0;
    const waitTimeoutMs = this.options.resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);
    const requesterOrigin = normalizeDeliveryContext(registerParams.requesterOrigin);
    const requesterAgentId = resolveSubagentRequesterAgentId(cfg, registerParams);
    const controllerSessionKey = registerParams.controllerSessionKey?.trim() || requesterSessionKey;
    const keyAgentId = parseAgentSessionKey(childSessionKey)?.agentId;
    const explicitChildAgentId =
      registerParams.childAgentId === undefined
        ? undefined
        : normalizeAgentIdStrict(registerParams.childAgentId);
    if (explicitChildAgentId && !explicitChildAgentId.ok) {
      throw new Error("Subagent registration has an invalid child agent id.");
    }
    if (keyAgentId && explicitChildAgentId && keyAgentId !== explicitChildAgentId.value) {
      throw new Error("Subagent registration child agent disagrees with its session key.");
    }
    const previous = this.options.runs.get(runId);
    const previousGeneration = previous?.generation;
    const previousCreatedAt = previous?.createdAt;
    if (options.reuseAcceptedRun && previous) {
      options.assertCurrent?.();
      if (
        previous.childSessionKey !== childSessionKey ||
        previous.requesterSessionKey !== requesterSessionKey ||
        previous.requesterAgentId !== requesterAgentId ||
        previous.requesterTurnRunId !== (registerParams.requesterTurnRunId?.trim() || undefined) ||
        previous.expectsCompletionMessage !== registerParams.expectsCompletionMessage ||
        Boolean(previous.collect) !== Boolean(registerParams.collect)
      ) {
        throw new Error(
          "Accepted run already has another completion owner; inspect it before retrying.",
        );
      }
      // Admission replay retains the original result, generation, custody, and sole waiter.
      subagentRuns.runWithCompletionAuthority(previous, () => options.assertCurrent?.());
      return;
    }
    const requesterStorePath = previous
      ? previous.requesterStorePath
      : resolvePhysicalSessionStorePath(
          { sessionKey: requesterSessionKey, agentId: requesterAgentId },
          cfg,
        );
    const controllerStorePath = previous
      ? previous.controllerStorePath
      : resolvePhysicalSessionStorePath(
          {
            sessionKey: controllerSessionKey,
            agentId: resolveAgentIdFromSessionKey(controllerSessionKey, requesterAgentId),
          },
          cfg,
        );
    const childAgentId = previous
      ? previous.childAgentId
      : keyAgentId
        ? undefined
        : explicitChildAgentId?.value;
    const queued = registerParams.queued === true;
    const registrationOwnership = subagentRuns.captureRegistrationOwnership(childSessionKey, runId);
    const register = (
      completionAuthority?: Awaited<
        ReturnType<typeof captureOperatorToolGatewayContinuationContext>
      >,
    ): void | Promise<void> => {
      let custodyTransferred = false;
      let pending = false;
      try {
        completionAuthority?.assertCurrent();
        options.assertCurrent?.();
        completionAuthority?.signal.throwIfAborted();
        registrationContext.admission.assertCurrent();
        if (!isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)) {
          throw new Error("Subagent registration lifecycle changed during preparation");
        }
        if (
          this.options.runs.get(runId) !== previous ||
          previous?.generation !== previousGeneration ||
          previous?.createdAt !== previousCreatedAt
        ) {
          throw new Error("Subagent registration owner changed during preparation");
        }
        registrationOwnership.assertCurrent();
        const generation = nextSubagentRunGeneration(
          this.options.getRunsForChildSession(childSessionKey),
          childSessionKey,
        );
        const entry = createSubagentRegistrationRecord(registerParams, {
          now,
          generation,
          lifecycleGeneration,
          requesterAgentId,
          requesterOrigin,
          swarmWaitOwnerSessionKeys:
            registerParams.collect && registerParams.swarmRequesterSessionKey
              ? resolveSwarmWaitOwnerSessionKeys(
                  this.options.getRunsForChildSession,
                  registerParams.swarmRequesterSessionKey,
                )
              : undefined,
        });
        entry.requesterStorePath = requesterStorePath;
        entry.controllerStorePath = controllerStorePath;
        entry.childAgentId = childAgentId;
        bindGatewayContextResolver(entry, registerParams.gatewayContextResolver);
        const bindRegistrationReservation = () => {
          bindSwarmRunReservation(entry.schedulerSlotId ?? runId, entry, () => {
            if (this.options.runs.get(entry.runId) === entry) {
              emitSessionLifecycleEvent({
                sessionKey: entry.childSessionKey,
                reason: "run-capacity",
                scope: "runtime",
              });
            }
          });
        };
        const activateRegistrationLifecycle = () => {
          bindRegistrationReservation();
          subagentRuns.commitOwnership(entry);
          this.options.ensureListener();
          // Session-mode and persistence-recovery runs also need TTL cleanup.
          this.options.startSweeper();
          if (!queued) {
            void this.waitForSubagentCompletion(runId, waitTimeoutMs, entry);
          }
        };
        const publishAuthority = () => {
          if (completionAuthority?.operatorAuthority) {
            subagentRuns.bindCompletionAuthority(entry, completionAuthority);
            custodyTransferred = true;
          }
        };
        if (!queued) {
          pending = true;
          return this.registerRunningSubagent({
            entry,
            previous,
            context: registrationContext,
            ownership: registrationOwnership,
            publishAuthority,
            activate: activateRegistrationLifecycle,
            options: {
              ...options,
              assertCurrent: () => {
                completionAuthority?.assertCurrent();
                completionAuthority?.signal.throwIfAborted();
                options.assertCurrent?.();
              },
            },
          }).finally(() => {
            if (!custodyTransferred) {
              completionAuthority?.release();
            }
            registrationOwnership.release();
          });
        }
        publishAuthority();
        if (!custodyTransferred) {
          completionAuthority?.release();
        }
        this.options.runs.set(runId, entry);
        const killReconciliationSnapshots = this.markOlderKillReconciliationsSuperseded(entry);
        const registration = registerRequiredQueuedSubagent({
          context: registrationContext,
          entry,
          manager: this.options,
          originals: killReconciliationSnapshots,
          bindReservation: bindRegistrationReservation,
          activate: activateRegistrationLifecycle,
          ...options,
        });
        pending = true;
        return registration.finally(registrationOwnership.release);
      } catch (error) {
        if (!custodyTransferred) {
          completionAuthority?.release();
        }
        throw error;
      } finally {
        if (!pending) {
          registrationOwnership.release();
        }
      }
    };
    try {
      const preparation = registerParams.collect
        ? undefined
        : captureOperatorToolGatewayContinuationContext();
      return preparation
        ? preparation.then(register, (error: unknown) => {
            registrationOwnership.release();
            throw error;
          })
        : register();
    } catch (error) {
      registrationOwnership.release();
      throw error;
    }
  };

  readonly startQueuedSubagentRun = (
    runId: string,
    gatewayRunId?: string,
    lifecycleGeneration?: string,
    gatewayContextResolver?: GatewayContextResolver,
  ): boolean => {
    const key = runId.trim();
    const entry = this.findRunByIdentity(key);
    const acceptedLifecycleGeneration = lifecycleGeneration ?? getAgentEventLifecycleGeneration();
    if (
      lifecycleGeneration !== undefined &&
      !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)
    ) {
      return false;
    }
    const lifecycleStarted =
      entry?.execution.status === "running" &&
      typeof entry.execution.startedAt === "number" &&
      entry.swarmLaunchPending === true;
    const provisionalTerminalBeforeAcceptance =
      entry?.swarmLaunchPending === true &&
      typeof entry.execution.endedAt === "number" &&
      entry.collectorCompletion === undefined;
    if (provisionalTerminalBeforeAcceptance) {
      // Cancellation won before Gateway acceptance. The caller must abort the
      // newly accepted run before freezing completion or releasing the FIFO slot.
      return false;
    }
    // Completion clears swarmLaunchPending, but queuedLaunch remains until the
    // delayed acceptance response remaps the durable terminal row.
    const terminalBeforeAcceptance =
      entry?.collectorCompletion !== undefined && entry.queuedLaunch !== undefined;
    if (
      !entry ||
      entry.killIntent ||
      waitForPendingSubagentKillClaim(entry, captureOpenClawStateWorkerContext().admission) ||
      entry.killReconciliation ||
      (!terminalBeforeAcceptance && entry.execution.status !== "queued" && !lifecycleStarted)
    ) {
      return false;
    }
    const nextRunId = gatewayRunId?.trim() || entry.runId;
    const conflicting = this.options.runs.get(nextRunId);
    if (conflicting && conflicting !== entry) {
      throw new Error(`collector gateway run id already exists: ${nextRunId}`);
    }
    const acceptedAt = Date.now();
    const previousRunId = entry.runId;
    const previous = structuredClone(entry);
    const restoreQueuedRun = () => {
      if (previousRunId !== nextRunId) {
        this.options.runs.delete(nextRunId);
      }
      replaceSubagentRunRecord(entry, previous);
      if (previousRunId !== nextRunId) {
        this.options.runs.set(previousRunId, entry);
      }
    };
    entry.swarmRunId ??= previousRunId;
    entry.schedulerSlotId ??= entry.swarmRunId;
    if (previousRunId !== nextRunId) {
      this.options.runs.delete(previousRunId);
      entry.runId = nextRunId;
      this.options.runs.set(nextRunId, entry);
    }
    if (!terminalBeforeAcceptance) {
      // Acceptance is not a lifecycle start; preserve a raced start or leave its clock unset.
      const lifecycleStartedAt =
        entry.execution.status === "running" ? entry.execution.startedAt : undefined;
      entry.execution = {
        ...entry.execution,
        status: "running",
        acceptedAt,
        lifecycleGeneration: acceptedLifecycleGeneration,
        restartRecovery: undefined,
        suppressSessionEffects: undefined,
      };
      if (typeof lifecycleStartedAt === "number") {
        entry.sessionStartedAt ??= lifecycleStartedAt;
        entry.execution.startedAt = lifecycleStartedAt;
      } else {
        delete entry.sessionStartedAt;
        delete entry.execution.startedAt;
      }
    }
    entry.swarmLaunchPending = false;
    entry.queuedLaunch = undefined;
    try {
      this.options.persistOrThrow(previousRunId, nextRunId);
      if (terminalBeforeAcceptance) {
        bindGatewayContextResolver(entry, gatewayContextResolver);
        return true;
      }
    } catch (error) {
      restoreQueuedRun();
      throw error;
    }
    bindGatewayContextResolver(entry, gatewayContextResolver);
    const cfg = this.options.getRuntimeConfig();
    void this.waitForSubagentCompletion(
      nextRunId,
      this.options.resolveSubagentWaitTimeoutMs(cfg, entry.runTimeoutSeconds),
      entry,
    );
    return true;
  };

  readonly failQueuedSubagentRun = (runId: string, error: string): boolean => {
    const key = runId.trim();
    const entry = this.findRunByIdentity(key);
    if (!entry || entry.execution.status !== "queued") {
      return false;
    }
    const snapshot = structuredClone(entry);
    const endedAt = Date.now();
    entry.endedReason = SUBAGENT_ENDED_REASON_ERROR;
    entry.execution = {
      ...entry.execution,
      status: "terminal",
      endedAt,
      outcome: { status: "error", error, endedAt },
    };
    entry.queuedLaunch = undefined;
    entry.collectorLaunchCleanupPending = true;
    entry.completion = { required: false, resultText: error, capturedAt: endedAt };
    updateSwarmCollectorCompletion(entry, this.options.getRuntimeConfig());
    try {
      this.options.persistOrThrow(entry.runId);
    } catch (persistError) {
      replaceSubagentRunRecord(entry, snapshot);
      throw persistError;
    }
    return true;
  };

  readonly settleFailedQueuedSubagentLaunch = (runId: string, error: string): boolean => {
    const entry = this.findRunByIdentity(runId);
    if (!entry?.collect) {
      return false;
    }
    if (typeof entry.execution.endedAt !== "number") {
      return this.failQueuedSubagentRun(runId, error);
    }
    if (entry.collectorCompletion) {
      return true;
    }
    const snapshot = structuredClone(entry);
    prepareTerminatedCollectorLaunch(entry, entry.execution.endedAt, error, () =>
      this.options.getRuntimeConfig(),
    );
    try {
      this.options.persistOrThrow(entry.runId);
    } catch (persistError) {
      replaceSubagentRunRecord(entry, snapshot);
      throw persistError;
    }
    return true;
  };
}
