/**
 * Debugging PL/pgSQL from VS Code: driving the session, showing its results, and recovering the
 * sessions PostgreSQL left behind. The launch-configuration resolution itself lives in the
 * debugger's launch contract (packages/dap). This file is the module's public surface —
 * everything else under `debug/` is internal.
 */

export { manageDebugSessions } from "./orphanSessionsUi.js";
export { DEBUG_RESULTS_VIEW_ID, DebugResultsViewProvider } from "./resultsView.js";
