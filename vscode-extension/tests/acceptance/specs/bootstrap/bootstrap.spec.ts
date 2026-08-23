import { expect, test } from "../../fixtures/bootstrapTest";
import {
  demoConnexionTreeItem as connexion,
  demoDatabaseTreeItem as database,
  demoConnectionId,
  demoConnectionUrl,
} from "../../fixtures/demoDatabase";
import { startWorkbench } from "../../journeys/startup";

/**
 * The startup sequence, in the order a first-time workbench lives it. A VS Code instance that is
 * restarted keeps what this establishes, which is why every other lane may assume it.
 */
test("starts, configures its first Connexion, and indexes the database behind it", async ({
  vscode,
  workbench,
}) => {
  await test.step("open the extension and its view", async () => {
    await expect(
      vscode.page.getByLabel("PostgreSQL Workbench", { exact: true }).first(),
    ).toBeVisible({ timeout: 5_000 });
  });

  await test.step("start with no Connexion configured, and offer to add one", async () => {
    const state = await vscode.inspectWorkbenchState();
    expect(state.connection.connectedServerIds).toEqual([]);
    await expect(await workbench.tree.findItem(/^(Add an existing server|Add Server)/)).toBeVisible(
      {
        timeout: 5_000,
      },
    );
  });

  await test.step("live the startup sequence every other lane depends on", async () => {
    // The very sequence the fixtures run: this scenario is what proves it works from nothing.
    await startWorkbench(workbench, vscode.inspectWorkbenchState, {
      connectionUrl: demoConnectionUrl,
      connectionId: demoConnectionId,
      server: connexion,
      database,
    });
  });

  await test.step("leave a connected Connexion and a published index behind", async () => {
    const state = await vscode.inspectWorkbenchState();
    expect(state.connection.connectedServerIds).toContain(demoConnectionId);
    const runtime = await workbench.expectFreshIndexRuntime({
      database,
      serverId: demoConnectionId,
    });
    expect(runtime.serverId).toBe(demoConnectionId);
  });
});
