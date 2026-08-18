import { describe, expect, it, vi } from "vitest";
import type { CodeMonikerClient, CodeMonikerSymbol } from "./localCodeMoniker.js";
import { PostgresCatalogFullRefreshRequired, type VirtualSqlDocument } from "./postgresCatalog.js";
import {
  buildPostgresResourceIndex,
  directPostgresDocumentUris,
} from "./postgresSourceProvider.js";

const IDENTITY = { serverId: "local", database: "app" };

describe("PostgreSQL SourceSet provider", () => {
  it("uses every incoming-usage page to select the changed table and its direct dependent", async () => {
    const orders = document("table", 10, "orders");
    const ordersView = document("view", 20, "orders_view");
    const unrelated = document("view", 21, "unrelated_view");
    const documents = new Map(
      [orders, ordersView, unrelated].map((entry) => [entry.uri, entry] as const),
    );
    const symbols = [
      symbol(orders, "table", "code+moniker://sql/table/orders"),
      symbol(ordersView, "view", "code+moniker://sql/view/orders_view"),
      symbol(unrelated, "view", "code+moniker://sql/view/unrelated_view"),
    ];
    const otherConnexionUsage =
      "postgresql://other%3A5432%2Fapp%3Apostgres/app/app/view/orders_view.sql";
    const usages = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          rows: [
            { direction: "incoming", file: ordersView.uri },
            { direction: "incoming", file: otherConnexionUsage },
          ],
          total: 3,
        },
        generation: 1,
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        data: { rows: [{ direction: "incoming", file: ordersView.uri }], total: 3 },
        generation: 1,
        nextCursor: null,
      });

    const selected = await directPostgresDocumentUris(
      { symbols: { usages } } as unknown as CodeMonikerClient,
      { documents, resources: buildPostgresResourceIndex(documents, symbols) },
      [
        ddlObject("table", 10, "ALTER TABLE"),
        ddlObject("type", 11, "ALTER TYPE"),
        ddlObject("table constraint", 12, "ALTER TABLE"),
      ],
    );

    expect([...selected.documentUris]).toEqual([orders.uri, ordersView.uri]);
    expect(selected.documentUris.has(otherConnexionUsage)).toBe(false);
    expect(selected.newResources).toEqual([{ kind: "constraint", oid: 12 }]);
    expect(usages).toHaveBeenNthCalledWith(
      1,
      "code+moniker://sql/table/orders",
      { direction: "incoming" },
      { consistency: "stale_ok", limit: 500, cursor: null },
    );
    expect(usages).toHaveBeenNthCalledWith(
      2,
      "code+moniker://sql/table/orders",
      { direction: "incoming" },
      { consistency: "stale_ok", limit: 500, cursor: "page-2" },
    );
  });

  it("uses the indexed function symbol to select its direct SQL caller", async () => {
    const routine = document("routine", 30, "total_orders", "total_orders()");
    const dashboard = document("view", 40, "dashboard");
    const documents = new Map([routine, dashboard].map((entry) => [entry.uri, entry] as const));
    const usages = vi.fn().mockResolvedValue({
      data: { rows: [{ direction: "incoming", file: dashboard.uri }], total: 1 },
      generation: 2,
      nextCursor: null,
    });
    const symbols = [
      symbol(routine, "function", "code+moniker://sql/function/total_orders"),
      symbol(dashboard, "view", "code+moniker://sql/view/dashboard"),
    ];

    const selected = await directPostgresDocumentUris(
      { symbols: { usages } } as unknown as CodeMonikerClient,
      { documents, resources: buildPostgresResourceIndex(documents, symbols) },
      [ddlObject("function", 30, "ALTER FUNCTION")],
    );

    expect([...selected.documentUris]).toEqual([routine.uri, dashboard.uri]);
    expect(selected.newResources).toEqual([]);
    expect(usages).toHaveBeenCalledWith(
      "code+moniker://sql/function/total_orders",
      { direction: "incoming" },
      { consistency: "stale_ok", limit: 500, cursor: null },
    );
  });

  it("selects a newly created resource by its PostgreSQL OID without inventing a symbol", async () => {
    const orders = document("table", 10, "orders");

    const selected = await directPostgresDocumentUris(
      { symbols: { usages: vi.fn() } } as unknown as CodeMonikerClient,
      { documents: new Map([[orders.uri, orders]]), resources: new Map() },
      [ddlObject("table", 42, "CREATE TABLE")],
    );

    expect(selected.documentUris).toEqual(new Set());
    expect(selected.newResources).toEqual([{ kind: "relation", oid: 42 }]);
  });

  it("requires a full SourceSet replacement for an unknown dropped resource", async () => {
    const dropped = { ...ddlObject("table", 42, "DROP TABLE"), original: true };

    await expect(
      directPostgresDocumentUris(
        { symbols: { usages: vi.fn() } } as unknown as CodeMonikerClient,
        { documents: new Map(), resources: new Map() },
        [dropped],
      ),
    ).rejects.toBeInstanceOf(PostgresCatalogFullRefreshRequired);
  });
});

function document(
  documentKind: NonNullable<VirtualSqlDocument["postgres"]>["documentKind"],
  oid: number,
  name: string,
  signature = name,
): VirtualSqlDocument {
  return {
    uri: `postgresql://local/app/app/${documentKind}/${encodeURIComponent(signature)}.sql`,
    language: "sql",
    content: `-- ${signature}`,
    postgres: { ...IDENTITY, schema: "app", documentKind, oid, name, signature },
  };
}

function symbol(source: VirtualSqlDocument, kind: string, uri: string): CodeMonikerSymbol {
  return {
    uri,
    name: source.postgres!.name,
    kind,
    file: source.uri,
    signature: source.postgres!.signature,
  };
}

function ddlObject(objectType: string, objectId: number, commandTag: string) {
  return {
    classId: 1259,
    objectId,
    objectSubId: 0,
    commandTag,
    objectType,
    schemaName: "app",
    objectIdentity: `app.${objectId}`,
  };
}
