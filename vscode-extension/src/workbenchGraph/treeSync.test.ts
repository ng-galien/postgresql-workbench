import { describe, expect, it, vi } from "vitest";
import type { WorkbenchObjectModel } from "../workbenchTreeModel.js";
import type { PlpgsqlTreeItem } from "../workbenchTreeProvider.js";
import { WorkbenchGraphTreeSync } from "./treeSync.js";

const snapshot = {
  status: "available" as const,
  result: {
    serverId: "server",
    database: "testdb",
    revision: "revision",
    generation: 4,
  },
};

const object: WorkbenchObjectModel = {
  symbolUri: "sql:table:orders",
  sourceUri: "postgresql://server/testdb/shop/table/12.sql",
  serverId: "server",
  database: "testdb",
  schema: "shop",
  oid: 12,
  name: "orders",
  kind: "table",
  signature: "",
  params: [],
  plpgsql: false,
};

function fixture() {
  const item = { kind: "object", object } as PlpgsqlTreeItem;
  const reveal = vi.fn(async () => undefined);
  const graph = {
    currentScope: "testdb",
    openDatabase: vi.fn(async () => true),
    syncSchemaFromTree: vi.fn(async () => true),
    syncObjectFromTree: vi.fn(async () => true),
  };
  const sync = new WorkbenchGraphTreeSync(
    {
      reveal,
      onDidChangeSelection: vi.fn(),
    } as never,
    { itemForObject: vi.fn(() => item) } as never,
    { state: snapshot } as never,
    graph as never,
  );
  return { graph, item, reveal, sync };
}

describe("Workbench graph and Sources tree synchronization", () => {
  it("reveals a graph selection in the native Sources tree", async () => {
    const { item, reveal, sync } = fixture();

    expect(await sync.revealObject(object)).toBe(true);
    expect(reveal).toHaveBeenCalledWith(item, {
      select: true,
      focus: false,
      expand: true,
    });
  });

  it("navigates a relation target to its canonical tree item and keeps the cockpit aligned", async () => {
    const { graph, item, reveal, sync } = fixture();

    expect(await sync.navigateToObject(object)).toBe(true);
    expect(reveal).toHaveBeenCalledWith(item, {
      select: true,
      focus: true,
      expand: true,
    });
    expect(graph.syncObjectFromTree).toHaveBeenCalledWith(object, snapshot.result);
  });

  it("routes native tree selections back into the existing graph cockpit", async () => {
    const { graph, item, sync } = fixture();

    expect(await sync.select(item)).toBe(true);
    expect(graph.syncObjectFromTree).toHaveBeenCalledWith(object, snapshot.result);

    expect(await sync.select({ kind: "schema", schema: "shop" } as PlpgsqlTreeItem)).toBe(true);
    expect(graph.syncSchemaFromTree).toHaveBeenCalledWith("shop", snapshot.result);
  });

  it("retains the last business selection for the Sources header command", async () => {
    const { graph, sync } = fixture();
    const member = { kind: "tableMember", object } as PlpgsqlTreeItem;

    expect(await sync.select(member)).toBe(true);
    expect(sync.currentSelection).toBe(member);
    expect(graph.syncObjectFromTree).toHaveBeenCalledWith(object, snapshot.result);
  });

  it("does not project an inactive database context into the active graph", async () => {
    const { graph, sync } = fixture();
    const inactive = {
      kind: "sourcesSnapshot",
      active: false,
      server: { id: "other-server", database: "otherdb" },
    } as PlpgsqlTreeItem;

    expect(await sync.select(inactive)).toBe(false);
    expect(graph.openDatabase).not.toHaveBeenCalled();
  });

  it("forgets a tree selection when the active database context changes", async () => {
    const { item, sync } = fixture();

    await sync.select(item);
    sync.invalidateDatabaseContext();

    expect(sync.currentSelection).toBeUndefined();
  });
});
