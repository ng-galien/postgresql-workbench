import type { WorkbenchStateSnapshot } from "../fixtures/vscode";
import type { WorkbenchPage } from "../pages/WorkbenchPage";

/** What a workbench needs before any scenario can run against it. */
export interface WorkbenchStartup {
  connectionUrl: string;
  connectionId: string;
  server: RegExp;
  database: RegExp;
}

/**
 * The startup sequence, in the order a first-time workbench lives it: a Connexion configured and
 * connected, then the index of the database it opens, published and settled. A VS Code instance
 * that is restarted keeps both, so a workbench that already has them only reads the runtime; one
 * that lost them to a window reload lives the sequence again.
 *
 * Every lane starts here, and the bootstrap scenario runs this same path from an empty profile.
 */
export async function startWorkbench(
  workbench: WorkbenchPage,
  inspect: () => Promise<WorkbenchStateSnapshot>,
  startup: WorkbenchStartup,
): Promise<void> {
  let observed = await inspect();
  if (!observed.connection.connectedServerIds.includes(startup.connectionId)) {
    await workbench.ensureServer(startup.connectionUrl, startup.server);
    // Connecting changes what the index says: the decision below needs the state after it.
    observed = await inspect();
  }
  const published = observed.index.states.some(
    (state) =>
      state.status === "available" &&
      state.result !== undefined &&
      state.result.serverId === startup.connectionId &&
      state.result.database.match(startup.database) !== null,
  );
  // Naming the Connexion keeps the wait exact while a scenario holds a second one on the same
  // database. `ensureDatabaseIndexed` ends on the same assertion, so only one of the two runs.
  if (published) {
    await workbench.expectFreshIndexRuntime({
      database: startup.database,
      serverId: startup.connectionId,
    });
  } else {
    await workbench.ensureDatabaseIndexed(startup.server, startup.database);
  }
}
