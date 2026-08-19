import {
  demoDatabaseTreeItem as database,
  demoConnexionTreeItem as server,
} from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";

test.describe("Workbench virtual source cleanup", () => {
  test("closes a stale virtual source after reload instead of showing a missing file", async ({
    workbench,
    vscode,
  }) => {
    await workbench.openIndexedDefinition(server, database, /^shop/, /^address$/);

    const sourceTab = workbench.page.getByRole("tab", { name: "address, preview" });
    await expect(sourceTab).toBeVisible({ timeout: 5_000 });

    await vscode.executeInfrastructureCommand("workbench.action.reloadWindow");
    await expect(sourceTab).toHaveCount(0, { timeout: 30_000 });
    await expect(workbench.page.getByText(/file was not found/i)).toBeHidden({ timeout: 5_000 });
    await expect(workbench.page.getByRole("button", { name: "Create File" })).toBeHidden({
      timeout: 5_000,
    });
  });
});
