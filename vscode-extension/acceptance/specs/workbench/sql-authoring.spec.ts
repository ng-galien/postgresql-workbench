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
      await sqlEditor.dismissCompletion();
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

    await test.step("extend an existing projection with an indexed column", async () => {
      await vscode.openSqlDocument("SELECT product.id FROM shop.product;");
      const schema = await workbench.tree.expandPath([server, database, /^Sources/, /^shop$/]);
      const product = await workbench.tree.findChild(schema, /^product$/);
      await workbench.tree.expandItem(product, /^product$/);
      const name = await workbench.tree.findChild(product, /^name\b/u);
      await workbench.dragTreeItemToTextEditor(name, sqlEditor.editor, true);
      await expect
        .poll(() => sqlEditor.snapshot())
        .toMatchObject({
          text: expect.stringMatching(/SELECT\s+product\.id,\s+product\.name\s+FROM/u),
        });
      const text = (await sqlEditor.snapshot())?.text ?? "";
      expect(text.match(/product\.name/gu)).toHaveLength(1);
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

    await test.step("start another SELECT when no direct foreign key can form a JOIN", async () => {
      await vscode.openSqlDocument("SELECT product.id FROM shop.product;");
      const schema = await workbench.tree.expandPath([server, database, /^Sources/, /^shop$/]);
      const customer = await workbench.tree.findChild(schema, /^customer$/);
      await workbench.dragTreeItemToTextEditor(customer, sqlEditor.editor, true);
      await expect
        .poll(() => sqlEditor.snapshot())
        .toMatchObject({
          text: expect.stringMatching(
            /FROM\s+shop\.product;\s*SELECT\s+id,\s+name,\s+loyalty_points\s+FROM\s+shop\.customer;/u,
          ),
        });
    });

    await test.step("choose one foreign key when several JOINs are valid", async () => {
      await vscode.openSqlDocument("SELECT sales_order.id FROM shop.sales_order;");
      const schema = await workbench.tree.expandPath([server, database, /^Sources/, /^shop$/]);
      const address = await workbench.tree.findChild(schema, /^address$/);
      await workbench.dragTreeItemToTextEditor(address, sqlEditor.editor, true);
      await expect(workbench.page.locator(".quick-input-title:visible")).toHaveText(
        "Choose the foreign key for this JOIN",
        { timeout: 5_000 },
      );
      await expect(workbench.quickInput.input).toHaveAttribute(
        "placeholder",
        "No JOIN is added until you choose",
      );
      await workbench.quickInput.chooseAndClose(
        /JOIN via sales_order\(billing_address_id\).*address\(id\)/u,
      );
      await expect
        .poll(() => sqlEditor.snapshot())
        .toMatchObject({
          text: expect.stringMatching(
            /JOIN\s+shop\.address ON shop\.sales_order\.billing_address_id = shop\.address\.id/u,
          ),
        });
    });

    await test.step("compose the targeted Statement when another Statement is invalid", async () => {
      await vscode.openSqlDocument("SELECT product.id FROM shop.product;\nSELECT broken FROM;");
      const schema = await workbench.tree.expandPath([server, database, /^Sources/, /^shop$/]);
      const brand = await workbench.tree.findChild(schema, /^brand$/);
      await workbench.dragTreeItemToTextEditor(brand, sqlEditor.editor, true);
      await expect
        .poll(() => sqlEditor.snapshot())
        .toMatchObject({
          text: expect.stringMatching(
            /FROM\s+shop\.product\s+LEFT JOIN shop\.brand ON shop\.product\.brand_id = shop\.brand\.id;\s*SELECT broken FROM;/u,
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
        await expect
          .poll(() =>
            vscode.inspectWorkbenchState().then(({ connection }) => connection.activeServerId),
          )
          .toBe(alternateConnectionId);
        const debuggerSetup = workbench.page.locator(".notification-toast:visible").filter({
          hasText: /pldbgapi extension not installed.*Install now/i,
        });
        const skipDebuggerSetup = debuggerSetup.getByRole("button", {
          name: "Skip",
          exact: true,
        });
        await expect(skipDebuggerSetup).toBeVisible({ timeout: 5_000 });
        await skipDebuggerSetup.click();
        await expect(debuggerSetup).toHaveCount(0, { timeout: 5_000 });
        const completion = await notebook.addCodeCell();
        await notebook.typeInCell(completion, "SELECT * FROM shop.pro");
        await notebook.requestCompletion(completion);
        await expect(notebook.suggestion(/^product$/)).toBeVisible({ timeout: 5_000 });
        await notebook.dismissCompletion();
      } finally {
        await vscode.removeServer(alternateConnectionId);
        await workbench.tree.expectItemAbsent(alternateServer);
      }
    });
  });
});
