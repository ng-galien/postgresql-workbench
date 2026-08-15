import {
  demoConnexionTreeItem as connexion,
  demoDatabaseTreeItem as database,
  demoConnectionUrl,
} from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";

test.describe("Acceptance cinematics", () => {
  test("navigates both TreeViews through an exact Connexion branch", async ({ workbench }) => {
    const databaseTree = workbench.page.getByRole("tree", { name: "Workbench" });
    const scratchpadsTree = workbench.page.getByRole("tree", { name: "Scratchpads" });

    await test.step("keep the database tree above the dedicated Scratchpads tree", async () => {
      await expect(databaseTree).toBeVisible();
      await expect(scratchpadsTree).toBeVisible();
      await expect(
        databaseTree.getByRole("treeitem").filter({ hasText: /^Scratchpads$/u }),
      ).toHaveCount(0);
      const databaseBounds = await databaseTree.boundingBox();
      const scratchpadsBounds = await scratchpadsTree.boundingBox();
      expect(databaseBounds).not.toBeNull();
      expect(scratchpadsBounds).not.toBeNull();
      expect(databaseBounds?.y ?? 0).toBeLessThan(scratchpadsBounds?.y ?? 0);
    });

    await test.step("navigate deep rows, virtualized siblings, sticky ancestors, and back to root", async () => {
      await workbench.ensureServer(demoConnectionUrl, connexion);
      await workbench.expectActiveDatabaseIndexed(connexion, database);
      const schema = await workbench.tree.expandPath([connexion, database, /^Sources/, /^shop$/]);
      const address = await workbench.tree.findChild(schema, /^address$/);
      await workbench.tree.expandItem(address, /^address$/);
      await expect(await workbench.tree.findChild(address, /^id/)).toBeVisible();
      await expect(await workbench.tree.findChild(schema, /^product$/)).toBeVisible();
      await expect(await workbench.tree.findItem(connexion)).toContainText("connected");
    });
  });
});
