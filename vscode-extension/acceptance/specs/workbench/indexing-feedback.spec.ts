import { demoConnectionUrl } from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";

const server = /postgres@localhost:5434/;
const database = /^demo/;

test.describe("Workbench indexing feedback", () => {
  test("keeps the previous snapshot visible through refresh, cancellation, and retry", async ({
    workbench,
  }) => {
    await workbench.ensureServer(demoConnectionUrl, server);
    await workbench.expectActiveDatabaseIndexed(server, database);
    await workbench.tree.expandPath([server, database, /^Sources/, /^shop/]);

    const sources = workbench.tree.item(/^Sources/);
    const activeDatabase = workbench.tree.item(database);
    const product = workbench.tree.item(/^product(?:\s|$)/);
    await expect(product).toBeVisible({ timeout: 5_000 });

    await test.step("show the refresh phase while retaining the previous snapshot", async () => {
      await workbench.tree.clickHeaderAction(/Reindex Active Database/i);
      await expect(sources).toContainText(/refreshing.*reading catalog/i, { timeout: 5_000 });
      await expect(activeDatabase).toContainText(/active.*refreshing/i);
      await expect(sources).toHaveAccessibleName(
        /Sources, demo, refreshing, reading catalog, previous snapshot available/i,
      );
      await product.hover();
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
      await sources.hover();
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
      await workbench.tree.collapse(/^shop/);
      await expect(product).toBeHidden();
      await workbench.tree.expand(/^shop/);
      await expect(product).toBeVisible();
    });

    await test.step("retry with real phase and count feedback", async () => {
      await workbench.tree.clickHeaderAction(/Reindex Active Database/i);
      await expect(sources).toContainText(/refreshing.*reading catalog/i, { timeout: 5_000 });
      await expect(sources).toContainText(/publishing \d+ sources?/i, { timeout: 10_000 });
      await expect(sources).toContainText(/reading \d+ symbols?/i, { timeout: 10_000 });
      await expect(sources).toContainText(/available.*\d+ sources?.*\d+ symbols?/i, {
        timeout: 30_000,
      });
      await expect(product).toBeVisible();
      await expect(
        workbench.page.locator(".notification-toast:visible").filter({
          hasText: /Indexed .* PostgreSQL|PostgreSQL indexing failed/i,
        }),
      ).toHaveCount(0);
    });
  });
});
