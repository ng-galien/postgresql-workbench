/**
 * Debugging PL/pgSQL from VS Code: turning a routine or a SQL call into a launch configuration,
 * driving the session, showing its results, and recovering the sessions PostgreSQL left behind.
 * This file is the module's public surface — everything else under `debug/` is internal.
 */

export {
  DEBUG_LAUNCH_TOKEN_PROPERTY,
  type DebugLaunchDescriptor,
  DebugSessionController,
} from "../../../packages/dap/src/debugger/launch/sessionController.js";
export {
  type DebugSessionInfo,
  enrichDebugSessions,
  listDebugSessions,
} from "../../../packages/dap/src/orphanSessions.js";
export {
  DebugResultStore,
  delimitedHeader,
  delimitedRow,
  resultAsDelimited,
  resultAsJson,
} from "../../../packages/rows/src/capturedResults.js";
export {
  buildRoutineArgs,
  buildRoutineTarget,
  configNameFromRoutine,
  configNameFromSql,
  resolveDebugConfiguration,
} from "./launchConfiguration.js";
export { manageDebugSessions } from "./orphanSessionsUi.js";
export { DEBUG_RESULTS_VIEW_ID, DebugResultsViewProvider } from "./resultsView.js";
