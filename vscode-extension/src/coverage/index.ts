/**
 * pgTAP coverage: running tests with coverage, mapping the executed lines back to the routine
 * source, and reporting them to VS Code. This file is the module's public surface — everything
 * else under `coverage/` is internal.
 */
export { openCoverageClient } from "./client.js";
export type { PgTapCoverageSnapshot } from "./runProfile.js";
export { PgTapTestController } from "./testController.js";
