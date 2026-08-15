import {
  alternateConnectionId,
  alternateConnectionUrl,
  alternateConnexionTreeItem as alternateServer,
  demoDatabaseTreeItem as database,
  demoAssociationText,
  demoConnectionUrl,
  demoConnexionTreeItem as server,
} from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";
import { createScratchpad } from "../../journeys/scratchpad";

const productProjection =
  /^SELECT\s+id,\s+name,\s+price,\s+stock,\s+sku,\s+brand_id,\s+description,\s+active\s+FROM\s+shop\.product;\s*$/u;

test.describe("SQL authoring", () => {
  test("formats and completes an ordinary SQL document from the active DatabaseContext", async ({
    vscode,
    workbench,
    sqlEditor,
  }) => {
    await workbench.ensureServer(demoConnectionUrl, server);
    await workbench.expectActiveDatabaseIndexed(server, database);

    await test.step("format PostgreSQL SQL consistently through the standard editor action", async () => {
      await vscode.openSqlDocument("select id,name from shop.product where stock>0;");
      await sqlEditor.formatDocument();
      await expect
        .poll(() => sqlEditor.snapshot())
        .toMatchObject({
          languageId: "sql",
          text: "SELECT\n  id,\n  name\nFROM\n  shop.product\nWHERE\n  stock > 0;\n",
        });
      await sqlEditor.formatDocument();
      await expect
        .poll(() => sqlEditor.snapshot())
        .toMatchObject({
          text: "SELECT\n  id,\n  name\nFROM\n  shop.product\nWHERE\n  stock > 0;\n",
        });
    });

    await test.step("complete indexed PostgreSQL objects without catalog introspection", async () => {
      await vscode.openSqlDocument("SELECT * FROM shop.pro");
      await sqlEditor.requestCompletion();
      await expect(sqlEditor.suggestion(/^product$/)).toBeVisible({ timeout: 5_000 });
    });

    await test.step("compose from the active DatabaseContext into an ordinary SQL document", async () => {
      await vscode.openSqlDocument("");
      await workbench.tree.scrollToTop();
      const schema = await workbench.tree.expandPath([server, database, /^Sources/, /^shop$/]);
      const product = await workbench.tree.findChild(schema, /^product$/);
      await workbench.dragTreeItemToTextEditor(product, sqlEditor.editor);
      await expect
        .poll(() => sqlEditor.snapshot())
        .toMatchObject({
          text: expect.stringMatching(productProjection),
        });
    });

    await test.step("derive JOIN and LEFT JOIN from indexed foreign-key nullability", async () => {
      await vscode.openSqlDocument("SELECT order_line.id FROM shop.order_line;");
      const schema = await workbench.tree.expandPath([server, database, /^Sources/, /^shop$/]);
      const product = await workbench.tree.findChild(schema, /^product$/);
      await workbench.dragTreeItemToTextEditor(product, sqlEditor.editor, true);
      await expect
        .poll(() => sqlEditor.snapshot())
        .toMatchObject({
          text: expect.stringMatching(
            /FROM\s+shop\.order_line\s+JOIN shop\.product ON shop\.order_line\.product_id = shop\.product\.id;/u,
          ),
        });

      await vscode.openSqlDocument("SELECT product.id FROM shop.product;");
      const brandSchema = await workbench.tree.expandPath([server, database, /^Sources/, /^shop$/]);
      const brand = await workbench.tree.findChild(brandSchema, /^brand$/);
      await workbench.dragTreeItemToTextEditor(brand, sqlEditor.editor, true);
      await expect
        .poll(() => sqlEditor.snapshot())
        .toMatchObject({
          text: expect.stringMatching(
            /FROM\s+shop\.product\s+LEFT JOIN shop\.brand ON shop\.product\.brand_id = shop\.brand\.id;/u,
          ),
        });
    });
  });

  test("composes a Scratchpad query from its persisted Association", async ({
    workbench,
    notebook,
    vscode,
  }) => {
    await workbench.ensureServer(demoConnectionUrl, server);
    await workbench.expectActiveDatabaseIndexed(server, database);
    await createScratchpad(workbench, notebook, demoAssociationText);

    await workbench.tree.scrollToTop();
    const schema = await workbench.tree.expandPath([server, database, /^Sources/, /^shop$/]);
    const product = await workbench.tree.findChild(schema, /^product$/);
    await workbench.dragTreeItemToTextEditor(product, notebook.cell(0));

    await expect
      .poll(() => notebook.snapshot())
      .toMatchObject({
        cells: [
          {
            languageId: "plpgsql",
            text: expect.stringMatching(productProjection),
          },
        ],
      });

    await test.step("keep completion on the Association when another DatabaseContext becomes active", async () => {
      try {
        await workbench.tree.scrollToTop();
        await workbench.addServer(alternateConnectionUrl, alternateServer);
        const skipDebuggerSetup = workbench.page.getByRole("button", {
          name: "Skip",
          exact: true,
        });
        await expect(skipDebuggerSetup).toBeVisible({ timeout: 5_000 });
        await skipDebuggerSetup.click();
        const completion = await notebook.addCodeCell();
        await notebook.typeInCell(completion, "SELECT * FROM shop.pro");
        await notebook.requestCompletion(completion);
        await expect(notebook.suggestion(/^product$/)).toBeVisible({ timeout: 5_000 });
        await workbench.page.keyboard.press("Escape");
      } finally {
        await vscode.removeServer(alternateConnectionId);
        await expect(workbench.tree.item(alternateServer)).toHaveCount(0);
      }
    });
  });
});
