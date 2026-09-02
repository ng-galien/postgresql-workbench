import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { PostgresSyntaxExpectationProvider } from "../packages/sql/src/analysis/syntaxExpectations.js";
import type { SyntaxParser } from "../packages/sql/src/analysis/syntaxTree.js";
import { postgresSyntaxExpectationProvider } from "../packages/sql/src/authoring/postgresSyntaxPredictor.js";
import { answerSyntaxRequest } from "../packages/sql/src/languageServer/answerSyntax.js";
import { planSqlAuthoringCompletionRequest } from "../packages/sql/src/languageServer/completionRequest.js";
import {
  composeSqlAuthoringRequest,
  sqlAuthoringEditStillApplies,
} from "../packages/sql/src/languageServer/composeRequest.js";
import { projectedSqlDocument } from "../packages/sql/src/languageServer/documentProjection.js";
import { postgresCompletionList } from "../packages/sql/src/languageServer/features/completion.js";
import type { SqlAuthoringDocumentContext } from "../packages/sql/src/languageServer/protocol.js";
import { analyzeSqlQuery } from "../packages/sql/src/query/analysis.js";
import { composePostgresSql } from "../packages/sql/src/query/composition.js";
import {
  parseSqlAuthoringDrag,
  type SqlAuthoringSnapshot,
  serializeSqlAuthoringDrag,
} from "../packages/sql/src/snapshot.js";
import { formatPostgresSql } from "../packages/sql/src/text/format.js";
import {
  scanPostgresSql,
  sqlStatementAtOffset,
  sqlStatementSlices,
} from "../packages/sql/src/text/sqlLexing.js";
import { tempWorkspaceParser } from "./codeMonikerRuntime.js";

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
      name: "product",
      kind: "table",
      signature: "",
      parameters: [],
      columns: [
        { name: "id", type: "integer" },
        { name: "name", type: "text" },
      ],
    },
    {
      connectionId: "demo-connection",
      database: "demo",
      schema: "shop",
      oid: 3,
      name: "find_product",
      kind: "function",
      signature: "p_id integer",
      parameters: [{ name: "p_id", type: "integer" }],
      columns: [],
    },
    {
      connectionId: "demo-connection",
      database: "demo",
      schema: "shop",
      oid: 2,
      name: "order_line",
      kind: "table",
      signature: "",
      parameters: [],
      columns: [
        { name: "id", type: "integer" },
        { name: "product_id", type: "integer" },
      ],
    },
    {
      connectionId: "demo-connection",
      database: "demo",
      schema: "shop",
      oid: 40,
      name: "customer",
      kind: "table",
      signature: "",
      parameters: [],
      columns: [
        { name: "id", type: "integer" },
        { name: "name", type: "text" },
        { name: "loyalty_points", type: "integer" },
      ],
    },
  ],
  foreignKeys: [
    {
      sourceTableOid: 2,
      targetTableOid: 1,
      sourceColumns: ["product_id"],
      sourceColumnsNullable: [false],
      targetColumns: ["id"],
      validated: true,
    },
  ],
};

describe("SQL authoring language contracts", async () => {
  let codeMoniker: {
    parser: SyntaxParser;
    dispose(): Promise<void>;
  };
  const expectations: PostgresSyntaxExpectationProvider = postgresSyntaxExpectationProvider;

  beforeAll(async () => {
    codeMoniker = await tempWorkspaceParser("postgresql-workbench-sql-authoring");
  }, 30_000);

  afterAll(async () => {
    await codeMoniker?.dispose();
  });

  /** Composes as the SQL authoring server does: the statement is analyzed, then the engine runs. */
  async function compose(
    request: Parameters<typeof composePostgresSql>[0],
    composeSnapshot: Parameters<typeof composePostgresSql>[1] = snapshot,
    settings?: Parameters<typeof composePostgresSql>[2],
  ): Promise<ReturnType<typeof composePostgresSql>> {
    const statement = sqlStatementAtOffset(request.text, request.offset);
    const analyzed = await analyzeSqlQuery(statement.text, codeMoniker.parser);
    return composePostgresSql(
      request,
      composeSnapshot,
      settings,
      analyzed.status === "ok" ? analyzed.analysis : undefined,
      analyzed.shape,
    );
  }

  /** Completes through the same syntax-expectation port and autonomous planner as the server. */
  async function complete(
    source: string,
    offset: number,
    completionSnapshot: SqlAuthoringSnapshot = snapshot,
  ) {
    const uri = "file:///completion.sql";
    const settings = {
      syntaxMaxDepth: 1_024,
      syntaxMaxNodes: 100_000,
      tabSize: 2,
      aliasStyle: "fullName" as const,
    };
    const completion = await planSqlAuthoringCompletionRequest(
      { uri, source, language: "sql", offset, snapshot: completionSnapshot, limit: 200 },
      {
        syntax: (request) => answerSyntaxRequest(request, codeMoniker.parser, settings),
      },
      expectations,
    );
    const document = TextDocument.create("file:///completion.sql", "sql", 1, source);
    return postgresCompletionList(completion, projectedSqlDocument(document)).items;
  }

  it("round-trips only a current TreeView SQL drag payload", async () => {
    const payload = {
      kind: "table" as const,
      connectionId: "demo-connection",
      database: "demo",
      oid: 1,
      schema: "shop",
      name: "product",
    };
    expect(parseSqlAuthoringDrag(serializeSqlAuthoringDrag(payload))).toEqual(payload);
    expect(parseSqlAuthoringDrag('{"kind":"table"}')).toBeUndefined();
    expect(parseSqlAuthoringDrag("not-json")).toBeUndefined();
    const routine = {
      kind: "function" as const,
      connectionId: "demo-connection",
      database: "demo",
      oid: 3,
      schema: "shop",
      name: "find_product",
    };
    expect(parseSqlAuthoringDrag(serializeSqlAuthoringDrag(routine))).toEqual(routine);
  });

  it("generates executable function and procedure invocations from routine drops", async () => {
    const functionResult = await compose(
      {
        text: "",
        offset: 0,
        payload: {
          kind: "function",
          connectionId: "demo-connection",
          database: "demo",
          oid: 3,
          schema: "shop",
          name: "find_product",
        },
      },
      snapshot,
    );
    expect(functionResult.status === "edit" ? functionResult.text : functionResult).toBe(
      "SELECT *\nFROM shop.find_product(\n  p_id => NULL::integer\n);\n",
    );

    const procedure = {
      ...snapshot.objects[2],
      oid: 4,
      name: "reprice_order",
      kind: "procedure" as const,
      parameters: [
        { name: "order_id", type: "bigint" },
        { name: "factor", type: "numeric" },
      ],
      columns: [],
    };
    const procedureResult = await compose(
      {
        text: "SELECT 1;",
        offset: 8,
        payload: {
          kind: "procedure",
          connectionId: "demo-connection",
          database: "demo",
          oid: 4,
          schema: "shop",
          name: "reprice_order",
        },
      },
      { ...snapshot, objects: [...snapshot.objects, procedure] },
    );
    expect(procedureResult.status === "edit" ? procedureResult.text : procedureResult).toContain(
      [
        "DO $workbench$",
        "DECLARE",
        "  v_order_id bigint := NULL;",
        "  v_factor numeric := NULL;",
        "BEGIN",
        "  CALL shop.reprice_order(",
        "    order_id => v_order_id,",
        "    factor => v_factor",
        "  );",
        "END",
        "$workbench$;",
      ].join("\n"),
    );
  });

  it("generates a safe DML harness for an indexed trigger function", async () => {
    const product = {
      ...snapshot.objects[0],
      columns: [...snapshot.objects[0].columns, { name: "stock", type: "integer" }],
    };
    const triggerFunction = {
      ...snapshot.objects[1],
      oid: 5,
      name: "audit_product_stock",
      kind: "function" as const,
      returnType: "trigger",
      parameters: [],
      columns: [],
    };
    const result = await compose(
      {
        text: "",
        offset: 0,
        payload: {
          kind: "function",
          connectionId: "demo-connection",
          database: "demo",
          oid: 5,
          schema: "shop",
          name: "audit_product_stock",
        },
      },
      {
        ...snapshot,
        objects: [product, ...snapshot.objects.slice(1), triggerFunction],
        triggers: [
          {
            oid: 50,
            schema: "shop",
            name: "product_stock_audit",
            relationSchema: "shop",
            relationName: "product",
            routineSchema: "shop",
            routineName: "audit_product_stock",
            definition:
              "CREATE TRIGGER product_stock_audit AFTER UPDATE OF stock ON shop.product FOR EACH ROW EXECUTE FUNCTION shop.audit_product_stock();",
          },
        ],
      },
    );
    expect(result.status === "edit" ? result.text : result).toBe(
      [
        "-- Invokes trigger shop.product_stock_audit and function shop.audit_product_stock",
        "-- Set the values below. Keep v_rollback = TRUE for a non-persistent test run.",
        "DO $workbench$",
        "DECLARE",
        "  v_id integer := NULL;",
        "  v_stock integer := NULL;",
        "  v_rollback boolean := TRUE;",
        "BEGIN",
        "  BEGIN",
        "    UPDATE shop.product",
        "    SET",
        "      stock = v_stock",
        "    WHERE id = v_id;",
        "    IF v_rollback THEN",
        "      RAISE EXCEPTION USING",
        "        ERRCODE = 'PW001',",
        "        MESSAGE = 'Workbench trigger test rollback';",
        "    END IF;",
        "  EXCEPTION",
        "    WHEN SQLSTATE 'PW001' THEN",
        "      RAISE NOTICE 'Workbench trigger test rolled back';",
        "  END;",
        "END",
        "$workbench$;",
        "",
      ].join("\n"),
    );

    const directTrigger = await compose(
      {
        text: "",
        offset: 0,
        payload: {
          kind: "trigger",
          connectionId: "demo-connection",
          database: "demo",
          oid: 50,
          schema: "shop",
          name: "product_stock_audit",
        },
      },
      {
        ...snapshot,
        objects: [product, ...snapshot.objects.slice(1), triggerFunction],
        triggers: [
          {
            oid: 50,
            schema: "shop",
            name: "product_stock_audit",
            relationSchema: "shop",
            relationName: "product",
            routineSchema: "shop",
            routineName: "audit_product_stock",
            definition:
              "CREATE TRIGGER product_stock_audit AFTER UPDATE OF stock ON shop.product FOR EACH ROW EXECUTE FUNCTION shop.audit_product_stock();",
          },
        ],
      },
    );
    expect(directTrigger.status === "edit" ? directTrigger.text : directTrigger).toBe(
      result.status === "edit" ? result.text : result,
    );
  });

  it("rolls back an INSERT trigger harness by default", async () => {
    const triggerFunction = {
      ...snapshot.objects[1],
      oid: 5,
      name: "audit_product_insert",
      kind: "function" as const,
      returnType: "trigger",
      parameters: [],
      columns: [],
    };
    const result = await compose(
      {
        text: "",
        offset: 0,
        payload: {
          kind: "function",
          connectionId: "demo-connection",
          database: "demo",
          oid: triggerFunction.oid,
          schema: "shop",
          name: triggerFunction.name,
        },
      },
      {
        ...snapshot,
        objects: [...snapshot.objects, triggerFunction],
        triggers: [
          {
            oid: 51,
            schema: "shop",
            name: "product_insert_audit",
            relationSchema: "shop",
            relationName: "product",
            routineSchema: "shop",
            routineName: triggerFunction.name,
            definition:
              "CREATE TRIGGER product_insert_audit AFTER INSERT ON shop.product FOR EACH ROW EXECUTE FUNCTION shop.audit_product_insert();",
          },
        ],
      },
    );
    expect(result.status).toBe("edit");
    if (result.status !== "edit") return;
    expect(result.text).toContain("v_rollback boolean := TRUE;");
    expect(result.text).toContain("INSERT INTO shop.product");
    expect(result.text).toContain("WHEN SQLSTATE 'PW001' THEN");
  });

  it("formats PostgreSQL SQL idempotently", async () => {
    const formatted = formatPostgresSql("select id,name from shop.product where id>0;");
    expect(formatted).toBe("SELECT\n  id,\n  name\nFROM\n  shop.product\nWHERE\n  id > 0;\n");
    expect(formatPostgresSql(formatted)).toBe(formatted);
    expect(formatPostgresSql("SELECT id, name FROM shop.product;", 4)).toBe(
      "SELECT\n    id,\n    name\nFROM\n    shop.product;\n",
    );
  });

  it("preserves PostgreSQL comments, quoted identifiers, parameters, and dollar bodies", async () => {
    const source = [
      "-- keep this comment",
      'with q as(select "Mixed Name", $1 as value from public."Order") select * from q;',
      "insert into audit_log(id, payload)values(:id, '{\"ready\":true}'::jsonb);",
      "create function f() returns void language plpgsql as $$ begin perform 1; end; $$;",
    ].join("\n");
    const formatted = formatPostgresSql(source);
    expect(formatted).toContain("-- keep this comment");
    expect(formatted).toContain('public."Order"');
    expect(formatted).toContain("$1 AS value");
    expect(formatted).toContain(":id");
    expect(formatted).toContain("$$ begin perform 1; end; $$");
    expect(formatPostgresSql(formatted)).toBe(formatted);
  });

  it("completes schema objects and alias columns from one bounded snapshot", async () => {
    const schemaItems = await complete("SELECT * FROM shop.pro", 22, snapshot);
    expect(schemaItems).toContainEqual(
      expect.objectContaining({
        label: "product",
        textEdit: expect.objectContaining({ newText: "product" }),
      }),
    );
    const aliasItems = await complete("SELECT p. FROM shop.product AS p", 9, snapshot);
    expect(aliasItems).toContainEqual(
      expect.objectContaining({
        label: "name",
        textEdit: expect.objectContaining({ newText: "name" }),
      }),
    );
    expect(aliasItems.length).toBeLessThanOrEqual(200);
    const routineItems = await complete("SELECT find", 11, snapshot);
    expect(routineItems).toContainEqual(
      expect.objectContaining({
        label: "find_product",
        textEdit: expect.objectContaining({ newText: "shop.find_product($" + "{1:p_id})" }),
      }),
    );
    const nested = "WITH x AS (SELECT * FROM shop.product AS p) SELECT p.";
    expect(await complete(nested, nested.length, snapshot)).toHaveLength(0);
    const schemaNamedCte = "WITH shop AS (SELECT 1) SELECT shop.";
    const schemaNamedCteItems = await complete(schemaNamedCte, schemaNamedCte.length, snapshot);
    expect(schemaNamedCteItems).not.toContainEqual(expect.objectContaining({ label: "name" }));
    expect(schemaNamedCteItems).toContainEqual(expect.objectContaining({ label: "find_product" }));
  });

  it("completes a qualified column at the end of a WHERE prefix", async () => {
    const source = "SELECT * FROM shop.product AS product WHERE product.";

    expect(await complete(source, source.length, snapshot)).toContainEqual(
      expect.objectContaining({
        label: "id",
        textEdit: expect.objectContaining({ newText: "id" }),
      }),
    );
  });

  it("completes indexed objects inside an anonymous PL/pgSQL DO block", async () => {
    const relationSource = [
      "DO $workbench$",
      "DECLARE",
      "  v_id integer := (SELECT id FROM shop.pro);",
      "BEGIN",
      "  NULL;",
      "END",
      "$workbench$;",
    ].join("\n");
    const relationCursor = relationSource.indexOf("shop.pro") + "shop.pro".length;
    expect(await complete(relationSource, relationCursor, snapshot)).toContainEqual(
      expect.objectContaining({
        label: "product",
        textEdit: expect.objectContaining({ newText: "product" }),
      }),
    );

    const routineSource = [
      "DO $workbench$",
      "BEGIN",
      "  PERFORM shop.find;",
      "END",
      "$workbench$;",
    ].join("\n");
    const routineCursor = routineSource.indexOf("shop.find") + "shop.find".length;
    expect(await complete(routineSource, routineCursor, snapshot)).toContainEqual(
      expect.objectContaining({ label: "find_product" }),
    );
  });

  it("offers whole-statement scaffolds where the grammar opens a statement, never inside an expression", async () => {
    const statements = await complete("", 0);
    const scaffold = statements.find((item) => item.label === "SELECT … FROM …;");
    expect(scaffold?.insertTextFormat).toBe(2);
    expect(
      scaffold?.textEdit && "newText" in scaffold.textEdit ? scaffold.textEdit.newText : "",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: This asserts literal VS Code snippet placeholders.
    ).toBe("SELECT ${1:columns}\nFROM ${2:relation};");
    expect(statements.some((item) => item.label === "UPDATE … SET … WHERE …;")).toBe(true);

    const expressionSource = [
      "DO $workbench$",
      "DECLARE",
      "  v_id integer := (SELECT",
      "BEGIN",
      "  NULL;",
      "END",
      "$workbench$;",
    ].join("\n");
    const expressionCaret = expressionSource.indexOf("(SELECT") + "(SELECT".length;
    const inExpression = await complete(expressionSource, expressionCaret);
    expect(inExpression.some((item) => item.label.includes("…"))).toBe(false);
  });

  it("completes an alias through the parser-proven SQL region nested in PL/pgSQL", async () => {
    const source =
      "CREATE FUNCTION f() RETURNS SETOF shop.product LANGUAGE plpgsql AS $$ BEGIN RETURN QUERY SELECT p. FROM shop.product AS p; END $$;";
    const caret = source.indexOf("SELECT p.") + "SELECT p.".length;

    const items = await complete(source, caret, snapshot);

    expect(items).toContainEqual(
      expect.objectContaining({
        label: "id",
        textEdit: expect.objectContaining({ newText: "id" }),
      }),
    );
  });

  it("rejects alias projection when recovery cannot see the region's relations", async () => {
    const source =
      "CREATE FUNCTION f() RETURNS SETOF shop.product LANGUAGE plpgsql AS $$ BEGIN RETURN QUERY SELECT p. + FROM shop.product AS p; END $$;";
    const caret = source.indexOf("SELECT p.") + "SELECT p.".length;

    const items = await complete(source, caret, snapshot);

    expect(items).not.toContainEqual(expect.objectContaining({ label: "id" }));
    expect(items).not.toContainEqual(expect.objectContaining({ label: "name" }));
  });

  it("proposes the statement's aliases on a bare fragment in a broken select list", async () => {
    const source = [
      "SELECT",
      "  product_category.product_id,",
      "  pro",
      "  warehouse.id",
      "FROM",
      "  shop.product_category AS product_category",
      "  JOIN shop.product AS product ON product_category.product_id = product.id",
      "  LEFT JOIN shop.warehouse AS warehouse ON product.id = warehouse.id;",
    ].join("\n");
    const caret = source.indexOf("  pro\n") + "  pro".length;

    const items = await complete(source, caret, snapshot);

    expect(items).toContainEqual(expect.objectContaining({ label: "product" }));
    expect(items).toContainEqual(expect.objectContaining({ label: "product_category" }));
  });

  it("filters a large schema before applying the completion bound", async () => {
    const decoys = Array.from({ length: 201 }, (_, index) => ({
      ...snapshot.objects[0],
      oid: 1_000 + index,
      name: `relation_${String(index).padStart(3, "0")}`,
    }));
    const target = { ...snapshot.objects[0], oid: 2_000, name: "target_after_bound" };
    const source = "SELECT * FROM shop.target_after";
    const items = await complete(source, source.length, {
      ...snapshot,
      objects: [...decoys, target],
    });
    expect(items).toContainEqual(expect.objectContaining({ label: "target_after_bound" }));
    expect(items.length).toBeLessThanOrEqual(200);

    const quotedSource = 'SELECT * FROM shop."Mixed';
    const quotedItems = await complete(quotedSource, quotedSource.length, {
      ...snapshot,
      objects: [...snapshot.objects, { ...snapshot.objects[0], oid: 2_001, name: "Mixed Name" }],
    });
    expect(quotedItems).toContainEqual(expect.objectContaining({ label: "Mixed Name" }));
  });

  it("scopes completion aliases and query shape to the Statement under the cursor", async () => {
    const cteAfter =
      "SELECT p. FROM shop.product AS p; WITH x AS (SELECT * FROM shop.order_line) SELECT * FROM x;";
    const productItems = await complete(cteAfter, cteAfter.indexOf("p.") + 2, snapshot);
    expect(productItems).toContainEqual(expect.objectContaining({ label: "name" }));

    const reusedAlias = "SELECT p.id FROM shop.product AS p; SELECT p. FROM shop.order_line AS p;";
    const secondCursor = reusedAlias.lastIndexOf("SELECT p.") + "SELECT p.".length;
    const orderLineItems = await complete(reusedAlias, secondCursor, snapshot);
    expect(orderLineItems).toContainEqual(expect.objectContaining({ label: "product_id" }));
    expect(orderLineItems).not.toContainEqual(expect.objectContaining({ label: "name" }));

    const falseAlias = "SELECT p. FROM shop.product AS p WHERE note = 'FROM shop.order_line AS p'";
    const falseAliasItems = await complete(
      falseAlias,
      falseAlias.indexOf("SELECT p.") + "SELECT p.".length,
      snapshot,
    );
    expect(falseAliasItems).toContainEqual(expect.objectContaining({ label: "name" }));
    expect(falseAliasItems).not.toContainEqual(expect.objectContaining({ label: "product_id" }));

    const commaJoin = "SELECT c. FROM shop.product AS p, shop.customer AS c WHERE c.id = p.id;";
    const commaJoinItems = await complete(
      commaJoin,
      commaJoin.indexOf("SELECT c.") + "SELECT c.".length,
      snapshot,
    );
    expect(commaJoinItems).toContainEqual(expect.objectContaining({ label: "loyalty_points" }));
    expect(commaJoinItems).not.toContainEqual(expect.objectContaining({ label: "product_id" }));

    const aliasNamedLikeSchema = "SELECT * FROM shop.product AS shop JOIN shop.";
    const schemaItems = await complete(aliasNamedLikeSchema, aliasNamedLikeSchema.length, snapshot);
    expect(schemaItems).toContainEqual(
      expect.objectContaining({
        label: "customer",
        textEdit: expect.objectContaining({ newText: "customer" }),
      }),
    );
    expect(schemaItems).not.toContainEqual(expect.objectContaining({ label: "name" }));
  });

  it("selects only the Statement under the composition offset for syntax validation", async () => {
    const source = "SELECT product.id FROM shop.product;\nSELECT broken FROM;";
    expect(sqlStatementAtOffset(source, source.indexOf("shop.product")).text).toBe(
      "SELECT product.id FROM shop.product;",
    );
    expect(sqlStatementAtOffset(source, source.indexOf("broken")).text.trim()).toBe(
      "SELECT broken FROM;",
    );
  });

  it("exposes every non-empty PostgreSQL Statement to Run without requiring valid syntax", async () => {
    const source = `-- first statement
SELECT 'semicolon; inside a string';

INSERT INTO shop.audit(message) VALUES ('run me');
SELECT broken FROM;`;

    expect(sqlStatementSlices(source)).toEqual([
      {
        start: 0,
        end: source.indexOf(";\n\n") + 1,
        line: 2,
        text: "-- first statement\nSELECT 'semicolon; inside a string';",
      },
      expect.objectContaining({
        line: 4,
        text: "INSERT INTO shop.audit(message) VALUES ('run me');",
      }),
      expect.objectContaining({ line: 5, text: "SELECT broken FROM;" }),
    ]);
  });

  it("rejects composition when the indexed snapshot changes during syntax validation", async () => {
    let current: SqlAuthoringDocumentContext = { status: "available", snapshot };
    const result = await composeSqlAuthoringRequest(
      {
        uri: "file:///query.sql",
        text: "SELECT p.id FROM shop.product AS p;",
        offset: 10,
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: 2,
          schema: "shop",
          name: "order_line",
        },
      },
      async () => current,
      async () => {
        current = { status: "available", snapshot: { ...snapshot, status: "stale" } };
        return { hasError: false, truncated: false };
      },
    );
    expect(result).toMatchObject({
      status: "rejected",
      message: expect.stringContaining("Index changed"),
    });
  });

  it("applies a composed edit only to the unchanged document and snapshot token", async () => {
    const context: SqlAuthoringDocumentContext = { status: "available", snapshot };
    const source = "SELECT p.id FROM shop.product AS p;";
    const result = await composeSqlAuthoringRequest(
      {
        uri: "file:///query.sql",
        text: source,
        offset: 10,
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: 2,
          schema: "shop",
          name: "order_line",
        },
      },
      async () => context,
      // The Extension Host answers with the analysis of the statement, as it does in production.
      async (statementSource) => {
        const analyzed = await analyzeSqlQuery(statementSource, codeMoniker.parser);
        return {
          hasError: false,
          truncated: false,
          ...(analyzed.status === "ok" ? { analysis: analyzed.analysis } : {}),
        };
      },
    );
    expect(sqlAuthoringEditStillApplies(result, context, source, source)).toBe(true);
    expect(
      sqlAuthoringEditStillApplies(
        result,
        { status: "available", snapshot: { ...snapshot, status: "stale" } },
        source,
        source,
      ),
    ).toBe(false);
    expect(sqlAuthoringEditStillApplies(result, context, source, `${source}\n-- edited`)).toBe(
      false,
    );
  });

  it("rejects composition when syntax analysis reaches its configured budget", async () => {
    const context: SqlAuthoringDocumentContext = { status: "available", snapshot };
    const result = await composeSqlAuthoringRequest(
      {
        uri: "file:///query.sql",
        text: "SELECT p.id FROM shop.product AS p;",
        offset: 10,
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: 2,
          schema: "shop",
          name: "order_line",
        },
      },
      async () => context,
      async () => ({ hasError: false, truncated: true }),
    );
    expect(result).toMatchObject({
      status: "rejected",
      message: expect.stringContaining("analysis budget"),
    });
  });

  it.each([
    "INNER JOIN shop.order_line ON product.id = shop.order_line.product_id",
    "CROSS JOIN shop.order_line",
    "FULL OUTER JOIN shop.order_line ON product.id = shop.order_line.product_id",
  ])("does not interpret JOIN modifiers as relation aliases: %s", async (join) => {
    const source = `SELECT product. FROM shop.product ${join};`;
    const items = await complete(source, source.indexOf("product.") + "product.".length, snapshot);
    expect(items).toContainEqual(expect.objectContaining({ label: "name" }));
  });

  it("resolves the second relation after a bare JOIN without an alias", async () => {
    const source =
      "SELECT order_line. FROM shop.product JOIN shop.order_line ON product.id = order_line.product_id;";
    const items = await complete(
      source,
      source.indexOf("order_line.") + "order_line.".length,
      snapshot,
    );
    expect(items).toContainEqual(expect.objectContaining({ label: "product_id" }));

    const result = await compose(
      {
        text: "SELECT product.id FROM shop.product JOIN shop.order_line ON product.id = order_line.product_id;",
        offset: 10,
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: 40,
          schema: "shop",
          name: "customer",
        },
      },
      {
        ...snapshot,
        foreignKeys: [
          ...snapshot.foreignKeys,
          {
            sourceTableOid: 2,
            targetTableOid: 40,
            sourceColumns: ["id"],
            sourceColumnsNullable: [false],
            targetColumns: ["id"],
            validated: true,
          },
        ],
      },
    );
    expect(result.status === "edit" ? result.text : result).toContain(
      "JOIN shop.customer AS customer ON order_line.id = customer.id",
    );
  });

  it("quotes reserved PostgreSQL table and column names generated from the catalog", async () => {
    const keywordTable = {
      ...snapshot.objects[0],
      oid: 5,
      name: "user",
      columns: [{ name: "when", type: "text" }],
    };
    const keywordSnapshot = { ...snapshot, objects: [...snapshot.objects, keywordTable] };
    const source = "SELECT * FROM shop.us";
    expect(await complete(source, source.length, keywordSnapshot)).toContainEqual(
      expect.objectContaining({
        label: "user",
        textEdit: expect.objectContaining({ newText: '"user"' }),
      }),
    );

    const projection = await compose(
      {
        text: "",
        offset: 0,
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: keywordTable.oid,
          schema: keywordTable.schema,
          name: keywordTable.name,
        },
      },
      keywordSnapshot,
    );
    expect(projection.status === "edit" ? projection.text : projection).toContain('"when"');
    expect(projection.status === "edit" ? projection.text : projection).toContain('shop."user"');

    const duplicate = await compose(
      {
        text: 'SELECT u."when" FROM shop."user" AS u;',
        offset: 10,
        payload: {
          kind: "column",
          connectionId: "demo-connection",
          database: "demo",
          tableOid: keywordTable.oid,
          tableSchema: keywordTable.schema,
          tableName: keywordTable.name,
          name: "when",
        },
      },
      keywordSnapshot,
    );
    expect(duplicate).toMatchObject({
      status: "rejected",
      message: "This column is already in the SELECT projection.",
    });
  });

  it("compares projected columns with PostgreSQL identifier semantics and ignores aliases", async () => {
    const caseSensitiveTable = {
      ...snapshot.objects[0],
      oid: 7,
      columns: [
        { name: "foo", type: "text" },
        { name: "Foo", type: "text" },
      ],
    };
    const caseSensitiveSnapshot = {
      ...snapshot,
      objects: [...snapshot.objects.filter(({ oid }) => oid !== 1), caseSensitiveTable],
    };
    const distinctQuotedColumn = await compose(
      {
        text: "SELECT p.foo FROM shop.product AS p;",
        offset: 10,
        payload: {
          kind: "column",
          connectionId: "demo-connection",
          database: "demo",
          tableOid: caseSensitiveTable.oid,
          tableSchema: caseSensitiveTable.schema,
          tableName: caseSensitiveTable.name,
          name: "Foo",
        },
      },
      caseSensitiveSnapshot,
    );
    expect(distinctQuotedColumn.status === "edit" ? distinctQuotedColumn.text : "").toContain(
      'p."Foo"',
    );

    const aliasedProjection = await compose(
      {
        text: "SELECT p.name AS display_name FROM shop.product AS p;",
        offset: 10,
        payload: {
          kind: "column",
          connectionId: "demo-connection",
          database: "demo",
          tableOid: 1,
          tableSchema: "shop",
          tableName: "product",
          name: "name",
        },
      },
      snapshot,
    );
    expect(aliasedProjection).toMatchObject({
      status: "rejected",
      message: "This column is already in the SELECT projection.",
    });
  });

  it("extends a view projection with a dragged view column", async () => {
    const productView = {
      ...snapshot.objects[0],
      oid: 8,
      name: "product_view",
      kind: "view" as const,
    };
    const result = await compose(
      {
        text: "SELECT pv.id FROM shop.product_view AS pv;",
        offset: 10,
        payload: {
          kind: "column",
          connectionId: "demo-connection",
          database: "demo",
          tableOid: productView.oid,
          tableSchema: productView.schema,
          tableName: productView.name,
          name: "name",
        },
      },
      { ...snapshot, objects: [...snapshot.objects, productView] },
    );
    expect(result.status === "edit" ? result.text : result).toContain("pv.name");
  });

  it("rejects a dragged column when its table OID has several query references", async () => {
    const result = await compose(
      {
        text: [
          "SELECT p1.id, p2.id",
          "FROM shop.product AS p1",
          "JOIN shop.product AS p2 ON p1.id = p2.id;",
        ].join("\n"),
        offset: 10,
        payload: {
          kind: "column",
          connectionId: "demo-connection",
          database: "demo",
          tableOid: 1,
          tableSchema: "shop",
          tableName: "product",
          name: "name",
        },
      },
      snapshot,
    );
    expect(result).toMatchObject({
      status: "rejected",
      message: expect.stringContaining("more than once"),
    });
  });

  it.each(["DISTINCT", "ALL"])(
    "does not duplicate a column already projected after SELECT %s",
    async (modifier) => {
      const result = await compose(
        {
          text: `SELECT ${modifier} p.name FROM shop.product AS p;`,
          offset: 10,
          payload: {
            kind: "column",
            connectionId: "demo-connection",
            database: "demo",
            tableOid: 1,
            tableSchema: "shop",
            tableName: "product",
            name: "name",
          },
        },
        snapshot,
      );
      expect(result).toMatchObject({
        status: "rejected",
        message: "This column is already in the SELECT projection.",
      });
    },
  );

  it("rejects column composition conservatively for SELECT DISTINCT ON", async () => {
    const result = await compose(
      {
        text: "SELECT DISTINCT ON (p.id) p.name FROM shop.product AS p;",
        offset: 30,
        payload: {
          kind: "column",
          connectionId: "demo-connection",
          database: "demo",
          tableOid: 1,
          tableSchema: "shop",
          tableName: "product",
          name: "name",
        },
      },
      snapshot,
    );
    expect(result).toMatchObject({ status: "rejected" });
  });

  it.each([
    "SELECT count(*) FROM shop.order_line AS ol;",
    'SELECT "count"(*) FROM shop.order_line AS ol;',
    "SELECT ol.product_id, count(*) FROM shop.order_line AS ol GROUP BY ol.product_id;",
    "SELECT DISTINCT ol.product_id FROM shop.order_line AS ol;",
  ])("joins without expanding an aggregate or set-sensitive projection: %s", async (text) => {
    const result = await compose(
      {
        text,
        offset: text.indexOf("order_line"),
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: 1,
          schema: "shop",
          name: "product",
        },
      },
      snapshot,
    );
    expect(result.status).toBe("edit");
    if (result.status !== "edit") return;
    expect(result.text).toContain("JOIN shop.product AS product");
    expect(result.text).not.toContain("product.name");
  });

  it("creates an explicit projection, extends it once, and joins only through one foreign key", async () => {
    const table = await compose(
      {
        text: "",
        offset: 0,
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: 1,
          schema: "shop",
          name: "product",
        },
      },
      snapshot,
    );
    expect(table).toMatchObject({ status: "edit" });
    expect(table.status === "edit" ? table.text : "").toBe(
      "SELECT\n  product.id,\n  product.name\nFROM\n  shop.product AS product;\n",
    );

    const joined = await compose(
      {
        text: "SELECT ol.id FROM shop.order_line AS ol;",
        offset: 0,
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: 1,
          schema: "shop",
          name: "product",
        },
      },
      snapshot,
    );
    expect(joined.status === "edit" ? joined.text : joined).toContain("ol.product_id = product.id");

    const column = await compose(
      {
        text: "SELECT p.id FROM shop.product AS p;",
        offset: 0,
        payload: {
          kind: "column",
          connectionId: "demo-connection",
          database: "demo",
          tableOid: 1,
          tableSchema: "shop",
          tableName: "product",
          name: "name",
        },
      },
      snapshot,
    );
    expect(column.status === "edit" ? column.text : column).toContain("p.name");

    const unaliasedColumn = await compose(
      {
        text: "SELECT product.id FROM shop.product;",
        offset: 0,
        payload: {
          kind: "column",
          connectionId: "demo-connection",
          database: "demo",
          tableOid: 1,
          tableSchema: "shop",
          tableName: "product",
          name: "name",
        },
      },
      snapshot,
    );
    expect(unaliasedColumn.status === "edit" ? unaliasedColumn.text : unaliasedColumn).toContain(
      "product.name",
    );
    expect(
      unaliasedColumn.status === "edit" ? unaliasedColumn.text : unaliasedColumn,
    ).not.toContain("shop.product.name");
  });

  it("keeps a generated projection unambiguous when a joined table shares column names", async () => {
    const address = {
      ...snapshot.objects[0],
      oid: 50,
      name: "address",
      columns: [
        { name: "id", type: "integer" },
        { name: "label", type: "text" },
        { name: "city", type: "text" },
      ],
    };
    const customerAddress = {
      ...snapshot.objects[0],
      oid: 51,
      name: "customer_address",
      columns: [
        { name: "id", type: "integer" },
        { name: "address_id", type: "integer" },
      ],
    };
    const addressSnapshot: SqlAuthoringSnapshot = {
      ...snapshot,
      objects: [address, customerAddress],
      foreignKeys: [
        {
          sourceTableOid: customerAddress.oid,
          targetTableOid: address.oid,
          sourceColumns: ["address_id"],
          sourceColumnsNullable: [false],
          targetColumns: ["id"],
          validated: true,
        },
      ],
    };
    const projection = await compose(
      {
        text: "",
        offset: 0,
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: address.oid,
          schema: "shop",
          name: address.name,
        },
      },
      addressSnapshot,
    );
    expect(projection.status).toBe("edit");
    if (projection.status !== "edit") return;
    expect(projection.text).toContain("address.id");
    expect(projection.text).toContain("FROM\n  shop.address AS address");
    const curatedProjection = projection.text.replace("  address.label,\n", "");

    const joined = await compose(
      {
        text: curatedProjection,
        offset: curatedProjection.indexOf("shop.address"),
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: customerAddress.oid,
          schema: "shop",
          name: customerAddress.name,
        },
      },
      addressSnapshot,
    );
    expect(joined.status).toBe("edit");
    if (joined.status !== "edit") return;
    expect(joined.text).toBe(
      "SELECT\n  address.id,\n  address.city,\n  customer_address.id,\n  customer_address.address_id\nFROM\n  shop.address AS address\n  LEFT JOIN shop.customer_address AS customer_address ON address.id = customer_address.address_id;\n",
    );
    expect(joined.text).not.toContain("address.label");
    expect(joined.text).not.toMatch(/(?:^|\s)id,/u);
  });

  it("generates compact initial aliases when configured", async () => {
    const result = await compose(
      {
        text: "",
        offset: 0,
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: 1,
          schema: "shop",
          name: "product",
        },
      },
      snapshot,
      { aliasStyle: "initial", syntaxMaxDepth: 1_024, syntaxMaxNodes: 100_000, tabSize: 2 },
    );
    expect(result.status === "edit" ? result.text : result).toBe(
      "SELECT\n  p.id,\n  p.name\nFROM\n  shop.product AS p;\n",
    );
  });

  it("appends an independent SELECT when no direct foreign key can form a JOIN", async () => {
    const result = await compose(
      {
        text: "SELECT p.id FROM shop.product AS p;",
        offset: 10,
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: 40,
          schema: "shop",
          name: "customer",
        },
      },
      snapshot,
    );
    expect(result.status).toBe("edit");
    expect(result.status === "edit" ? result.text : result).toBe(
      "SELECT p.id FROM shop.product AS p;\n\nSELECT\n  customer.id,\n  customer.name,\n  customer.loyalty_points\nFROM\n  shop.customer AS customer;\n",
    );
  });

  it("does not compose a JOIN from an unvalidated foreign key", async () => {
    const result = await compose(
      {
        text: "SELECT p.id FROM shop.product AS p;",
        offset: 10,
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: 2,
          schema: "shop",
          name: "order_line",
        },
      },
      {
        ...snapshot,
        foreignKeys: snapshot.foreignKeys.map((foreignKey) => ({
          ...foreignKey,
          validated: false,
        })),
      },
    );
    expect(result.status === "edit" ? result.text : result).not.toContain("JOIN");
    expect(result.status === "edit" ? result.text : result).toContain(
      "SELECT\n  order_line.id,\n  order_line.product_id\nFROM\n  shop.order_line AS order_line;",
    );
  });

  it.each([
    { sourceColumns: [], targetColumns: [] },
    { sourceColumns: ["product_id"], targetColumns: [] },
    { sourceColumns: [], targetColumns: ["id"] },
    { sourceColumns: ["product_id", "id"], targetColumns: ["id"] },
    { sourceColumns: [""], targetColumns: ["id"] },
    { sourceColumns: ["product_id"], targetColumns: [""] },
  ])(
    "does not compose a JOIN from structurally incomplete foreign-key columns: %j",
    async ({ sourceColumns, targetColumns }) => {
      const result = await compose(
        {
          text: "SELECT ol.id FROM shop.order_line AS ol;",
          offset: 10,
          payload: {
            kind: "table",
            connectionId: "demo-connection",
            database: "demo",
            oid: 1,
            schema: "shop",
            name: "product",
          },
        },
        {
          ...snapshot,
          foreignKeys: [
            {
              ...snapshot.foreignKeys[0],
              sourceColumns,
              targetColumns,
            },
          ],
        },
      );
      const text = result.status === "edit" ? result.text : "";
      expect(result.status).toBe("edit");
      expect(text).not.toMatch(/\bJOIN\b/u);
      expect(text).not.toContain(" ON ");
      expect(text).not.toContain("undefined");
      expect(text).toContain("FROM\n  shop.product AS product;");
    },
  );

  it.each([
    { label: "missing", sourceColumnsNullable: undefined },
    { label: "short", sourceColumnsNullable: [] },
    { label: "long", sourceColumnsNullable: [false, false] },
  ])("uses LEFT JOIN when foreign-key nullability is $label", async ({ sourceColumnsNullable }) => {
    const foreignKey = {
      ...snapshot.foreignKeys[0],
      sourceColumnsNullable,
    } as (typeof snapshot.foreignKeys)[number];
    const result = await compose(
      {
        text: "SELECT ol.id FROM shop.order_line AS ol;",
        offset: 10,
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: 1,
          schema: "shop",
          name: "product",
        },
      },
      { ...snapshot, foreignKeys: [foreignKey] },
    );
    expect(result.status === "edit" ? result.text : result).toContain("LEFT JOIN shop.product");
  });

  it("rejects stale and cross-context composition", async () => {
    const request = {
      uri: "file:///query.sql",
      text: "",
      offset: 0,
      payload: {
        kind: "table" as const,
        connectionId: "other",
        database: "demo",
        oid: 1,
        schema: "shop",
        name: "product",
      },
    };
    expect(await compose(request, snapshot)).toMatchObject({ status: "rejected" });
    expect(
      await compose(
        { ...request, payload: { ...request.payload, connectionId: "demo-connection" } },
        { ...snapshot, status: "stale" },
      ),
    ).toMatchObject({ status: "rejected" });
  });

  it("asks for an explicit relation when several foreign keys are reliable", async () => {
    const result = await compose(
      {
        text: "SELECT ol.id FROM shop.order_line AS ol;",
        offset: 10,
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: 1,
          schema: "shop",
          name: "product",
        },
      },
      {
        ...snapshot,
        foreignKeys: [
          ...snapshot.foreignKeys,
          {
            sourceTableOid: 2,
            targetTableOid: 1,
            sourceColumns: ["id"],
            sourceColumnsNullable: [false],
            targetColumns: ["id"],
            validated: true,
          },
        ],
      },
    );
    expect(result).toMatchObject({ status: "ambiguous", choices: [{ index: 0 }, { index: 1 }] });
    if (result.status !== "ambiguous") return;
    expect(result.choices.map(({ label }) => label)).toEqual([
      "ol.product_id → product.id",
      "ol.id → product.id",
    ]);
  });

  it("distinguishes self-join references in the foreign-key picker", async () => {
    const result = await compose(
      {
        text: [
          "SELECT p1.id, p2.id",
          "FROM shop.product AS p1",
          "JOIN shop.product AS p2 ON p1.id = p2.id;",
        ].join("\n"),
        offset: 10,
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: 40,
          schema: "shop",
          name: "customer",
        },
      },
      {
        ...snapshot,
        foreignKeys: [
          {
            sourceTableOid: 1,
            targetTableOid: 40,
            sourceColumns: ["id"],
            sourceColumnsNullable: [false],
            targetColumns: ["id"],
            validated: true,
          },
        ],
      },
    );
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") return;
    expect(result.choices).toHaveLength(2);
    expect(`${result.choices[0].label} ${result.choices[0].description}`).toContain("p1");
    expect(`${result.choices[1].label} ${result.choices[1].description}`).toContain("p2");
    expect(
      new Set(result.choices.map(({ label, description }) => `${label}\n${description}`)).size,
    ).toBe(2);
  });

  it("rejects JOIN composition from unqualified, CTE, and nested relation references", async () => {
    const payload = {
      kind: "table" as const,
      connectionId: "demo-connection",
      database: "demo",
      oid: 2,
      schema: "shop",
      name: "order_line",
    };
    expect(
      await compose(
        {
          text: "SELECT p.id FROM product AS p;",
          offset: 10,
          payload,
        },
        {
          ...snapshot,
          objects: [...snapshot.objects, { ...snapshot.objects[0], oid: 99, schema: "archive" }],
        },
      ),
    ).toMatchObject({ status: "rejected" });
    expect(
      await compose(
        {
          text: "WITH x AS (SELECT * FROM shop.product) SELECT * FROM x;",
          offset: 52,
          payload,
        },
        snapshot,
      ),
    ).toMatchObject({ status: "rejected" });
    const nested = "SELECT * FROM (SELECT * FROM shop.product) AS p;";
    expect(
      await compose(
        {
          text: nested,
          offset: nested.indexOf("AS p"),
          payload,
        },
        snapshot,
      ),
    ).toMatchObject({ status: "rejected" });
  });

  it.each([
    "SELECT * INTO product_copy FROM shop.product;",
    "SELECT * FROM shop.product UNION SELECT * FROM shop.product;",
    "SELECT * FROM shop.product INTERSECT SELECT * FROM shop.product;",
    "SELECT * FROM shop.product EXCEPT SELECT * FROM shop.product;",
    "SELECT * FROM shop.product WINDOW w AS (PARTITION BY id);",
    "SELECT * FROM shop.product FETCH FIRST 1 ROW ONLY;",
    "SELECT * FROM shop.product FOR UPDATE;",
    "SELECT p.id FROM shop.product AS p, shop.customer AS c;",
  ])("leaves an unsupported SELECT shape unchanged: %s", async (source) => {
    expect(
      await compose(
        {
          text: source,
          offset: source.indexOf("shop.product"),
          payload: {
            kind: "table",
            connectionId: "demo-connection",
            database: "demo",
            oid: 2,
            schema: "shop",
            name: "order_line",
          },
        },
        snapshot,
      ),
    ).toMatchObject({ status: "rejected" });
  });

  it("does not interpret USING or TABLESAMPLE as relation aliases", async () => {
    const usingColumn = await compose(
      {
        text: "SELECT p.id FROM shop.product AS p JOIN shop.order_line USING (id);",
        offset: 10,
        payload: {
          kind: "column",
          connectionId: "demo-connection",
          database: "demo",
          tableOid: 2,
          tableSchema: "shop",
          tableName: "order_line",
          name: "product_id",
        },
      },
      snapshot,
    );
    expect(usingColumn.status === "edit" ? usingColumn.text : usingColumn).toContain(
      "order_line.product_id",
    );

    const sampledJoin = await compose(
      {
        text: "SELECT * FROM shop.product TABLESAMPLE SYSTEM (10);",
        offset: 10,
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: 2,
          schema: "shop",
          name: "order_line",
        },
      },
      snapshot,
    );
    expect(sampledJoin.status === "edit" ? sampledJoin.text : sampledJoin).toContain(
      "product.id = order_line.product_id",
    );
  });

  it("does not interpret ON as the alias of an already joined relation", async () => {
    const shipment = {
      ...snapshot.objects[0],
      oid: 4,
      name: "shipment",
      columns: [
        { name: "id", type: "integer" },
        { name: "order_line_id", type: "integer" },
      ],
    };
    const result = await compose(
      {
        text: "SELECT p.id FROM shop.product AS p JOIN shop.order_line ON p.id = shop.order_line.product_id;",
        offset: 10,
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: shipment.oid,
          schema: shipment.schema,
          name: shipment.name,
        },
      },
      {
        ...snapshot,
        objects: [...snapshot.objects, shipment],
        foreignKeys: [
          ...snapshot.foreignKeys,
          {
            sourceTableOid: shipment.oid,
            targetTableOid: 2,
            sourceColumns: ["order_line_id"],
            sourceColumnsNullable: [false],
            targetColumns: ["id"],
            validated: true,
          },
        ],
      },
    );
    expect(result.status === "edit" ? result.text : result).toContain(
      "order_line.id = shipment.order_line_id",
    );
    expect(result.status === "edit" ? result.text : result).not.toContain("ON.id");
  });

  it("preserves raw PostgreSQL aliases while resolving their canonical names", async () => {
    const source = "SELECT P.id FROM Shop.Product AS P;";
    const column = await compose(
      {
        text: source,
        offset: source.indexOf("P.id"),
        payload: {
          kind: "column",
          connectionId: "demo-connection",
          database: "demo",
          tableOid: 1,
          tableSchema: "shop",
          tableName: "product",
          name: "name",
        },
      },
      snapshot,
    );
    expect(column.status === "edit" ? column.text : column).toContain("P.name");
    expect(column.status === "edit" ? column.text : column).not.toContain('"P".name');

    const completionSource = "SELECT P. FROM Shop.Product AS P;";
    const items = await complete(
      completionSource,
      completionSource.indexOf("SELECT P.") + "SELECT P.".length,
      snapshot,
    );
    expect(items).toContainEqual(
      expect.objectContaining({
        label: "name",
        textEdit: expect.objectContaining({ newText: "name" }),
      }),
    );
    const generalItems = await complete(
      "SELECT  FROM Shop.Product AS P;",
      "SELECT ".length,
      snapshot,
    );
    expect(generalItems).toContainEqual(
      expect.objectContaining({
        label: "P",
        textEdit: expect.objectContaining({ newText: "P." }),
      }),
    );

    const quotedAliasSource = 'SELECT "P.A". FROM shop.product AS "P.A";';
    const quotedAliasItems = await complete(
      quotedAliasSource,
      quotedAliasSource.indexOf('SELECT "P.A".') + 'SELECT "P.A".'.length,
      snapshot,
    );
    expect(quotedAliasItems).toContainEqual(expect.objectContaining({ label: "name" }));

    const quotedKeyword = 'SELECT "where".id FROM shop.product AS "where";';
    const quotedKeywordColumn = await compose(
      {
        text: quotedKeyword,
        offset: quotedKeyword.indexOf('"where".id'),
        payload: {
          kind: "column",
          connectionId: "demo-connection",
          database: "demo",
          tableOid: 1,
          tableSchema: "shop",
          tableName: "product",
          name: "name",
        },
      },
      snapshot,
    );
    expect(
      quotedKeywordColumn.status === "edit" ? quotedKeywordColumn.text : quotedKeywordColumn,
    ).toContain('"where".name');
    const quotedKeywordItems = await complete(
      quotedKeyword,
      quotedKeyword.indexOf('SELECT "where".') + 'SELECT "where".'.length,
      snapshot,
    );
    expect(quotedKeywordItems).toContainEqual(expect.objectContaining({ label: "name" }));
  });

  it("aliases a JOIN target when its implicit correlation name is already used", async () => {
    const brand = {
      ...snapshot.objects[0],
      oid: 6,
      name: "brand",
    };
    const result = await compose(
      {
        text: "SELECT brand.id FROM shop.product AS brand;",
        offset: 10,
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: brand.oid,
          schema: brand.schema,
          name: brand.name,
        },
      },
      {
        ...snapshot,
        objects: [...snapshot.objects, brand],
        foreignKeys: [
          ...snapshot.foreignKeys,
          {
            sourceTableOid: 1,
            targetTableOid: brand.oid,
            sourceColumns: ["brand_id"],
            sourceColumnsNullable: [true],
            targetColumns: ["id"],
            validated: true,
          },
        ],
      },
    );
    expect(result.status === "edit" ? result.text : result).toContain(
      "LEFT JOIN shop.brand AS brand_2 ON brand.brand_id = brand_2.id",
    );
  });

  it.each([
    "SELECT E'(SELECT\\';inside' AS sample FROM shop.product;",
    "SELECT 1 /* a comment ; with a separator */ FROM shop.product;",
  ])("keeps PostgreSQL lexical constructs inside the composed Statement: %s", async (statement) => {
    const source = `SELECT 0 AS untouched;\n${statement}`;
    const result = await compose(
      {
        text: source,
        offset: source.indexOf("shop.product"),
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: 2,
          schema: "shop",
          name: "order_line",
        },
      },
      snapshot,
    );
    expect(result).toMatchObject({ status: "edit" });
    expect(result.status === "edit" ? result.text : result).toContain("SELECT 0 AS untouched;");
    expect(result.status === "edit" ? result.text : result).toContain(
      "product.id = order_line.product_id",
    );
  });

  it.each([
    "SELECT 'WHERE' AS note FROM shop.product AS p;",
    "SELECT '🙂 WHERE' AS note FROM shop.product AS p;",
    "SELECT * FROM shop.product /* WHERE fake */ AS p;",
    'SELECT "WHERE" AS marker FROM shop.product AS p;',
  ])(
    "ignores clause keywords in literals and comments when inserting a JOIN: %s",
    async (source) => {
      expect(scanPostgresSql(source).maskedSource).toHaveLength(source.length);
      const result = await compose(
        {
          text: source,
          offset: source.indexOf("shop.product"),
          payload: {
            kind: "table",
            connectionId: "demo-connection",
            database: "demo",
            oid: 2,
            schema: "shop",
            name: "order_line",
          },
        },
        snapshot,
      );
      expect(result).toMatchObject({ status: "edit" });
      expect(result.status === "edit" ? result.text : result).toContain(
        "p.id = order_line.product_id",
      );
    },
  );

  it("ignores phantom relations in literals and dollar-quoted text", async () => {
    const source =
      "SELECT 'FROM shop.product AS p' AS note, $$JOIN shop.product WHERE$$ AS body, \"JOIN shop.product\" AS marker FROM shop.order_line AS ol;";
    const result = await compose(
      {
        text: source,
        offset: source.indexOf("shop.order_line"),
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: 1,
          schema: "shop",
          name: "product",
        },
      },
      snapshot,
    );
    expect(result).toMatchObject({ status: "edit" });
    expect(result.status === "edit" ? result.text : result).toContain("ol.product_id = product.id");
  });

  it("uses only top-level SQL clauses when composing", async () => {
    const filtered = "SELECT count(*) FILTER (WHERE active) FROM shop.product AS p;";
    const joined = await compose(
      {
        text: filtered,
        offset: filtered.indexOf("shop.product"),
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: 2,
          schema: "shop",
          name: "order_line",
        },
      },
      snapshot,
    );
    const joinedText = joined.status === "edit" ? joined.text : "";
    expect(joinedText).toMatch(/FILTER\s*\([\s\S]*\bWHERE\b[\s\S]*\bactive\b[\s\S]*\)/u);
    expect(joinedText).toContain("p.id = order_line.product_id");
    expect(joinedText.indexOf("LEFT JOIN shop.order_line")).toBeGreaterThan(
      joinedText.indexOf("shop.product AS p"),
    );

    const substring = "SELECT substring(name FROM 1) FROM shop.product AS p;";
    const extended = await compose(
      {
        text: substring,
        offset: substring.indexOf("shop.product"),
        payload: {
          kind: "column",
          connectionId: "demo-connection",
          database: "demo",
          tableOid: 1,
          tableSchema: "shop",
          tableName: "product",
          name: "name",
        },
      },
      snapshot,
    );
    const extendedText = extended.status === "edit" ? extended.text : "";
    expect(extendedText).toMatch(
      /substring\s*\([\s\S]*\bname\b[\s\S]*\bFROM\b[\s\S]*\b1\b[\s\S]*\),\s*p\.name/u,
    );
  });

  it("preserves optional rows with LEFT JOIN from nullability and reverse direction", async () => {
    const nullable = await compose(
      {
        text: "SELECT ol.id FROM shop.order_line AS ol;",
        offset: 10,
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: 1,
          schema: "shop",
          name: "product",
        },
      },
      {
        ...snapshot,
        foreignKeys: snapshot.foreignKeys.map((foreignKey) => ({
          ...foreignKey,
          sourceColumnsNullable: [true],
        })),
      },
    );
    expect(nullable.status === "edit" ? nullable.text : nullable).toContain(
      "LEFT JOIN shop.product",
    );

    const reverse = await compose(
      {
        text: "SELECT p.id FROM shop.product AS p;",
        offset: 9,
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: 2,
          schema: "shop",
          name: "order_line",
        },
      },
      snapshot,
    );
    expect(reverse.status === "edit" ? reverse.text : reverse).toContain(
      "LEFT JOIN shop.order_line",
    );
  });

  it.each([
    {
      label: "LEFT JOIN",
      clause: "LEFT JOIN shop.order_line AS ol ON p.id = ol.product_id",
    },
    {
      label: "FULL JOIN",
      clause: "FULL JOIN shop.order_line AS ol ON p.id = ol.product_id",
    },
    { label: "NATURAL LEFT JOIN", clause: "NATURAL LEFT JOIN shop.order_line AS ol" },
    { label: "NATURAL FULL JOIN", clause: "NATURAL FULL JOIN shop.order_line AS ol" },
  ])(
    "keeps a chained mandatory foreign key LEFT when its source was null-extended by $label",
    async ({ clause }) => {
      const result = await compose(
        {
          text: ["SELECT p.id", "FROM shop.product AS p", `${clause};`].join("\n"),
          offset: 10,
          payload: {
            kind: "table",
            connectionId: "demo-connection",
            database: "demo",
            oid: 40,
            schema: "shop",
            name: "customer",
          },
        },
        {
          ...snapshot,
          foreignKeys: [
            ...snapshot.foreignKeys,
            {
              sourceTableOid: 2,
              targetTableOid: 40,
              sourceColumns: ["id"],
              sourceColumnsNullable: [false],
              targetColumns: ["id"],
              validated: true,
            },
          ],
        },
      );
      expect(result.status === "edit" ? result.text : result).toContain(
        "LEFT JOIN shop.customer AS customer ON ol.id = customer.id",
      );
    },
  );

  it("composes only the SQL statement under the drop cursor", async () => {
    const source = "SELECT 1;\nSELECT ol.id FROM shop.order_line AS ol;\nSELECT 3;";
    const result = await compose(
      {
        text: source,
        offset: source.indexOf("ol.id"),
        payload: {
          kind: "table",
          connectionId: "demo-connection",
          database: "demo",
          oid: 1,
          schema: "shop",
          name: "product",
        },
      },
      snapshot,
    );
    expect(result.status).toBe("edit");
    if (result.status !== "edit") return;
    expect(result.text).toMatch(/^SELECT 1;/u);
    expect(result.text).toContain("JOIN shop.product AS product ON ol.product_id = product.id");
    expect(result.text).toMatch(/SELECT 3;$/u);
  });
});
