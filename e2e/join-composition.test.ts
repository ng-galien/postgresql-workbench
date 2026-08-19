import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureLocalCodeMonikerWorkspace } from "../packages/catalog/src/localCodeMoniker.js";
import { createCodeMonikerSyntaxParser } from "../packages/sql/src/analysis/codeMonikerSyntax.js";
import type { SyntaxParser } from "../packages/sql/src/analysis/syntaxTree.js";
import { analyzeSqlQuery } from "../packages/sql/src/query/analysis.js";
import { composePostgresSql } from "../packages/sql/src/query/composition.js";
import type { SqlAuthoringForeignKey, SqlAuthoringSnapshot } from "../packages/sql/src/snapshot.js";
import { sqlStatementAtOffset } from "../packages/sql/src/text/sqlLexing.js";

// product(1) —brand_id→ brand(2); product_category(3) —product_id→ product, —category_id→ category(4);
// category —parent_id→ category; address(5) ←billing/shipping— sales_order(6); orphan(7).
// product(1) —brand_id→ brand(2); product_category(3) —product_id→ product, —category_id→ category(4);
// category —parent_id→ category; address(5) ←billing/shipping— sales_order(6); orphan(7).
const foreignKey = (
  sourceTableOid: number,
  sourceColumns: string[],
  targetTableOid: number,
  targetColumns: string[],
  nullable = false,
): SqlAuthoringForeignKey => ({
  sourceTableOid,
  targetTableOid,
  sourceColumns,
  sourceColumnsNullable: sourceColumns.map(() => nullable),
  targetColumns,
  validated: true,
});

const table = (oid: number, name: string, columns: string[]) => ({
  serverId: "demo-server",
  database: "demo",
  schema: "shop",
  oid,
  name,
  kind: "table" as const,
  signature: "",
  parameters: [],
  columns: columns.map((column) => ({ name: column, type: "text" })),
});

const snapshot: SqlAuthoringSnapshot = {
  status: "available",
  serverId: "demo-server",
  database: "demo",
  revision: "r1",
  generation: 1,
  objects: [
    table(1, "product", ["id", "name", "brand_id"]),
    table(2, "brand", ["id", "label"]),
    table(3, "product_category", ["product_id", "category_id"]),
    table(4, "category", ["id", "title", "parent_id"]),
    table(5, "address", ["id", "city"]),
    table(6, "sales_order", ["id", "billing_address_id", "shipping_address_id"]),
    table(7, "orphan", ["id"]),
  ],
  foreignKeys: [
    foreignKey(1, ["brand_id"], 2, ["id"]),
    foreignKey(3, ["product_id"], 1, ["id"]),
    foreignKey(3, ["category_id"], 4, ["id"]),
    foreignKey(4, ["parent_id"], 4, ["id"], true),
    foreignKey(6, ["billing_address_id"], 5, ["id"]),
    foreignKey(6, ["shipping_address_id"], 5, ["id"], true),
  ],
};

describe("JOIN composition through the planner", async () => {
  let parser: SyntaxParser;
  let dispose: () => Promise<void>;

  beforeAll(async () => {
    const workspace = await mkdtemp(join(tmpdir(), "join-composition-"));
    const session = await ensureLocalCodeMonikerWorkspace({
      workspaceRoots: [workspace],
      clientName: "postgresql-workbench-join-composition",
    });
    parser = createCodeMonikerSyntaxParser(session.client);
    dispose = async () => {
      await session.dispose();
      await rm(workspace, { force: true, recursive: true });
    };
  }, 30_000);

  afterAll(async () => {
    await dispose?.();
  });

  /** Composes as the SQL authoring server does: the statement is analyzed, then the engine runs. */
  async function compose(request: Parameters<typeof composePostgresSql>[0]) {
    const statement = sqlStatementAtOffset(request.text, request.offset);
    const analyzed = await analyzeSqlQuery(statement.text, parser);
    return composePostgresSql(
      request,
      snapshot,
      undefined,
      analyzed.status === "ok" ? analyzed.analysis : undefined,
      analyzed.shape,
    );
  }

  const request = (text: string, oid: number, name: string, relationChoice?: number) => ({
    uri: "file:///query.sql",
    text,
    offset: text.length,
    payload: {
      kind: "table" as const,
      serverId: "demo-server",
      database: "demo",
      oid,
      schema: "shop",
      name,
    },
    ...(relationChoice === undefined ? {} : { relationChoice }),
  });

  it("joins through the mapping table and projects only the target's columns", async () => {
    const result = await compose(
      request("SELECT p.id, p.name FROM shop.product AS p", 4, "category"),
    );
    expect(result.status).toBe("edit");
    if (result.status !== "edit") return;
    expect(result.title).toBe("Join shop.category via product_category");
    expect(result.text).toContain("  category.id,\n  category.title,\n  category.parent_id\n");
    expect(result.text).not.toContain("product_category.product_id,");
    expect(result.text).toContain(
      "  shop.product AS p\n  LEFT JOIN shop.product_category AS product_category ON p.id = product_category.product_id\n  LEFT JOIN shop.category AS category ON product_category.category_id = category.id",
    );
  });

  it("keeps WHERE and ORDER BY intact when a JOIN is inserted before them", async () => {
    const result = await compose(
      request(
        "SELECT\n  p.id\nFROM\n  shop.product AS p\nWHERE\n  p.id > 1\nORDER BY\n  p.id DESC",
        2,
        "brand",
      ),
    );
    expect(result.status).toBe("edit");
    if (result.status !== "edit") return;
    expect(result.text).toBe(
      [
        "SELECT",
        "  p.id,",
        "  brand.id,",
        "  brand.label",
        "FROM",
        "  shop.product AS p",
        "  JOIN shop.brand AS brand ON p.brand_id = brand.id",
        "WHERE",
        "  p.id > 1",
        "ORDER BY",
        "  p.id DESC",
        "",
      ].join("\n"),
    );
  });

  it("offers every shortest path when several keys lead to the target, then applies the choice", async () => {
    const first = await compose(request("SELECT o.id FROM shop.sales_order AS o", 5, "address"));
    expect(first.status).toBe("ambiguous");
    if (first.status !== "ambiguous") return;
    expect(first.choices.map((choice) => choice.label)).toEqual([
      "o.billing_address_id → address.id",
      "o.shipping_address_id → address.id",
    ]);
    const chosen = await compose(
      request("SELECT o.id FROM shop.sales_order AS o", 5, "address", 1),
    );
    expect(chosen.status).toBe("edit");
    if (chosen.status !== "edit") return;
    expect(chosen.text).toContain(
      "LEFT JOIN shop.address AS address ON o.shipping_address_id = address.id",
    );
  });
});
