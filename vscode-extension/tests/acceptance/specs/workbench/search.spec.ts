import { demoProductSearchQuickPickItem } from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";

test.describe("Workbench search", () => {
  test("opens an indexed PostgreSQL definition from the TreeView header", async ({ workbench }) => {
    await workbench.tree.clickHeaderAction(/Search Database Objects/i);
    await workbench.quickInput.fill("shop product table");
    await workbench.quickInput.chooseAndClose(demoProductSearchQuickPickItem);

    const sourceTab = workbench.page.getByRole("tab", { name: /^product(?:, preview)?$/i });
    await expect(sourceTab).toBeVisible({ timeout: 5_000 });
    await expect(sourceTab).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
    await expect(
      workbench.page.locator(".editor-group-container.active .monaco-editor:visible"),
    ).toContainText(/CREATE\s+TABLE\s+"shop"\."product"/i, { timeout: 5_000 });
  });
});
