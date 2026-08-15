import {
  demoDatabaseTreeItem as database,
  demoConnectionUrl,
  demoConnexionTreeItem as server,
} from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";

test.describe("Workbench indexing feedback", () => {
  test("keeps the previous snapshot visible through refresh, cancellation, and retry", async ({
    workbench,
  }) => {
    await workbench.ensureServer(demoConnectionUrl, server);
    await workbench.expectActiveDatabaseIndexed(server, database);
    const activeDatabase = await workbench.tree.expandPath([server, database]);
    const sources = await workbench.tree.findChild(activeDatabase, /^Sources/);
    await workbench.tree.expandItem(sources, /^Sources/);
    const schema = await workbench.tree.findChild(sources, /^shop/);
    await workbench.tree.expandItem(schema, /^shop/);
    const product = await workbench.tree.findChild(schema, /^product(?:\s|$)/);
    await expect(product).toBeVisible({ timeout: 5_000 });

    await test.step("show the refresh phase while retaining the previous snapshot", async () => {
      await workbench.tree.clickHeaderAction(/Reindex Active Database/i);
      await expect(sources).toContainText(/refreshing.*reading catalog/i, { timeout: 5_000 });
      await expect(activeDatabase).toContainText(/active.*refreshing/i);
      await expect(sources).toHaveAccessibleName(
        /Sources, demo, refreshing, reading catalog, previous snapshot available/i,
      );
      const refreshingSchema = await workbench.tree.expandPath([
        server,
        database,
        /^Sources/,
        /^shop/,
      ]);
      const refreshingProduct = await workbench.tree.findChild(
        refreshingSchema,
        /^product(?:\s|$)/,
      );
      await workbench.tree.hoverItem(refreshingProduct, /^product(?:\s|$)/);
      const openDefinition = workbench.page.getByRole("button", {
        name: "Open PostgreSQL Definition",
      });
      await expect(openDefinition).toBeVisible({ timeout: 5_000 });
      await openDefinition.click();
      const sourceTab = workbench.page.getByRole("tab", { name: /^product(?:, preview)?$/i });
      await expect(sourceTab).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
      await expect(workbench.page.locator(".monaco-editor:visible")).toContainText(
        /CREATE\s+TABLE\s+"shop"\."product"/i,
        { timeout: 5_000 },
      );
    });

    await test.step("cancel from the Sources node without losing the snapshot", async () => {
      await workbench.tree.hoverItem(sources, /^Sources/);
      const cancel = sources.getByRole("button", {
        name: /Cancel Database Indexing/i,
      });
      await expect(cancel).toBeVisible({ timeout: 5_000 });
      await cancel.click();
      await expect(sources).toContainText(/cancelled.*previous snapshot available/i, {
        timeout: 5_000,
      });
      await expect(sources).toHaveAccessibleName(
        /Sources, demo, indexing cancelled, previous snapshot available, select to retry/i,
      );
      await workbench.tree.collapseItem(schema, /^shop/);
      await expect(product).toBeHidden();
      await workbench.tree.expandItem(schema, /^shop/);
      const restoredProduct = await workbench.tree.findChild(schema, /^product(?:\s|$)/);
      await expect(restoredProduct).toBeVisible();
    });

    await test.step("retry with real phase and count feedback", async () => {
      await workbench.tree.clickHeaderAction(/Reindex Active Database/i);
      await expect(sources).toContainText(/refreshing.*reading catalog/i, { timeout: 5_000 });
      await expect(sources).toContainText(/publishing \d+ sources?/i, { timeout: 10_000 });
      await expect(sources).toContainText(/reading \d+ symbols?/i, { timeout: 10_000 });
      await expect(sources).toContainText(/available.*\d+ sources?.*\d+ symbols?/i, {
        timeout: 30_000,
      });
      const availableSchema = await workbench.tree.expandPath([
        server,
        database,
        /^Sources/,
        /^shop/,
      ]);
      await expect(
        await workbench.tree.findChild(availableSchema, /^product(?:\s|$)/),
      ).toBeVisible();
      await expect(
        workbench.page.locator(".notification-toast:visible").filter({
          hasText: /Indexed .* PostgreSQL|PostgreSQL indexing failed/i,
        }),
      ).toHaveCount(0);
    });
  });
});
