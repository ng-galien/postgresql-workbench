import {
  demoConnectionTreeItem as connection,
  demoDatabaseTreeItem as database,
  demoConnectionUrl,
  loopbackConnectionId,
  loopbackConnectionTreeItem,
  loopbackConnectionUrl,
} from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";
import { SCHEMAS_TREE_ITEM } from "../../pages/WorkbenchTreeLabels";

test.describe("Scratchpad Association", () => {
  test("creates an unassociated Scratchpad when a multiple-Connection choice is cancelled", async ({
    workbench,
    notebook,
    vscode,
  }) => {
    await workbench.ensureConnection(demoConnectionUrl, connection);
    await workbench.addConnection(loopbackConnectionUrl, loopbackConnectionTreeItem);
    let filterApplied = false;
    try {
      await test.step("keep equal database names inside their exact Connection branch", async () => {
        const loopbackDatabase = await workbench.tree.expandPath([
          loopbackConnectionTreeItem,
          database,
        ]);
        const loopbackSources = await workbench.tree.findChild(loopbackDatabase, SCHEMAS_TREE_ITEM);
        await expect(loopbackSources).toContainText("available", { timeout: 30_000 });

        const localDatabase = await workbench.tree.expandPath([connection, database]);
        const localSources = await workbench.tree.findChild(localDatabase, SCHEMAS_TREE_ITEM);
        await expect(localSources).toContainText("available");
        await workbench.expectFreshIndexRuntime({ connectionId: loopbackConnectionId });
      });

      await workbench.scratchpads.create();
      await expect(workbench.quickInput.input).toHaveAttribute(
        "placeholder",
        "Choose a Connection",
      );
      await workbench.quickInput.cancel();

      await notebook.activateLatestScratchpad();
      await expect(notebook.cells).toHaveCount(1, { timeout: 5_000 });
      await expect(notebook.cell(0)).toContainText("Choose a Connection");
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
      await vscode.removeConnection(loopbackConnectionId);
    }
    await workbench.tree.expectItemAbsent(loopbackConnectionTreeItem);
  });
});
