import {
  alternateConnectionTreeItem as alternateConnection,
  alternateConnectionId,
  alternateConnectionUrl,
  demoConnectionTreeItem as connection,
  demoDatabaseTreeItem as database,
  demoAssociationText,
  demoConnectionId,
} from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";
import { createScratchpad } from "../../journeys/scratchpad";
import { SCHEMAS_TREE_ITEM } from "../../pages/WorkbenchTreeLabels";

/*
 * Every column the table has, in catalogue order, qualified by the relation. Named at both ends
 * rather than one by one: what this proves is that a dragged table becomes a whole projection, and
 * a list of thirteen column names would fail whenever the fixture gained a fourteenth.
 */
const productProjection =
  /^SELECT\s+product\.id,\s+product\.name,[\s\S]*product\.attributes,\s+product\.supplier_payload,\s+product\.tags,[\s\S]*FROM\s+shop\.product AS product;\s*$/u;

test.describe("SQL authoring", () => {
  test("formats and authors an ordinary SQL document through its Document Association", async ({
    vscode,
    workbench,
    sqlEditor,
  }) => {
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
      await sqlEditor.associateDocumentAutomatically(demoAssociationText);
      await sqlEditor.requestCompletion();
      await expect(sqlEditor.suggestion(/^product$/)).toBeVisible({ timeout: 5_000 });
      await sqlEditor.dismissCompletion();
    });

    await test.step("compose from the Document Association into an ordinary SQL document", async () => {
      await vscode.openSqlDocument("");
      await sqlEditor.associateDocumentAutomatically(demoAssociationText);
      await workbench.tree.scrollToTop();
      const schema = await workbench.tree.expandPath([
        connection,
        database,
        SCHEMAS_TREE_ITEM,
        /^shop$/,
      ]);
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
      await sqlEditor.associateDocumentAutomatically(demoAssociationText);
      const schema = await workbench.tree.expandPath([
        connection,
        database,
        SCHEMAS_TREE_ITEM,
        /^shop$/,
      ]);
      const product = await workbench.tree.findChild(schema, /^product$/);
      await workbench.tree.expandItem(product, /^product$/);
      const name = await workbench.tree.findChild(product, /^name\s*text$/u);
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
      await sqlEditor.associateDocumentAutomatically(demoAssociationText);
      const schema = await workbench.tree.expandPath([
        connection,
        database,
        SCHEMAS_TREE_ITEM,
        /^shop$/,
      ]);
      const product = await workbench.tree.findChild(schema, /^product$/);
      await workbench.dragTreeItemToTextEditor(product, sqlEditor.editor, true);
      await expect
        .poll(() => sqlEditor.snapshot())
        .toMatchObject({
          text: expect.stringMatching(
            /FROM\s+shop\.order_line\s+JOIN shop\.product AS product ON order_line\.product_id = product\.id;/u,
          ),
        });

      await vscode.openSqlDocument("SELECT product.id FROM shop.product;");
      await sqlEditor.associateDocumentAutomatically(demoAssociationText);
      const brandSchema = await workbench.tree.expandPath([
        connection,
        database,
        SCHEMAS_TREE_ITEM,
        /^shop$/,
      ]);
      const brand = await workbench.tree.findChild(brandSchema, /^brand$/);
      await workbench.dragTreeItemToTextEditor(brand, sqlEditor.editor, true);
      await expect
        .poll(() => sqlEditor.snapshot())
        .toMatchObject({
          text: expect.stringMatching(
            /FROM\s+shop\.product\s+LEFT JOIN shop\.brand AS brand ON product\.brand_id = brand\.id;/u,
          ),
        });
    });

    await test.step("join through a mapping table when no direct foreign key exists", async () => {
      await vscode.openSqlDocument("SELECT product.id FROM shop.product;");
      await sqlEditor.associateDocumentAutomatically(demoAssociationText);
      const schema = await workbench.tree.expandPath([
        connection,
        database,
        SCHEMAS_TREE_ITEM,
        /^shop$/,
      ]);
      const customer = await workbench.tree.findChild(schema, /^customer$/);
      await workbench.dragTreeItemToTextEditor(customer, sqlEditor.editor, true);
      await expect
        .poll(() => sqlEditor.snapshot())
        .toMatchObject({
          // shop.order_line carries a key to each side, so the shortest path runs through it.
          text: expect.stringMatching(
            /FROM\s+shop\.product\s+LEFT JOIN shop\.order_line AS order_line ON product\.id = order_line\.product_id\s+LEFT JOIN shop\.customer AS customer ON order_line\.customer_id = customer\.id;/u,
          ),
        });
    });

    await test.step("choose one foreign key when several JOINs are valid", async () => {
      await vscode.openSqlDocument("SELECT sales_order.id FROM shop.sales_order;");
      await sqlEditor.associateDocumentAutomatically(demoAssociationText);
      const schema = await workbench.tree.expandPath([
        connection,
        database,
        SCHEMAS_TREE_ITEM,
        /^shop$/,
      ]);
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
      await workbench.quickInput.chooseAndClose(/sales_order\.billing_address_id → address\.id/u);
      await expect
        .poll(() => sqlEditor.snapshot())
        .toMatchObject({
          text: expect.stringMatching(
            /JOIN\s+shop\.address AS address ON sales_order\.billing_address_id = address\.id/u,
          ),
        });
    });

    await test.step("compose the targeted Statement when another Statement is invalid", async () => {
      await vscode.openSqlDocument("SELECT product.id FROM shop.product;\nSELECT broken FROM;");
      await sqlEditor.associateDocumentAutomatically(demoAssociationText);
      const schema = await workbench.tree.expandPath([
        connection,
        database,
        SCHEMAS_TREE_ITEM,
        /^shop$/,
      ]);
      const brand = await workbench.tree.findChild(schema, /^brand$/);
      await workbench.dragTreeItemToTextEditor(brand, sqlEditor.editor, true);
      await expect
        .poll(() => sqlEditor.snapshot())
        .toMatchObject({
          text: expect.stringMatching(
            /FROM\s+shop\.product\s+LEFT JOIN shop\.brand AS brand ON product\.brand_id = brand\.id;\s*SELECT broken FROM;/u,
          ),
        });
    });
  });

  test("composes a Scratchpad query from its persisted Association", async ({
    workbench,
    notebook,
    vscode,
  }) => {
    await createScratchpad(workbench, notebook, demoAssociationText);

    await workbench.tree.scrollToTop();
    const schema = await workbench.tree.expandPath([
      connection,
      database,
      SCHEMAS_TREE_ITEM,
      /^shop$/,
    ]);
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

    await test.step("keep completion on the Association when another Connection is connected", async () => {
      try {
        await workbench.tree.scrollToTop();
        await workbench.addConnection(alternateConnectionUrl, alternateConnection);
        await expect
          .poll(() =>
            vscode
              .inspectWorkbenchState()
              .then(({ connection }) => connection.connectedConnectionIds.sort()),
          )
          .toEqual([alternateConnectionId, demoConnectionId].sort());
        const completion = await notebook.addCodeCell();
        await notebook.typeInCell(completion, "SELECT * FROM shop.pro");
        await notebook.requestCompletion(completion);
        await expect(notebook.suggestion(/^product$/)).toBeVisible({ timeout: 5_000 });
        await notebook.dismissCompletion();
      } finally {
        await vscode.removeConnection(alternateConnectionId);
        await workbench.tree.expectItemAbsent(alternateConnection);
      }
    });
  });
});
