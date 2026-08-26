import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { ensureLocalCodeMonikerWorkspace } from "../packages/catalog/src/localCodeMoniker.js";
import { createCodeMonikerSyntaxParser } from "../packages/sql/src/analysis/codeMonikerSyntax.js";
import { sqlLexicalTokens } from "../packages/sql/src/analysis/lexicalTokens.js";
import type { SyntaxParser } from "../packages/sql/src/analysis/syntaxTree.js";
import {
  postgresSemanticTokens,
  SQL_SEMANTIC_TOKEN_TYPES,
} from "../packages/sql/src/languageServer/features/semanticTokens.js";
import { documentRelations } from "../packages/sql/src/query/relations.js";
import type { SqlAuthoringSnapshot } from "../packages/sql/src/snapshot.js";

describe("SQL authoring semantic tokens", () => {
  let parser: SyntaxParser;
  let dispose: () => Promise<void>;

  beforeAll(async () => {
    const workspace = await mkdtemp(join(tmpdir(), "semantic-tokens-"));
    const session = await ensureLocalCodeMonikerWorkspace({
      workspaceRoots: [workspace],
      clientName: "postgresql-workbench-semantic-tokens",
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

  /** Colors as the server does: the Host reads the relations from the syntax tree first. */
  async function tokensOf(document: TextDocument, tokenSnapshot = snapshot) {
    const source = document.getText();
    const budget = { uri: document.uri, maxDepth: 1_024, maxNodes: 100_000 };
    const { relations } = await documentRelations(parser, source, budget);
    const lexical = await sqlLexicalTokens(
      await parser.parse({ language: "sql", source, ...budget, namedOnly: false }),
      source,
      (slice) => parser.parse({ language: "sql", source: slice, namedOnly: false }),
    );
    return postgresSemanticTokens(document, tokenSnapshot, [], relations, lexical);
  }

  it("distinguishes schemas, tables, views, aliases, and qualified or unqualified columns", async () => {
    const source = [
      "SELECT address.id, city, active_customer.display_name",
      "FROM shop.address AS address",
      "LEFT JOIN shop.customer_address AS customer_address",
      "  ON address.id = customer_address.address_id;",
      "SELECT active_customer.display_name FROM shop.active_customer;",
    ].join("\n");
    const document = TextDocument.create("file:///query.sql", "sql", 1, source);
    const tokens = decode(document, await tokensOf(document));

    expect(tokens).toEqual(
      expect.arrayContaining([
        ["shop", "sqlSchema"],
        ["address", "sqlTable"],
        ["customer_address", "sqlTable"],
        ["active_customer", "sqlView"],
        ["city", "sqlColumn"],
        ["address_id", "sqlColumn"],
        ["display_name", "sqlColumn"],
        ["address", "sqlAlias"],
        ["customer_address", "sqlAlias"],
      ]),
    );
  });

  it("classifies CTEs, calls, parameters, types, named arguments, and windows", async () => {
    const source = [
      "WITH recent_orders AS (",
      "  SELECT so.id, jsonb_build_object('id', so.id) AS payload,",
      "         row_number() OVER order_window AS rn",
      "  FROM shop.sales_order AS so",
      "  WINDOW order_window AS (PARTITION BY so.customer_id ORDER BY so.created_at)",
      ")",
      "SELECT ro.payload, shop.customer_revenue(ro.id),",
      "       coalesce($1::pg_catalog.interval, now())",
      "FROM recent_orders AS ro",
      "WHERE jsonb_path_exists(ro.payload, path => '$.id');",
      "CALL shop.reprice_order($2);",
    ].join("\n");
    const document = TextDocument.create("file:///semantic.sql", "sql", 1, source);
    const tokens = decode(document, await tokensOf(document));

    expect(tokens).toEqual(
      expect.arrayContaining([
        ["recent_orders", "sqlCte"],
        ["sales_order", "sqlTable"],
        ["so", "sqlAlias"],
        ["ro", "sqlAlias"],
        ["payload", "sqlColumn"],
        ["jsonb_build_object", "sqlFunction"],
        ["row_number", "sqlFunction"],
        ["customer_revenue", "sqlFunction"],
        ["coalesce", "sqlFunction"],
        ["now", "sqlFunction"],
        ["jsonb_path_exists", "sqlFunction"],
        ["reprice_order", "sqlProcedure"],
        ["$1", "sqlParameter"],
        ["$2", "sqlParameter"],
        ["path", "sqlParameter"],
        ["pg_catalog", "sqlSchema"],
        ["interval", "sqlType"],
        ["order_window", "sqlWindow"],
      ]),
    );
    expect(tokens).not.toEqual(
      expect.arrayContaining([
        ["'id'", "sqlFunction"],
        ["SELECT", "sqlFunction"],
      ]),
    );
  });

  it("keeps catalog semantics across INSERT, UPDATE, DELETE, and MERGE statements", async () => {
    const source = [
      "INSERT INTO shop.address (id, city) VALUES ($1, upper($2));",
      "UPDATE shop.address AS a SET city = lower(a.city) WHERE a.id = $1;",
      "DELETE FROM shop.customer_address AS ca USING shop.address AS a",
      "WHERE ca.address_id = a.id;",
      "MERGE INTO shop.address AS a USING shop.active_customer AS ac",
      "ON a.id = ac.id WHEN MATCHED THEN UPDATE SET city = ac.display_name;",
    ].join("\n");
    const document = TextDocument.create("file:///dml.sql", "sql", 1, source);
    const tokens = decode(document, await tokensOf(document));

    expect(tokens).toEqual(
      expect.arrayContaining([
        ["address", "sqlTable"],
        ["customer_address", "sqlTable"],
        ["active_customer", "sqlView"],
        ["a", "sqlAlias"],
        ["ca", "sqlAlias"],
        ["ac", "sqlAlias"],
        ["city", "sqlColumn"],
        ["display_name", "sqlColumn"],
        ["upper", "sqlFunction"],
        ["lower", "sqlFunction"],
        ["$1", "sqlParameter"],
      ]),
    );
  });

  it("keeps routines, relations, columns, variables, and types semantic inside a DO block", async () => {
    const source = [
      "DO $workbench$",
      "DECLARE",
      "  v_address_id int4 := (SELECT id FROM shop.address);",
      "BEGIN",
      "  CALL shop.reprice_order(v_address_id);",
      "END",
      "$workbench$;",
    ].join("\n");
    const document = TextDocument.create("file:///routine.sql", "sql", 1, source);
    const tokens = decode(document, await tokensOf(document));

    expect(tokens).toEqual(
      expect.arrayContaining([
        ["address", "sqlTable"],
        ["id", "sqlColumn"],
        ["reprice_order", "sqlProcedure"],
        ["int4", "sqlType"],
        ["v_address_id", "variable"],
      ]),
    );
  });

  it.each([
    'SELECT "multi\nline" FROM shop.address;',
    'SELECT a.id FROM shop.address AS "multi\nline";',
  ])("does not emit a semantic token across lines for quoted SQL: %s", async (source) => {
    const document = TextDocument.create("file:///multiline.sql", "sql", 1, source);
    const tokens = decode(document, await tokensOf(document));
    expect(tokens.every(([text]) => !text.includes("\n"))).toBe(true);
  });

  it("carries what a statement is made of under what its names mean, in one stream", async () => {
    const source = "-- pick\nSELECT address.city, 'x', 10 FROM shop.address AS address;";
    const document = TextDocument.create("file:///both.sql", "sql", 1, source);
    const tokens = decode(document, await tokensOf(document));

    expect(tokens).toEqual(
      expect.arrayContaining([
        ["-- pick", "comment"],
        ["SELECT", "keyword"],
        ["FROM", "keyword"],
        ["'x'", "string"],
        ["10", "number"],
        [",", "punctuation"],
        ["shop", "sqlSchema"],
        ["address", "sqlTable"],
        ["city", "sqlColumn"],
      ]),
    );
  });

  it("colours a statement no Connection can name, which was left black before", async () => {
    const source = "SELECT 'x' FROM nowhere;";
    const document = TextDocument.create("file:///lonely.sql", "sql", 1, source);
    const tokens = decode(document, await tokensOf(document, undefined));

    expect(tokens).toEqual(
      expect.arrayContaining([
        ["SELECT", "keyword"],
        ["'x'", "string"],
        ["FROM", "keyword"],
      ]),
    );
  });
});

const snapshot: SqlAuthoringSnapshot = {
  status: "available",
  connectionId: "demo-connection",
  database: "demo",
  revision: "r1",
  generation: 1,
  objects: [
    {
      connectionId: "demo-connection",
      database: "demo",
      schema: "shop",
      oid: 1,
      name: "address",
      kind: "table",
      signature: "",
      parameters: [],
      columns: [
        { name: "id", type: "integer" },
        { name: "city", type: "text" },
      ],
    },
    {
      connectionId: "demo-connection",
      database: "demo",
      schema: "shop",
      oid: 2,
      name: "customer_address",
      kind: "table",
      signature: "",
      parameters: [],
      columns: [
        { name: "id", type: "integer" },
        { name: "address_id", type: "integer" },
      ],
    },
    {
      connectionId: "demo-connection",
      database: "demo",
      schema: "shop",
      oid: 3,
      name: "active_customer",
      kind: "view",
      signature: "",
      parameters: [],
      columns: [{ name: "display_name", type: "text" }],
    },
    {
      connectionId: "demo-connection",
      database: "demo",
      schema: "shop",
      oid: 4,
      name: "sales_order",
      kind: "table",
      signature: "",
      parameters: [],
      columns: [
        { name: "id", type: "bigint" },
        { name: "customer_id", type: "bigint" },
        { name: "created_at", type: "timestamptz" },
      ],
    },
    {
      connectionId: "demo-connection",
      database: "demo",
      schema: "shop",
      oid: 5,
      name: "customer_revenue",
      kind: "function",
      signature: "customer_revenue(bigint)",
      parameters: [{ name: "customer_id", type: "bigint" }],
      columns: [],
    },
    {
      connectionId: "demo-connection",
      database: "demo",
      schema: "shop",
      oid: 6,
      name: "reprice_order",
      kind: "procedure",
      signature: "reprice_order(bigint)",
      parameters: [{ name: "order_id", type: "bigint" }],
      columns: [],
    },
  ],
  foreignKeys: [],
};

function decode(
  document: TextDocument,
  tokens: { data: number[] },
): Array<[text: string, type: string]> {
  const decoded: Array<[string, string]> = [];
  let line = 0;
  let character = 0;
  for (let index = 0; index < tokens.data.length; index += 5) {
    const deltaLine = tokens.data[index];
    line += deltaLine;
    character = deltaLine === 0 ? character + tokens.data[index + 1] : tokens.data[index + 1];
    const length = tokens.data[index + 2];
    const offset = document.offsetAt({ line, character });
    decoded.push([
      document.getText().slice(offset, offset + length),
      SQL_SEMANTIC_TOKEN_TYPES[tokens.data[index + 3]],
    ]);
  }
  return decoded;
}
