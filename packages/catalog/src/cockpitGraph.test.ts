import { describe, expect, it } from "vitest";
import {
  COCKPIT_BATCH_SIZE,
  initialCockpitGraph,
  neighborhoodFromGraph,
  presentationsForSymbols,
  resolveCockpitTarget,
  searchGraphObjects,
  sourcePreviewPresentation,
} from "./cockpitGraph.js";
import type { CodeMonikerGraphResult, CodeMonikerSymbol } from "./localCodeMoniker.js";
import type { PostgresDocumentDescriptor } from "./postgresCatalog.js";

const database = { connectionId: "localhost:5433/testdb:postgres", database: "testdb" };
const databasePrefix =
  "code+moniker://./srcset:postgres/lang:sql/dir:postgresql:/dir:localhost%3A5433%2Ftestdb%3Apostgres/dir:testdb";

function symbol(name: string, kind: string, oid: number, schema = "shop"): CodeMonikerSymbol {
  const documentKind: PostgresDocumentDescriptor["documentKind"] =
    kind === "function" || kind === "procedure"
      ? "routine"
      : (kind as PostgresDocumentDescriptor["documentKind"]);
  const signature = kind === "function" || kind === "procedure" ? "()" : "";
  return {
    uri: `${databasePrefix}/dir:${schema}/dir:${documentKind}/module:${name}${signature}/schema:${schema}/${kind}:${name}${signature}`,
    name,
    kind,
    file: `postgresql://${encodeURIComponent(database.connectionId)}/${database.database}/${schema}/${documentKind}/${encodeURIComponent(`${name}${signature}`)}.sql`,
    signature: "",
    postgres: {
      ...database,
      schema,
      documentKind,
      oid,
      name,
      signature: "",
    },
  };
}

function graph(
  focus: CodeMonikerSymbol,
  callers: Array<{ symbol: CodeMonikerSymbol; kinds: string[]; count?: number }> = [],
  callees: Array<{ symbol: CodeMonikerSymbol; kinds: string[]; count?: number }> = [],
): CodeMonikerGraphResult {
  return {
    focus: { kind: "symbol", symbol: focus },
    callers: callers.map((neighbor) => ({ ...neighbor, count: neighbor.count ?? 1 })),
    callees: callees.map((neighbor) => ({ ...neighbor, count: neighbor.count ?? 1 })),
    coverage: {
      callers: { matching: callers.length, returned: callers.length, total: callers.length },
      callees: { matching: callees.length, returned: callees.length, total: callees.length },
      internal_edges: { matching: 0, returned: 0, total: 0 },
      members: { matching: 0, returned: 0, total: 0 },
    },
    unlinked: { external: 0, manifest_blocked: 0, unresolved: 0 },
  };
}

describe("SQL cockpit projection", () => {
  it("treats database and schema scopes as search-first landings", () => {
    const product = symbol("product", "table", 10);
    const schema = symbol("shop", "schema", 1);
    expect(resolveCockpitTarget(databasePrefix, [product], database)).toEqual({ kind: "landing" });
    expect(resolveCockpitTarget(schema.uri, [schema, product], database)).toEqual({
      kind: "landing",
      schemaHint: "shop",
    });
    expect(resolveCockpitTarget(product.uri, [product], database)).toMatchObject({
      kind: "object",
    });
  });

  it("starts from a bounded directional neighborhood rather than a schema graph", () => {
    const focus = symbol("process_order", "function", 20);
    const callers = Array.from({ length: 7 }, (_, index) => ({
      symbol: symbol(`caller_${index}`, "function", 30 + index),
      kinds: ["calls"],
      count: index + 1,
    }));
    const callees = Array.from({ length: 8 }, (_, index) => ({
      symbol: symbol(`table_${index}`, "table", 50 + index),
      kinds: [index % 2 === 0 ? "writes" : "reads"],
      count: index + 1,
    }));
    const neighborhood = neighborhoodFromGraph(graph(focus, callers, callees));
    const projected = initialCockpitGraph(neighborhood);

    expect(COCKPIT_BATCH_SIZE).toBe(3);
    expect(projected.nodes).toHaveLength(1 + COCKPIT_BATCH_SIZE * 2);
    expect(projected.edges).toHaveLength(COCKPIT_BATCH_SIZE * 2);
    expect(neighborhood.incoming[0].symbol.name).toBe("caller_6");
    expect(neighborhood.outgoing[0].symbol.name).toBe("table_6");
  });

  it("searches PostgreSQL objects and table members without rendering them", () => {
    const orders = symbol("orders", "table", 70);
    const customerId: CodeMonikerSymbol = {
      ...orders,
      uri: `${orders.uri}/column:customer_id`,
      name: "customer_id",
      kind: "column",
      signature: "uuid",
    };
    expect(
      searchGraphObjects([orders, customerId], database, "customer uuid", () => ({
        kind: "workspace",
      })),
    ).toEqual([
      expect.objectContaining({
        symbolUri: orders.uri,
        label: "orders.customer_id",
        kind: "column",
        countStatus: "loading",
      }),
    ]);
  });

  it("returns schemas as filterable search results", () => {
    const orders = symbol("orders", "table", 71);
    const result = searchGraphObjects([orders], database, "shop", () => ({ kind: "workspace" }));
    expect(result[0]).toMatchObject({
      label: "shop",
      schema: "shop",
      kind: "schema",
      resultType: "schema",
      detail: "1 objects · filter this schema",
    });
  });

  it("supports discoverable #schema and @type filters plus legacy query forms", () => {
    const orders = symbol("orders", "table", 72);
    const refund = symbol("refund", "function", 73);
    const audit = symbol("orders_audit", "table", 74, "public");
    const origin = () => ({ kind: "workspace" });

    expect(
      searchGraphObjects([orders, refund, audit], database, "schema:shop type:table", origin),
    ).toEqual([expect.objectContaining({ label: "orders", schema: "shop", resultType: "object" })]);
    expect(searchGraphObjects([orders, refund, audit], database, "#shop @table", origin)).toEqual([
      expect.objectContaining({ label: "orders", schema: "shop", resultType: "object" }),
    ]);
    expect(searchGraphObjects([orders, refund, audit], database, "table:orders", origin)).toEqual([
      expect.objectContaining({ label: "orders", kind: "table" }),
      expect.objectContaining({ label: "orders_audit", kind: "table" }),
    ]);
  });

  it("collapses column-level relation facts into their owning PostgreSQL object", () => {
    const product = symbol("product", "table", 75);
    const brand = symbol("brand", "table", 76);
    const brandId: CodeMonikerSymbol = {
      ...brand,
      uri: `${brand.uri}/column:id`,
      name: "id",
      kind: "column",
      signature: "bigint",
    };
    const neighborhood = neighborhoodFromGraph(
      graph(
        product,
        [],
        [
          { symbol: brand, kinds: ["references"] },
          { symbol: brandId, kinds: ["references"] },
        ],
      ),
      database,
      [product, brand, brandId],
    );
    expect(neighborhood.outgoing).toHaveLength(1);
    expect(neighborhood.outgoing[0]).toMatchObject({
      symbol: { uri: brand.uri, name: "brand", kind: "table" },
      kinds: ["references"],
      count: 2,
    });
  });

  it("preserves the exact Code Moniker source range", () => {
    const view = symbol("product_view", "view", 81);
    const preview = sourcePreviewPresentation({
      symbol: view,
      source: {
        file: view.file,
        first_line: 1,
        last_line: 2,
        lines: [
          { number: 1, text: "CREATE VIEW product_view AS SELECT * FROM product" },
          { number: 2, text: "SELECT 'product'" },
        ],
      },
    });
    expect(preview).toMatchObject({
      symbolUri: view.uri,
      editorUri: `file:///postgresql-workbench/cockpit-previews/${encodeURIComponent(encodeURIComponent(view.uri))}.sql`,
      firstLine: 1,
      lastLine: 2,
      lines: [
        { number: 1, text: "CREATE VIEW product_view AS SELECT * FROM product" },
        { number: 2, text: "SELECT 'product'" },
      ],
    });
    expect(preview.editorUri).not.toBe(view.file);
  });

  it("advertises secondary cockpit actions only for PL/pgSQL routines", () => {
    const table = symbol("orders", "table", 20);
    const routine = symbol("refresh_orders", "function", 30);
    routine.source = {
      file: routine.file,
      first_line: 1,
      last_line: 2,
      lines: [
        { number: 1, text: "CREATE FUNCTION refresh_orders() RETURNS void AS $$" },
        { number: 2, text: "$$ LANGUAGE plpgsql;" },
      ],
    };
    const presentations = presentationsForSymbols([table, routine], database, () => undefined);

    expect(presentations[table.uri]?.hasCockpitActions).toBe(false);
    expect(presentations[routine.uri]?.hasCockpitActions).toBe(true);
  });
});
