import {
  demoConnexionTreeItem as connexion,
  demoDatabaseTreeItem as database,
  demoConnectionUrl,
  loopbackConnectionId,
  loopbackConnectionUrl,
  loopbackConnexionTreeItem,
} from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";

test.describe("Scratchpad Association", () => {
  test("creates an unassociated Scratchpad when a multiple-Connexion choice is cancelled", async ({
    workbench,
    notebook,
    vscode,
  }) => {
    await workbench.ensureServer(demoConnectionUrl, connexion);
    await workbench.addServer(loopbackConnectionUrl, loopbackConnexionTreeItem);
    let filterApplied = false;
    try {
      await test.step("keep equal database names inside their exact Connexion branch", async () => {
        const loopbackDatabase = await workbench.tree.expandPath([
          loopbackConnexionTreeItem,
          database,
        ]);
        const loopbackSources = await workbench.tree.findChild(loopbackDatabase, /^Sources/);
        await expect(loopbackSources).toContainText("not indexed");

        const localDatabase = await workbench.tree.expandPath([connexion, database]);
        const localSources = await workbench.tree.findChild(localDatabase, /^Sources/);
        await expect(localSources).toContainText("inactive");
      });

      await workbench.scratchpads.create();
      await expect(workbench.quickInput.input).toHaveAttribute("placeholder", "Choose a Connexion");
      await workbench.quickInput.cancel();

      await notebook.activateLatestScratchpad();
      await expect(notebook.cells).toHaveCount(1, { timeout: 5_000 });
      await expect(notebook.cell(0)).toContainText("Choose a Connexion");
      const createdScratchpad = await workbench.scratchpads.active();
      await expect(createdScratchpad).toContainText(/No connection.*AUTO/u);

      await test.step("filter and refresh the dedicated Scratchpads view from its header", async () => {
        await workbench.scratchpads.filter("No connection");
        filterApplied = true;
        await expect(await workbench.scratchpads.active()).toContainText(/No connection.*AUTO/u);
        await workbench.scratchpads.expectOnlyMatching(/No connection/u);
        await workbench.scratchpads.refresh();
        await expect(await workbench.scratchpads.active()).toContainText(/No connection.*AUTO/u);
        await workbench.scratchpads.filter("");
        filterApplied = false;
        await expect(await workbench.scratchpads.active()).toContainText(/No connection.*AUTO/u);
      });
    } finally {
      if (filterApplied) await workbench.scratchpads.filter("").catch(() => {});
      await vscode.removeServer(loopbackConnectionId);
    }
    await workbench.tree.expectItemAbsent(loopbackConnexionTreeItem);
  });
});
