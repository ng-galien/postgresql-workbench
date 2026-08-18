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
  let selectionListener: ((event: { selection: readonly PlpgsqlTreeItem[] }) => void) | undefined;
  const graph = {
    currentDatabase: { serverId: "server", database: "testdb" },
    currentScope: "testdb",
    isOpen: true,
    openDatabase: vi.fn(async () => true),
    syncSchemaFromTree: vi.fn(async () => true),
    syncObjectFromTree: vi.fn(async () => true),
  };
  const sync = new WorkbenchGraphTreeSync(
    {
      reveal,
      onDidChangeSelection: vi.fn((listener) => {
        selectionListener = listener;
        return { dispose: vi.fn() };
      }),
    } as never,
    { itemForObject: vi.fn(() => item) } as never,
    {
      databaseState: vi.fn((identity: { serverId: string }) =>
        identity.serverId === "server" ? snapshot : { status: "not-indexed" },
      ),
    } as never,
    graph as never,
  );
  return {
    emitSelection(selection: readonly PlpgsqlTreeItem[]) {
      selectionListener?.({ selection });
    },
    graph,
    item,
    reveal,
    sync,
  };
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

  it("does not retain a completed programmatic reveal as a future user selection", async () => {
    const { emitSelection, graph, item, sync } = fixture();
    sync.bind();

    expect(await sync.revealObject(object)).toBe(true);
    emitSelection([item]);
    await vi.waitFor(() =>
      expect(graph.syncObjectFromTree).toHaveBeenCalledWith(object, snapshot.result),
    );
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

    expect(
      await sync.select({
        kind: "schema",
        schema: "shop",
        server: {
          id: "server",
          host: "localhost",
          port: 5432,
          database: "testdb",
          user: "postgres",
        },
      } as PlpgsqlTreeItem),
    ).toBe(true);
    expect(graph.syncSchemaFromTree).toHaveBeenCalledWith("shop", snapshot.result);
  });

  it("retains the last business selection for the Sources header command", async () => {
    const { graph, sync } = fixture();
    const member = { kind: "tableMember", object } as PlpgsqlTreeItem;

    expect(await sync.select(member)).toBe(true);
    expect(sync.currentSelection).toBe(member);
    expect(graph.syncObjectFromTree).toHaveBeenCalledWith(object, snapshot.result);
  });

  it("does not project an unindexed Connexion into the Cockpit", async () => {
    const { graph, sync } = fixture();
    const inactive = {
      kind: "sourcesSnapshot",
      server: {
        id: "other-server",
        host: "localhost",
        port: 5433,
        database: "otherdb",
        user: "postgres",
      },
    } as PlpgsqlTreeItem;

    expect(await sync.select(inactive)).toBe(false);
    expect(graph.openDatabase).not.toHaveBeenCalled();
  });

  it("forgets a tree selection when the Cockpit Connexion changes", async () => {
    const { item, sync } = fixture();

    await sync.select(item);
    sync.invalidateCockpitContext();

    expect(sync.currentSelection).toBeUndefined();
  });
});
