import {
  demoConnectionTreeItem as connection,
  demoDatabaseTreeItem as database,
  demoAssociationText,
} from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";
import { createScratchpad } from "../../journeys/scratchpad";
import { DataViewPage } from "../../pages/DataViewPage";
import { SCHEMAS_TREE_ITEM } from "../../pages/WorkbenchTreeLabels";

/**
 * That the Data View opens in VS Code and draws the rows the database answered — and no more than
 * that. Everything the grid then does, and every rule about what it shows, is proven against a
 * real PostgreSQL in packages/shell/tests, where a journey costs a second rather than a minute.
 * What only this lane can prove is that the view reaches the webview and the host answers it
 * across the wire.
 */
test.describe("Data View", () => {
  test("opens on a table and draws its rows", async ({ vscode, workbench }) => {
    await workbench.tree.scrollToTop();
    const schema = await workbench.tree.expandPath([
      connection,
      database,
      SCHEMAS_TREE_ITEM,
      /^shop$/,
    ]);
    const table = await workbench.tree.findChild(schema, /^brand$/);
    await table.click();
    await vscode.executeCommand("postgresql-workbench.openDataView");

    const dataView = new DataViewPage(() => vscode.page);
    await dataView.waitUntilOpen();

    // Nothing went wrong on the way: a view that failed says so in a band across its top.
    await expect(dataView.failure).toHaveCount(0);

    // The columns the table has, and the rows the database answered with.
    await expect(dataView.headers.first()).toBeVisible();
    expect(await dataView.headers.count()).toBeGreaterThan(1);
    await expect(dataView.rows.first()).toBeVisible();
    await expect(dataView.cellsWithText("Fumoir Atlantique").first()).toBeVisible();

    // And the line above the rows says how many there are, beside the controls that walk them.
    await expect(dataView.rowsLine).toBeVisible();
    await expect(dataView.rowCount).toHaveText(/^\d/u);
    await expect(dataView.gutter.first()).toHaveText("1");
  });

  test("carries a Scratchpad result over into a Data View", async ({
    vscode,
    workbench,
    notebook,
  }) => {
    await createScratchpad(workbench, notebook, demoAssociationText);
    const code = notebook.cell(0);
    await notebook.typeInCell(code, "SELECT id, name FROM shop.brand ORDER BY id");
    await notebook.executeCode(code);

    const result = await notebook.resultFrame("Fumoir Atlantique");
    await result.getByRole("button", { name: "Open in Data View" }).click();

    const dataView = new DataViewPage(() => vscode.page);
    await dataView.waitUntilOpen();
    await expect(dataView.failure).toHaveCount(0);
    await expect(dataView.cellsWithText("Fumoir Atlantique").first()).toBeVisible();

    /*
     * The badge names the table the rows come from, and taking it out of the query is done there.
     * The statement itself is on the editor tab: repeated beside the badge it only cut itself off.
     */
    await expect(dataView.tableBadges).toHaveText([/^shop\.\s*brand$/u]);
    await expect(dataView.sourceTitle).toHaveCount(0);
  });
});
