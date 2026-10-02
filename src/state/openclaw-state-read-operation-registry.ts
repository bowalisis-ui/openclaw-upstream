import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { RestartSentinelReadOperations } from "../infra/restart-sentinel.read.worker-contract.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { createWorkerOperationRegistry } from "./worker-operation-registry.js";

type Operations = RestartSentinelReadOperations;
export type RegisteredStateReadCommand = SqliteWorkerCommand<Operations>;
export type RegisteredStateReadResult = Operations[keyof Operations]["output"];

export const stateReadWorkerRegistry = createWorkerOperationRegistry<Operations, DatabaseSync>({
  restartSentinel: () =>
    import("../infra/restart-sentinel.read.worker.js").then((m) => m.restartSentinelReadOperations),
});

export function prepareRegisteredStateRead<Result>(read: (input: unknown) => Result) {
  return (input: unknown) => {
    const preparation =
      isRecord(input) && isRecord(input.command) && typeof input.command.type === "string"
        ? stateReadWorkerRegistry.prepare(input.command.type)
        : undefined;
    return preparation ? preparation.then(() => read(input)) : read(input);
  };
}
