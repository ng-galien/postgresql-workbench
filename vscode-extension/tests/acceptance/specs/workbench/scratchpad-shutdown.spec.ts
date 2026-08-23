import { demoAssociationText } from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";
import { createScratchpad } from "../../journeys/scratchpad";

// Reloading the window is how a shutdown is observed, and it rebuilds the Workbench Index, so this
// scenario belongs to the index lifecycle lane rather than the one that shares a settled index.
test.describe("Scratchpad shutdown", () => {
  test("rolls back the active Transaction when the extension shuts down", async ({
    demoDatabase,
    workbench,
    notebook,
    vscode,
  }) => {
    const table = "acceptance_scratchpad_shutdown_rollback";
    const scratchpad = await createScratchpad(workbench, notebook, demoAssociationText);
    await workbench.scratchpads.setMode(scratchpad, "MANUAL");

    const work = notebook.cell(0);
    await notebook.typeInCell(work, `CREATE TABLE public.${table}(id integer)`);
    await notebook.executeCode(work);
    await expect(await workbench.scratchpads.transaction(scratchpad, "in progress")).toContainText(
      "1 Statement",
    );
    await vscode.executeCommand("workbench.action.files.saveAll");

    await vscode.executeInfrastructureCommand("workbench.action.reloadWindow");
    await expect
      .poll(async () => (await demoDatabase.inspectTable("public", table)).exists)
      .toBe(false);
  });
});
