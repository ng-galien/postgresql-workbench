/**
 * Debugging PL/pgSQL from VS Code: turning a routine or a SQL call into a launch configuration,
 * driving the session, showing its results, and recovering the sessions PostgreSQL left behind.
 * This file is the module's public surface — everything else under `debug/` is internal.
 */

export {
  buildRoutineArgs,
  buildRoutineTarget,
  configNameFromRoutine,
  configNameFromSql,
  resolveDebugConfiguration,
} from "./launchConfiguration.js";
export { manageDebugSessions } from "./orphanSessionsUi.js";
export { DEBUG_RESULTS_VIEW_ID, DebugResultsViewProvider } from "./resultsView.js";
