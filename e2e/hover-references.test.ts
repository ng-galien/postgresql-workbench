import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SyntaxParser } from "../packages/sql/src/analysis/syntaxTree.js";
import {
  postgresHoverMarkdown,
  postgresSqlReferenceAt,
  postgresSqlReferences,
} from "../packages/sql/src/languageServer/features/hover.js";
import { REVEAL_SQL_REFERENCE_COMMAND } from "../packages/sql/src/languageServer/protocol.js";
import { documentRelations } from "../packages/sql/src/query/relations.js";
import {
  DEFAULT_SQL_AUTHORING_SETTINGS,
  type SqlAuthoringSnapshot,
} from "../packages/sql/src/snapshot.js";
import { tempWorkspaceParser } from "./codeMonikerRuntime.js";

const snapshot: SqlAuthoringSnapshot = {
  status: "available",
  connectionId: "demo-connection",
  database: "demo",
  revision: "r1",
  generation: 1,
  objects: [],
  foreignKeys: [],
};

function object(overrides: Partial<SqlAuthoringSnapshot["objects"][number]>) {
  return {
    connectionId: snapshot.connectionId,
    database: snapshot.database,
    schema: "shop",
    parameters: [],
    columns: [],
    ...overrides,
  } as SqlAuthoringSnapshot["objects"][number];
}

describe("SQL hover navigation references", () => {
  let parser: SyntaxParser;
  let dispose: () => Promise<void>;

  beforeAll(async () => {
    const runtime = await tempWorkspaceParser("postgresql-workbench-hover-references");
    parser = runtime.parser;
    dispose = runtime.dispose;
  }, 30_000);

  afterAll(async () => {
    await dispose?.();
  });

  function mentionsOf(source: string) {
    return documentRelations(parser, source, {
      uri: "file:///query.sql",
      maxDepth: DEFAULT_SQL_AUTHORING_SETTINGS.syntaxMaxDepth,
      maxNodes: DEFAULT_SQL_AUTHORING_SETTINGS.syntaxMaxNodes,
    });
  }

  async function referencesOf(source: string, current: SqlAuthoringSnapshot) {
    return postgresSqlReferences(source, current, await mentionsOf(source));
  }

  it("resolves aliases per Statement and ignores routine homonyms", async () => {
    const source = [
      "SELECT p.id FROM shop.product AS p;",
      "SELECT p.product_id FROM shop.order_line AS p;",
    ].join("\n");
    const current: SqlAuthoringSnapshot = {
      ...snapshot,
      objects: [
        object({ oid: 99, name: "order_line", kind: "function", signature: "shop.order_line()" }),
        object({
          oid: 1,
          name: "product",
          kind: "table",
          signature: "shop.product",
          columns: [{ name: "id", type: "bigint" }],
        }),
        object({
          oid: 2,
          name: "order_line",
          kind: "table",
          signature: "shop.order_line",
          columns: [{ name: "product_id", type: "bigint" }],
        }),
      ],
    };

    const references = await referencesOf(source, current);
    expect(references.find(({ label }) => label === "shop.product.id")?.target.oid).toBe(1);
    expect(references.find(({ label }) => label === "shop.order_line.product_id")?.target.oid).toBe(
      2,
    );
  });

  it("resolves relations and routines inside an anonymous PL/pgSQL DO block", async () => {
    const source = [
      "DO $workbench$",
      "DECLARE",
      "  v_product_id bigint := (SELECT id FROM shop.product);",
      "BEGIN",
      "  CALL shop.move_inventory(v_product_id);",
      "END",
      "$workbench$;",
    ].join("\n");
    const current: SqlAuthoringSnapshot = {
      ...snapshot,
      objects: [
        object({
          oid: 1,
          name: "product",
          kind: "table",
          signature: "shop.product",
          columns: [{ name: "id", type: "bigint" }],
        }),
        object({
          oid: 2,
          name: "move_inventory",
          kind: "procedure",
          signature: "move_inventory(bigint)",
          parameters: [{ name: "product_id", type: "bigint" }],
        }),
      ],
    };

    const references = await referencesOf(source, current);
    expect(references.find(({ label }) => label === "shop.product")?.target.oid).toBe(1);
    expect(references.find(({ label }) => label === "shop.product.id")?.target.oid).toBe(1);
    expect(references.find(({ label }) => label === "shop.move_inventory")?.target.oid).toBe(2);
  });

  it("answers the reference under an offset with the reveal command link", async () => {
    const source = "SELECT p.id FROM shop.product AS p;";
    const current: SqlAuthoringSnapshot = {
      ...snapshot,
      objects: [
        object({
          oid: 1,
          name: "product",
          kind: "table",
          signature: "shop.product",
          columns: [{ name: "id", type: "bigint" }],
        }),
      ],
    };
    const reference = postgresSqlReferenceAt(
      source,
      current,
      await mentionsOf(source),
      source.indexOf("product") + 2,
    );
    expect(reference?.label).toBe("shop.product");
    const markdown = postgresHoverMarkdown(reference!);
    expect(markdown).toContain("**shop.product**");
    expect(markdown).toContain(`command:${REVEAL_SQL_REFERENCE_COMMAND}?`);
    expect(markdown).toContain("Reveal in Workbench Sources");
    expect(decodeURIComponent(markdown)).toContain('"oid":1');
  });
});
