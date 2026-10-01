import { UPDATE_RUN_ID_ENV } from "./update-control-plane-sentinel.js";
import { UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV } from "./update-doctor-result.js";
import { findActiveUpdateRun, getUpdateRun } from "./update-run-reader.js";

/** Resolve actual package Doctor custody; candidate rehearsal strips both selectors. */
export function resolveDoctorUpdateRun(env: NodeJS.ProcessEnv) {
  const runId = env[UPDATE_RUN_ID_ENV]?.trim();
  // Published CLI parents omit the run ID but retain this result channel.
  const run = runId
    ? getUpdateRun(runId, { env })
    : env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]?.trim()
      ? findActiveUpdateRun({ env })
      : undefined;
  return run?.status === "running" ? run : undefined;
}
