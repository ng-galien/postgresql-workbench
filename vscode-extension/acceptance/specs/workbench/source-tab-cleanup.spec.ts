import { demoConnectionUrl } from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";

const server = /postgres@localhost:5434/;
const database = /^demo/;

test.describe("Workbench virtual source cleanup", () => {
  test("closes a stale virtual source after reload instead of showing a missing file", async ({
    workbench,
    cockpit,
    vscode,
  }) => {
    await workbench.ensureServer(demoConnectionUrl, server);
    await workbench.ensureActiveDatabaseIndexed(server, database);
    await workbench.openCockpit();
    await cockpit.waitUntilOpen();
    await workbench.tree.expandPath([server, database, /^Sources/, /^shop/]);
    await workbench.tree.collapse(/^shop/);
    await workbench.tree.expand(/^shop/);
    await workbench.tree.select(/^address/);
    await expect(cockpit.node("address")).toHaveAttribute("data-graph-role", "focus", {
      timeout: 5_000,
    });
    await cockpit.openIndexedDefinition("address");

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
