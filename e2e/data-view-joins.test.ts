/**
 * Data View composition against a real PostgreSQL and the real Code Moniker parser.
 *
 * Every table of a small relational schema is taken as the base of a Data View query (explicit
 * projection, WHERE, ORDER BY); every relation reachable through the join planner is composed in
 * turn (chained JOINs, mapping tables included), and each step must parse and EXPLAIN. Then the
 * joined relations are removed one by one and the query must still run.
 *
 * Requires: PostgreSQL e2e container running on port 5433.
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readPostgresCatalog } from "../packages/catalog/src/postgresCatalog.js";
import {
  analyzeSqlQuery,
  formatSqlQuery,
  removeRelation,
  setSort,
  setWhere,
} from "../packages/sql/src/query/analysis.js";
import { composePostgresSql, tableProjection } from "../packages/sql/src/query/composition.js";
import { planJoinPaths } from "../packages/sql/src/query/joinPlanner.js";
import {
  DEFAULT_SQL_AUTHORING_SETTINGS,
  type SqlAuthoringSnapshot,
} from "../packages/sql/src/snapshot.js";
import { canonicalSqlIdentifier } from "../packages/sql/src/text/identifiers.js";
import { type CodeMonikerTestRuntime, startCodeMonikerTestRuntime } from "./codeMonikerRuntime.js";

const CONNECTION = {
  host: "localhost",
  port: 5433,
  database: "postgres",
  user: "postgres",
  password: "postgres",
};

const SCHEMA_SQL = `
DROP SCHEMA IF EXISTS join_sweep CASCADE;
CREATE SCHEMA join_sweep;
SET search_path = join_sweep;
CREATE TABLE brand (id serial PRIMARY KEY, name text NOT NULL);
CREATE TABLE category (id serial PRIMARY KEY, title text NOT NULL, parent_id int REFERENCES category(id));
CREATE TABLE product (id serial PRIMARY KEY, name text NOT NULL, price numeric NOT NULL, brand_id int REFERENCES brand(id));
CREATE TABLE product_category (product_id int NOT NULL REFERENCES product(id), category_id int NOT NULL REFERENCES category(id), featured boolean NOT NULL DEFAULT false, PRIMARY KEY (product_id, category_id));
CREATE TABLE address (id serial PRIMARY KEY, city text NOT NULL);
CREATE TABLE customer (id serial PRIMARY KEY, name text NOT NULL, home_address_id int REFERENCES address(id));
CREATE TABLE sales_order (id serial PRIMARY KEY, customer_id int NOT NULL REFERENCES customer(id), billing_address_id int NOT NULL REFERENCES address(id), shipping_address_id int REFERENCES address(id), status text NOT NULL);
CREATE TABLE sales_order_line (id serial PRIMARY KEY, sales_order_id int NOT NULL REFERENCES sales_order(id), product_id int NOT NULL REFERENCES product(id), quantity int NOT NULL);
CREATE TABLE "Odd Table" (id serial PRIMARY KEY, "order" int REFERENCES sales_order(id), "select" text);
CREATE VIEW order_overview AS SELECT o.id, o.status, c.name AS customer FROM sales_order o JOIN customer c ON c.id = o.customer_id;
`;

describe("Data View JOIN composition on PostgreSQL", () => {
  let codeMoniker: CodeMonikerTestRuntime;
  let client: Client;
  let snapshot: SqlAuthoringSnapshot;

  beforeAll(async () => {
    codeMoniker = await startCodeMonikerTestRuntime();
    client = new Client(CONNECTION);
    await client.connect();
    await client.query(SCHEMA_SQL);
    const catalog = await readPostgresCatalog(client, { serverId: "e2e", database: "postgres" });
    const relations = await client.query<{
      oid: number;
      schema: string;
      name: string;
      kind: string;
      columns: { name: string; type: string }[] | null;
    }>(`
      SELECT c.oid::int AS oid, n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
             (SELECT json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod)) ORDER BY a.attnum)
                FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'join_sweep' AND c.relkind IN ('r', 'v')
      ORDER BY c.relname`);
    snapshot = {
      status: "available",
      serverId: "e2e",
      database: "postgres",
      revision: "r1",
      generation: 1,
      objects: relations.rows.map((row) => ({
        serverId: "e2e",
        database: "postgres",
        schema: row.schema,
        oid: Number(row.oid),
        name: row.name,
        kind: row.kind === "v" ? "view" : "table",
        signature: "",
        parameters: [],
        columns: row.columns ?? [],
      })),
      foreignKeys: catalog.foreignKeys,
    };
  }, 60_000);

  afterAll(async () => {
    await client?.query("DROP SCHEMA IF EXISTS join_sweep CASCADE").catch(() => {});
    await client?.end().catch(() => {});
    await codeMoniker?.dispose();
  });

  const analyze = async (text: string) => {
    const analyzed = await analyzeSqlQuery(text, codeMoniker.parser);
    if (analyzed.status !== "ok") throw new Error(`${analyzed.message}\n${text}`);
    return analyzed.analysis;
  };

  /** Composes as the server does once it has the syntax: analyze the statement, then run the engine. */
  const compose = async (text: string, target: SqlAuthoringSnapshot["objects"][number]) => {
    const analyzed = await analyzeSqlQuery(text, codeMoniker.parser);
    if (analyzed.status !== "ok") throw new Error(`${analyzed.message}\n${text}`);
    const analysis = analyzed.analysis;
    const request = {
      text,
      offset: analysis.statement.end,
      payload: {
        kind: target.kind === "view" ? ("view" as const) : ("table" as const),
        serverId: "e2e",
        database: "postgres",
        oid: target.oid,
        schema: target.schema,
        name: target.name,
      },
    };
    let result = composePostgresSql(
      request,
      snapshot,
      DEFAULT_SQL_AUTHORING_SETTINGS,
      analysis,
      analyzed.shape,
    );
    if (result.status === "ambiguous") {
      result = composePostgresSql(
        { ...request, relationChoice: 0 },
        snapshot,
        DEFAULT_SQL_AUTHORING_SETTINGS,
        analysis,
        analyzed.shape,
      );
    }
    return result;
  };

  const runs = async (text: string) => {
    await analyze(text);
    await client.query(`EXPLAIN ${text}`);
  };

  it("chains JOINs from every table (through mapping tables) with WHERE and ORDER BY, then removes them", async () => {
    const tables = snapshot.objects.filter(
      (object) => object.kind === "table" && object.columns.length > 0,
    );
    expect(tables.length).toBeGreaterThan(5);
    let composed = 0;
    let removed = 0;
    for (const base of tables) {
      let text = tableProjection(base, DEFAULT_SQL_AUTHORING_SETTINGS).replace(/;\s*$/u, "");
      const initial = await analyze(text);
      const firstTarget = initial.targets[0];
      if (!firstTarget) throw new Error(`no projection for ${base.name}`);
      text = formatSqlQuery(setWhere(text, initial, `${firstTarget.expression} IS NOT NULL`));
      text = formatSqlQuery(
        setSort(text, await analyze(text), [
          { column: firstTarget.label, direction: "descending" },
        ]),
      );
      await runs(text);
      const present = [base.oid];
      let joined = 0;
      for (const target of snapshot.objects) {
        if (joined >= 3 || present.includes(target.oid)) continue;
        // The relations the query names, read from the syntax tree and resolved on the snapshot.
        const joinedAnalysis = await analyze(text);
        const referencedOids = joinedAnalysis.relations.flatMap((relation) => {
          const object = snapshot.objects.find(
            (candidate) =>
              canonicalSqlIdentifier(candidate.name) === canonicalSqlIdentifier(relation.name) &&
              (relation.schema === undefined ||
                canonicalSqlIdentifier(candidate.schema) ===
                  canonicalSqlIdentifier(relation.schema)),
          );
          return object ? [object.oid] : [];
        });
        const plans = planJoinPaths(snapshot, referencedOids, target.oid, { maxHops: 2 });
        if (plans.length === 0) continue;
        const result = await compose(text, target);
        expect(result.status, `${base.name} + ${target.name}`).toBe("edit");
        if (result.status !== "edit") return;
        await runs(result.text);
        text = result.text;
        present.push(target.oid);
        joined += 1;
        composed += 1;
      }
      let analysis = await analyze(text);
      for (const relation of [...analysis.relations].reverse()) {
        if (!relation.join) continue;
        const removal = removeRelation(text, analysis, relation, []);
        expect(removal.status, `${base.name} - ${relation.name}`).toBe("removed");
        if (removal.status !== "removed") return;
        text = formatSqlQuery(removal.text);
        await runs(text);
        analysis = await analyze(text);
        removed += 1;
      }
    }
    expect(composed).toBeGreaterThan(15);
    expect(removed).toBeGreaterThan(10);
  }, 120_000);

  it("writes a NULLS ordering only when asked, and reads back the one it wrote", async () => {
    const base = snapshot.objects.find((object) => object.columns.length > 1);
    if (!base) throw new Error("no table to sort");
    const text = tableProjection(base, DEFAULT_SQL_AUTHORING_SETTINGS).replace(/;\s*$/u, "");
    const column = (await analyze(text)).targets[0]?.label;
    if (!column) throw new Error("no projection to sort by");

    /*
     * A criterion that says nothing about NULLs reads as PostgreSQL reads it, and is written that
     * way — the grid used to force NULLS FIRST on every ascending sort, which is the opposite of
     * what PostgreSQL does and what nothing on screen said.
     */
    const plain = formatSqlQuery(
      setSort(text, await analyze(text), [{ column, direction: "ascending" }]),
    );
    expect(plain).toMatch(/ORDER BY[\s\S]*ASC\s*$/u);
    expect(plain).not.toMatch(/NULLS/iu);
    expect((await analyze(plain)).sortItems[0]?.nulls).toBeUndefined();
    await runs(plain);

    // And one that does say so keeps saying it, through the writer and back out of the parser.
    for (const nulls of ["first", "last"] as const) {
      const written = formatSqlQuery(
        setSort(text, await analyze(text), [{ column, direction: "descending", nulls }]),
      );
      expect(written).toMatch(new RegExp(`DESC NULLS ${nulls.toUpperCase()}`, "u"));
      const read = (await analyze(written)).sortItems[0];
      expect(read?.direction).toBe("descending");
      expect(read?.nulls).toBe(nulls);
      await runs(written);
    }
  });

  it("offers every shortest path and joins through a mapping table with reserved identifiers", async () => {
    const product = snapshot.objects.find((object) => object.name === "product");
    const category = snapshot.objects.find((object) => object.name === "category");
    const order = snapshot.objects.find((object) => object.name === "sales_order");
    const address = snapshot.objects.find((object) => object.name === "address");
    const odd = snapshot.objects.find((object) => object.name === "Odd Table");
    if (!product || !category || !order || !address || !odd) throw new Error("fixture");
    const viaMapping = await compose(
      tableProjection(product, DEFAULT_SQL_AUTHORING_SETTINGS).replace(/;\s*$/u, ""),
      category,
    );
    expect(viaMapping.status).toBe("edit");
    if (viaMapping.status !== "edit") return;
    expect(viaMapping.title).toBe("Join join_sweep.category via product_category");
    await runs(viaMapping.text);

    const orderText = tableProjection(order, DEFAULT_SQL_AUTHORING_SETTINGS).replace(/;\s*$/u, "");
    const analyzedOrder = await analyzeSqlQuery(orderText, codeMoniker.parser);
    if (analyzedOrder.status !== "ok") throw new Error(analyzedOrder.message);
    const analysis = analyzedOrder.analysis;
    const ambiguous = composePostgresSql(
      {
        text: orderText,
        offset: analysis.statement.end,
        payload: {
          kind: "table",
          serverId: "e2e",
          database: "postgres",
          oid: address.oid,
          schema: address.schema,
          name: address.name,
        },
      },
      snapshot,
      DEFAULT_SQL_AUTHORING_SETTINGS,
      analysis,
      analyzedOrder.shape,
    );
    expect(ambiguous.status).toBe("ambiguous");
    if (ambiguous.status !== "ambiguous") return;
    // billing, shipping, and customer.home_address are all 1-hop or 2-hop; only the shortest are offered.
    expect(ambiguous.choices.map((choice) => choice.label)).toEqual([
      "sales_order.billing_address_id → address.id",
      "sales_order.shipping_address_id → address.id",
    ]);

    const oddJoin = await compose(orderText, odd);
    expect(oddJoin.status).toBe("edit");
    if (oddJoin.status !== "edit") return;
    await runs(oddJoin.text);
    expect(oddJoin.text).toContain('"Odd Table"');
  });
});
