import { resolveDoctorUpdateRun } from "./update-doctor-run.js";
import { recordUpdateRunStep } from "./update-run-ledger.js";

const RETIREMENT_STEP = "finalize:doctor:model-retirement";

export function hasDeferredUpdateModelRetirement(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    resolveDoctorUpdateRun(env)?.steps.some(
      (step) => step.step === RETIREMENT_STEP && step.status === "skipped",
    ) ?? false
  );
}

/** Completion is published by Doctor only after its repaired config is durable. */
export function recordUpdateModelRetirement(
  status: "deferred" | "completed",
  env: NodeJS.ProcessEnv = process.env,
): void {
  const run = resolveDoctorUpdateRun(env);
  if (
    !run ||
    (status === "completed" &&
      !run.steps.some((step) => step.step === RETIREMENT_STEP && step.status === "skipped"))
  ) {
    return;
  }
  const detail =
    status === "deferred"
      ? "Model retirement repair deferred until plugin convergence."
      : "Deferred model retirement repair completed after plugin convergence.";
  recordUpdateRunStep(
    run.runId,
    {
      step: RETIREMENT_STEP,
      status: status === "deferred" ? "skipped" : "completed",
      endedAtMs: Date.now(),
      detail,
    },
    { env },
  );
  // Completion must follow the package warnings in the bounded status history.
  recordUpdateRunStep(
    run.runId,
    {
      step: `warning:${RETIREMENT_STEP}${status === "deferred" ? ":deferred" : ""}`,
      status: "completed",
      detail,
    },
    { env },
  );
}
