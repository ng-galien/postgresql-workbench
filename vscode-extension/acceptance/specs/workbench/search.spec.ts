import { demoConnectionUrl } from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";

const server = /postgres@localhost:5434/;

test.describe("Workbench search", () => {
  test("opens an indexed PostgreSQL definition from the TreeView header", async ({ workbench }) => {
    await workbench.ensureServer(demoConnectionUrl, server);
    await workbench.expectActiveDatabaseIndexed(server, /^demo/);
    await workbench.tree.clickHeaderAction(/Search Database Objects/i);
    await workbench.quickInput.input.fill("shop product table");
    await workbench.quickInput.chooseOption(/shop\.product/i);

    const sourceTab = workbench.page.getByRole("tab", { name: /^product(?:, preview)?$/i });
    await expect(sourceTab).toBeVisible({ timeout: 5_000 });
    await expect(sourceTab).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
    await expect(workbench.page.locator(".monaco-editor:visible")).toContainText(
      /CREATE\s+TABLE\s+"shop"\."product"/i,
      { timeout: 5_000 },
    );
  });
});
