import { describe, expect, it } from "vitest";
import { postgresCompletions } from "./completion.js";
import { composePostgresSql } from "./composition.js";
import { formatPostgresSql } from "./format.js";
import {
  parseSqlAuthoringDrag,
  type SqlAuthoringSnapshot,
  serializeSqlAuthoringDrag,
} from "./protocol.js";
import { scanPostgresSql } from "./sqlLexing.js";

const snapshot: SqlAuthoringSnapshot = {
  status: "available",
  serverId: "demo-server",
  database: "demo",
  revision: "r1",
  generation: 1,
  objects: [
    {
      serverId: "demo-server",
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
      serverId: "demo-server",
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
      serverId: "demo-server",
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
  ],
  foreignKeys: [
    {
      sourceTableOid: 2,
      targetTableOid: 1,
      sourceColumns: ["product_id"],
      sourceColumnsNullable: [false],
      targetColumns: ["id"],
    },
  ],
};

describe("SQL authoring language contracts", () => {
  it("round-trips only a current TreeView SQL drag payload", () => {
    const payload = {
      kind: "table" as const,
      serverId: "demo-server",
      database: "demo",
      oid: 1,
      schema: "shop",
      name: "product",
    };
    expect(parseSqlAuthoringDrag(serializeSqlAuthoringDrag(payload))).toEqual(payload);
    expect(parseSqlAuthoringDrag('{"kind":"table"}')).toBeUndefined();
    expect(parseSqlAuthoringDrag("not-json")).toBeUndefined();
  });

  it("formats PostgreSQL SQL idempotently", () => {
    const formatted = formatPostgresSql("select id,name from shop.product where id>0;");
    expect(formatted).toBe("SELECT\n  id,\n  name\nFROM\n  shop.product\nWHERE\n  id > 0;\n");
    expect(formatPostgresSql(formatted)).toBe(formatted);
  });

  it("preserves PostgreSQL comments, quoted identifiers, parameters, and dollar bodies", () => {
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

  it("completes schema objects and alias columns from one bounded snapshot", () => {
    const schemaItems = postgresCompletions("SELECT * FROM shop.pro", 22, snapshot);
    expect(schemaItems).toContainEqual(
      expect.objectContaining({ label: "product", insertText: "product" }),
    );
    const aliasItems = postgresCompletions("SELECT p. FROM shop.product AS p", 9, snapshot);
    expect(aliasItems).toContainEqual(
      expect.objectContaining({ label: "name", insertText: "name" }),
    );
    expect(aliasItems.length).toBeLessThanOrEqual(200);
    const routineItems = postgresCompletions("SELECT find", 11, snapshot);
    expect(routineItems).toContainEqual(
      expect.objectContaining({
        label: "find_product",
        insertText: "shop.find_product($" + "{1:p_id})",
      }),
    );
    const nested = "WITH x AS (SELECT * FROM shop.product AS p) SELECT p.";
    expect(postgresCompletions(nested, nested.length, snapshot)).toHaveLength(0);
    const schemaNamedCte = "WITH shop AS (SELECT 1) SELECT shop.";
    expect(postgresCompletions(schemaNamedCte, schemaNamedCte.length, snapshot)).toHaveLength(0);
  });

  it("filters a large schema before applying the completion bound", () => {
    const decoys = Array.from({ length: 201 }, (_, index) => ({
      ...snapshot.objects[0],
      oid: 1_000 + index,
      name: `relation_${String(index).padStart(3, "0")}`,
    }));
    const target = { ...snapshot.objects[0], oid: 2_000, name: "target_after_bound" };
    const source = "SELECT * FROM shop.target_after";
    const items = postgresCompletions(source, source.length, {
      ...snapshot,
      objects: [...decoys, target],
    });
    expect(items).toContainEqual(expect.objectContaining({ label: "target_after_bound" }));
    expect(items.length).toBeLessThanOrEqual(200);

    const quotedSource = 'SELECT * FROM shop."Mixed';
    const quotedItems = postgresCompletions(quotedSource, quotedSource.length, {
      ...snapshot,
      objects: [...snapshot.objects, { ...snapshot.objects[0], oid: 2_001, name: "Mixed Name" }],
    });
    expect(quotedItems).toContainEqual(expect.objectContaining({ label: "Mixed Name" }));
  });

  it("scopes completion aliases and query shape to the Statement under the cursor", () => {
    const cteAfter =
      "SELECT p. FROM shop.product AS p; WITH x AS (SELECT * FROM shop.order_line) SELECT * FROM x;";
    const productItems = postgresCompletions(cteAfter, cteAfter.indexOf("p.") + 2, snapshot);
    expect(productItems).toContainEqual(expect.objectContaining({ label: "name" }));

    const reusedAlias = "SELECT p. FROM shop.product AS p; SELECT p. FROM shop.order_line AS p;";
    const secondCursor = reusedAlias.lastIndexOf("SELECT p.") + "SELECT p.".length;
    const orderLineItems = postgresCompletions(reusedAlias, secondCursor, snapshot);
    expect(orderLineItems).toContainEqual(expect.objectContaining({ label: "product_id" }));
    expect(orderLineItems).not.toContainEqual(expect.objectContaining({ label: "name" }));

    const falseAlias = "SELECT p. FROM shop.product AS p WHERE note = 'FROM shop.order_line AS p'";
    const falseAliasItems = postgresCompletions(
      falseAlias,
      falseAlias.indexOf("SELECT p.") + "SELECT p.".length,
      snapshot,
    );
    expect(falseAliasItems).toContainEqual(expect.objectContaining({ label: "name" }));
    expect(falseAliasItems).not.toContainEqual(expect.objectContaining({ label: "product_id" }));
  });

  it("creates an explicit projection, extends it once, and joins only through one foreign key", () => {
    const table = composePostgresSql(
      {
        uri: "file:///query.sql",
        text: "",
        offset: 0,
        payload: {
          kind: "table",
          serverId: "demo-server",
          database: "demo",
          oid: 1,
          schema: "shop",
          name: "product",
        },
      },
      snapshot,
    );
    expect(table).toMatchObject({ status: "edit" });
    expect(table.status === "edit" ? table.text : "").toContain("FROM\n  shop.product");

    const joined = composePostgresSql(
      {
        uri: "file:///query.sql",
        text: "SELECT ol.id FROM shop.order_line AS ol;",
        offset: 0,
        payload: {
          kind: "table",
          serverId: "demo-server",
          database: "demo",
          oid: 1,
          schema: "shop",
          name: "product",
        },
      },
      snapshot,
    );
    expect(joined.status === "edit" ? joined.text : joined).toContain(
      "ol.product_id = shop.product.id",
    );

    const column = composePostgresSql(
      {
        uri: "file:///query.sql",
        text: "SELECT p.id FROM shop.product AS p;",
        offset: 0,
        payload: {
          kind: "column",
          serverId: "demo-server",
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
  });

  it("rejects stale and cross-context composition", () => {
    const request = {
      uri: "file:///query.sql",
      text: "",
      offset: 0,
      payload: {
        kind: "table" as const,
        serverId: "other",
        database: "demo",
        oid: 1,
        schema: "shop",
        name: "product",
      },
    };
    expect(composePostgresSql(request, snapshot)).toMatchObject({ status: "rejected" });
    expect(
      composePostgresSql(
        { ...request, payload: { ...request.payload, serverId: "demo-server" } },
        { ...snapshot, status: "stale" },
      ),
    ).toMatchObject({ status: "rejected" });
  });

  it("asks for an explicit relation when several foreign keys are reliable", () => {
    const result = composePostgresSql(
      {
        uri: "file:///query.sql",
        text: "SELECT ol.id FROM shop.order_line AS ol;",
        offset: 10,
        payload: {
          kind: "table",
          serverId: "demo-server",
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
          },
        ],
      },
    );
    expect(result).toMatchObject({ status: "ambiguous", choices: [{ index: 0 }, { index: 1 }] });
  });

  it("rejects JOIN composition from unqualified, CTE, and nested relation references", () => {
    const payload = {
      kind: "table" as const,
      serverId: "demo-server",
      database: "demo",
      oid: 2,
      schema: "shop",
      name: "order_line",
    };
    expect(
      composePostgresSql(
        {
          uri: "file:///query.sql",
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
      composePostgresSql(
        {
          uri: "file:///query.sql",
          text: "WITH x AS (SELECT * FROM shop.product) SELECT * FROM x;",
          offset: 52,
          payload,
        },
        snapshot,
      ),
    ).toMatchObject({ status: "rejected" });
    const nested = "SELECT * FROM (SELECT * FROM shop.product) AS p;";
    expect(
      composePostgresSql(
        {
          uri: "file:///query.sql",
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
  ])("leaves an unsupported SELECT shape unchanged: %s", (source) => {
    expect(
      composePostgresSql(
        {
          uri: "file:///query.sql",
          text: source,
          offset: source.indexOf("shop.product"),
          payload: {
            kind: "table",
            serverId: "demo-server",
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

  it("does not interpret USING or TABLESAMPLE as relation aliases", () => {
    const usingColumn = composePostgresSql(
      {
        uri: "file:///query.sql",
        text: "SELECT p.id FROM shop.product AS p JOIN shop.order_line USING (id);",
        offset: 10,
        payload: {
          kind: "column",
          serverId: "demo-server",
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
      "shop.order_line.product_id",
    );

    const sampledJoin = composePostgresSql(
      {
        uri: "file:///query.sql",
        text: "SELECT * FROM shop.product TABLESAMPLE SYSTEM (10);",
        offset: 10,
        payload: {
          kind: "table",
          serverId: "demo-server",
          database: "demo",
          oid: 2,
          schema: "shop",
          name: "order_line",
        },
      },
      snapshot,
    );
    expect(sampledJoin.status === "edit" ? sampledJoin.text : sampledJoin).toContain(
      "shop.product.id = shop.order_line.product_id",
    );
  });

  it("preserves raw PostgreSQL aliases while resolving their canonical names", () => {
    const source = "SELECT P.id FROM Shop.Product AS P;";
    const column = composePostgresSql(
      {
        uri: "file:///query.sql",
        text: source,
        offset: source.indexOf("P.id"),
        payload: {
          kind: "column",
          serverId: "demo-server",
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
    const items = postgresCompletions(
      completionSource,
      completionSource.indexOf("SELECT P.") + "SELECT P.".length,
      snapshot,
    );
    expect(items).toContainEqual(expect.objectContaining({ label: "name", insertText: "name" }));
    const generalItems = postgresCompletions(
      "SELECT  FROM Shop.Product AS P;",
      "SELECT ".length,
      snapshot,
    );
    expect(generalItems).toContainEqual(expect.objectContaining({ label: "P", insertText: "P." }));

    const quotedAliasSource = 'SELECT "P.A". FROM shop.product AS "P.A";';
    const quotedAliasItems = postgresCompletions(
      quotedAliasSource,
      quotedAliasSource.indexOf('SELECT "P.A".') + 'SELECT "P.A".'.length,
      snapshot,
    );
    expect(quotedAliasItems).toContainEqual(expect.objectContaining({ label: "name" }));

    const quotedKeyword = 'SELECT "where".id FROM shop.product AS "where";';
    const quotedKeywordColumn = composePostgresSql(
      {
        uri: "file:///query.sql",
        text: quotedKeyword,
        offset: quotedKeyword.indexOf('"where".id'),
        payload: {
          kind: "column",
          serverId: "demo-server",
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
    const quotedKeywordItems = postgresCompletions(
      quotedKeyword,
      quotedKeyword.indexOf('SELECT "where".') + 'SELECT "where".'.length,
      snapshot,
    );
    expect(quotedKeywordItems).toContainEqual(expect.objectContaining({ label: "name" }));
  });

  it.each([
    "SELECT E'(SELECT\\';inside' AS sample FROM shop.product;",
    "SELECT 1 /* outer /* (SELECT ; inner) */ still outer ; */ FROM shop.product;",
  ])("keeps PostgreSQL lexical constructs inside the composed Statement: %s", (statement) => {
    const source = `SELECT 0 AS untouched;\n${statement}`;
    const result = composePostgresSql(
      {
        uri: "file:///query.sql",
        text: source,
        offset: source.indexOf("shop.product"),
        payload: {
          kind: "table",
          serverId: "demo-server",
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
      "shop.product.id = shop.order_line.product_id",
    );
  });

  it.each([
    "SELECT 'WHERE' AS note FROM shop.product AS p;",
    "SELECT '🙂 WHERE' AS note FROM shop.product AS p;",
    "SELECT * FROM shop.product /* WHERE fake */ AS p;",
    'SELECT "WHERE" AS marker FROM shop.product AS p;',
  ])("ignores clause keywords in literals and comments when inserting a JOIN: %s", (source) => {
    expect(scanPostgresSql(source).maskedSource).toHaveLength(source.length);
    const result = composePostgresSql(
      {
        uri: "file:///query.sql",
        text: source,
        offset: source.indexOf("shop.product"),
        payload: {
          kind: "table",
          serverId: "demo-server",
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
      "p.id = shop.order_line.product_id",
    );
  });

  it("ignores phantom relations in literals and dollar-quoted text", () => {
    const source =
      "SELECT 'FROM shop.product AS p' AS note, $$JOIN shop.product WHERE$$ AS body, \"JOIN shop.product\" AS marker FROM shop.order_line AS ol;";
    const result = composePostgresSql(
      {
        uri: "file:///query.sql",
        text: source,
        offset: source.indexOf("shop.order_line"),
        payload: {
          kind: "table",
          serverId: "demo-server",
          database: "demo",
          oid: 1,
          schema: "shop",
          name: "product",
        },
      },
      snapshot,
    );
    expect(result).toMatchObject({ status: "edit" });
    expect(result.status === "edit" ? result.text : result).toContain(
      "ol.product_id = shop.product.id",
    );
  });

  it("uses only top-level SQL clauses when composing", () => {
    const filtered = "SELECT count(*) FILTER (WHERE active) FROM shop.product AS p;";
    const joined = composePostgresSql(
      {
        uri: "file:///query.sql",
        text: filtered,
        offset: filtered.indexOf("shop.product"),
        payload: {
          kind: "table",
          serverId: "demo-server",
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
    expect(joinedText).toContain("p.id = shop.order_line.product_id");
    expect(joinedText.indexOf("LEFT JOIN shop.order_line")).toBeGreaterThan(
      joinedText.indexOf("shop.product AS p"),
    );

    const substring = "SELECT substring(name FROM 1) FROM shop.product AS p;";
    const extended = composePostgresSql(
      {
        uri: "file:///query.sql",
        text: substring,
        offset: substring.indexOf("shop.product"),
        payload: {
          kind: "column",
          serverId: "demo-server",
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

  it("preserves optional rows with LEFT JOIN from nullability and reverse direction", () => {
    const nullable = composePostgresSql(
      {
        uri: "file:///query.sql",
        text: "SELECT ol.id FROM shop.order_line AS ol;",
        offset: 10,
        payload: {
          kind: "table",
          serverId: "demo-server",
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

    const reverse = composePostgresSql(
      {
        uri: "file:///query.sql",
        text: "SELECT p.id FROM shop.product AS p;",
        offset: 9,
        payload: {
          kind: "table",
          serverId: "demo-server",
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

  it("composes only the SQL statement under the drop cursor", () => {
    const source = "SELECT 1;\nSELECT ol.id FROM shop.order_line AS ol;\nSELECT 3;";
    const result = composePostgresSql(
      {
        uri: "file:///query.sql",
        text: source,
        offset: source.indexOf("ol.id"),
        payload: {
          kind: "table",
          serverId: "demo-server",
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
    expect(result.text).toContain("JOIN shop.product ON ol.product_id = shop.product.id");
    expect(result.text).toMatch(/SELECT 3;$/u);
  });
});
