import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => {
  class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();
    readonly event = (listener: (value: T) => void) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }
    dispose(): void {
      this.listeners.clear();
    }
  }
  class TreeItem {
    accessibilityInformation?: { label: string };
    command?: unknown;
    contextValue?: string;
    description?: string;
    iconPath?: unknown;
    id?: string;
    tooltip?: string;

    constructor(
      readonly label: string,
      readonly collapsibleState: number,
    ) {}
  }

  return {
    EventEmitter,
    ThemeColor: class {
      constructor(readonly id: string) {}
    },
    ThemeIcon: class {
      constructor(
        readonly id: string,
        readonly color?: unknown,
      ) {}
    },
    TreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
  };
});

import type { WorkbenchIndexState } from "./workbenchIndexController.js";
import type { WorkbenchObjectModel } from "./workbenchTreeModel.js";
import {
  DatabaseSourceItem,
  FunctionItem,
  SchemaItem,
  SOURCES_DRAG_HINT,
  SourcesSnapshotItem,
  WorkbenchObjectItem,
  WorkbenchRelationTargetItem,
  WorkbenchTableMemberItem,
  WorkbenchTreeProvider,
} from "./workbenchTreeProvider.js";

const snapshot = { revision: "revision", generation: 7 };
const table: WorkbenchObjectModel = {
  symbolUri: "code+moniker://./lang:sql/table:shop.orders",
  sourceUri: "postgresql://server/testdb/shop/table/orders.sql",
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

const unchangedTable: WorkbenchObjectModel = {
  ...table,
  symbolUri: "code+moniker://./lang:sql/table:reporting.warehouse",
  sourceUri: "postgresql://server/testdb/reporting/table/warehouse.sql",
  schema: "reporting",
  oid: 13,
  name: "warehouse",
};

const createdTable: WorkbenchObjectModel = {
  ...table,
  symbolUri: "code+moniker://./lang:sql/table:shop.workbench_ddl_sync_probe",
  sourceUri: "postgresql://server/testdb/shop/table/workbench_ddl_sync_probe.sql",
  oid: 14,
  name: "workbench_ddl_sync_probe",
};

describe("Workbench tree object navigation", () => {
  it("scopes a disconnect event to its exact Connexion branch", async () => {
    const serverA = {
      id: "server-a",
      name: "A",
      host: "localhost",
      port: 5432,
      database: "a",
      user: "postgres",
    };
    const serverB = { ...serverA, id: "server-b", name: "B", database: "b" };
    const connected = new Set([serverA.id, serverB.id]);
    type ConnectionChange = {
      serverIds: readonly string[];
      rootsChanged: boolean;
    };
    const listeners = new Set<(change: ConnectionChange) => void>();
    const changes = {
      event: (listener: (change: ConnectionChange) => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      fire: (change: ConnectionChange) => {
        for (const listener of listeners) listener(change);
      },
    };
    const event = () => ({ dispose: () => undefined });
    const result = (server: typeof serverA) => ({
      serverId: server.id,
      database: server.database,
      revision: `revision-${server.id}`,
      documents: 1,
      symbols: 1,
      generation: 1,
      introspectionMs: 1,
      materializationMs: 1,
      publicationMs: 1,
      symbolQueryMs: 1,
      indexingMs: 1,
      graphQueryMs: 1,
    });
    const schemaSymbol = (server: typeof serverA, schema: string) => ({
      uri: `code+moniker://${server.id}/${schema}`,
      file: `postgresql://${server.id}/${server.database}/${schema}/schema.sql`,
      name: schema,
      kind: "schema",
      signature: schema,
      postgres: {
        serverId: server.id,
        database: server.database,
        schema,
        documentKind: "schema",
        oid: 1,
        name: schema,
        signature: schema,
      },
    });
    const provider = new WorkbenchTreeProvider(
      {
        servers: [serverA, serverB],
        store: { get: (id: string) => [serverA, serverB].find((server) => server.id === id) },
        debugCapabilityFor: (serverId: string) => ({
          serverId,
          status: "unavailable" as const,
        }),
        onChanged: changes.event,
        isServerConnected: (id: string) => connected.has(id),
        getClient: () => undefined,
      } as never,
      {
        databaseState: ({ serverId }: { serverId: string }) => {
          const server = serverId === serverA.id ? serverA : serverB;
          return { status: "available", serverId, result: result(server) };
        },
        databaseSymbols: ({ serverId }: { serverId: string }) =>
          serverId === serverA.id
            ? [schemaSymbol(serverA, "alpha")]
            : [schemaSymbol(serverB, "beta")],
        onDidChangeState: event,
      } as never,
      { list: async () => [], onDidChangeEntries: event } as never,
      { transaction: () => undefined, onDidChange: event } as never,
      {
        state: (serverId: string) => ({
          serverId,
          status: "disabled" as const,
          supportSchema: "workbench",
        }),
        onDidChangeState: event,
      } as never,
    );
    const roots = await provider.getChildren();
    const rootA = roots[0];
    const rootB = roots[1];
    const databaseA = (await provider.getChildren(rootA))[0];
    const databaseB = (await provider.getChildren(rootB))[0];
    const sourcesA = (await provider.getChildren(databaseA)).find(
      (item) => item.kind === "sourcesSnapshot",
    );
    const sourcesB = (await provider.getChildren(databaseB)).find(
      (item) => item.kind === "sourcesSnapshot",
    );
    expect(sourcesA).toBeDefined();
    expect(sourcesB).toBeDefined();
    await expect(provider.getChildren(sourcesA)).resolves.toMatchObject([{ label: "alpha" }]);
    await expect(provider.getChildren(sourcesB)).resolves.toMatchObject([{ label: "beta" }]);
    const emitted: Array<{ id?: string } | undefined> = [];
    provider.onDidChangeTreeData((item) => emitted.push(item));

    connected.delete(serverA.id);
    changes.fire({
      serverIds: [serverA.id],
      rootsChanged: false,
    });

    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted).not.toContain(undefined);
    expect(emitted.every((item) => item?.id?.includes(serverA.id))).toBe(true);
    // A disconnected Connexion keeps a closed chevron so sibling rows stay aligned.
    expect(rootA?.collapsibleState).toBe(1);
    expect(rootB?.collapsibleState).toBe(1);
    expect(rootA?.iconPath).toMatchObject({ id: "debug-disconnect" });
    expect(rootB?.iconPath).toMatchObject({
      id: "plug",
      color: { id: "testing.iconPassed" },
    });
    await expect(provider.getChildren(rootA)).resolves.toMatchObject([
      { kind: "message", label: "Not connected" },
    ]);
    await expect(provider.getChildren(sourcesB)).resolves.toMatchObject([{ label: "beta" }]);

    emitted.length = 0;
    connected.add(serverA.id);
    changes.fire({
      serverIds: [serverA.id],
      rootsChanged: false,
    });

    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted).not.toContain(undefined);
    expect(emitted.every((item) => item?.id?.includes(serverA.id))).toBe(true);
    expect(rootA?.collapsibleState).toBe(1);
    expect(rootB?.collapsibleState).toBe(1);
    expect(rootA?.iconPath).toMatchObject({
      id: "plug",
      color: { id: "testing.iconPassed" },
    });
    expect(rootB?.iconPath).toMatchObject({
      id: "plug",
      color: { id: "testing.iconPassed" },
    });
    await expect(provider.getChildren(rootA)).resolves.toMatchObject([{ kind: "databaseSource" }]);
    provider.dispose();
  });

  it("separates database roots from filterable Scratchpad roots", async () => {
    let connected = true;
    const server = {
      id: "server",
      name: "postgres@localhost:5432/testdb",
      host: "localhost",
      port: 5432,
      database: "testdb",
      user: "postgres",
    };
    const event = () => ({ dispose: () => undefined });
    const connections = {
      servers: [server],
      debugCapabilityFor: (serverId: string) => ({ serverId, status: "unavailable" as const }),
      onChanged: event,
      isServerConnected: () => connected,
    };
    const index = {
      state: { status: "not-indexed" },
      databaseState: () => ({ status: "not-indexed" }),
      databaseSymbols: () => [],
      onDidChangeState: event,
    };
    const notebooks = {
      list: async () => [
        { uri: { toString: () => "scratchpad:first" }, name: "First", metadata: {} },
        { uri: { toString: () => "scratchpad:second" }, name: "Second", metadata: {} },
      ],
      onDidChangeEntries: event,
    };
    const transactions = { transaction: () => undefined, onDidChange: event };
    const ddlSync = { state: () => undefined, onDidChangeState: event };
    const databaseProvider = new WorkbenchTreeProvider(
      connections as never,
      index as never,
      notebooks as never,
      transactions as never,
      ddlSync as never,
    );
    const scratchpadProvider = new WorkbenchTreeProvider(
      connections as never,
      index as never,
      notebooks as never,
      transactions as never,
      ddlSync as never,
      undefined,
      "scratchpads",
    );

    const connectedRoots = await databaseProvider.getChildren();
    expect(connectedRoots).toMatchObject([{ kind: "server" }, { kind: "add" }]);
    expect(connectedRoots[0]?.collapsibleState).toBe(1);
    await expect(databaseProvider.getChildren(connectedRoots[0])).resolves.toMatchObject([
      { kind: "databaseSource" },
    ]);

    connected = false;
    const disconnectedRoots = await databaseProvider.getChildren();
    expect(disconnectedRoots[0]?.collapsibleState).toBe(1);
    await expect(databaseProvider.getChildren(disconnectedRoots[0])).resolves.toMatchObject([
      { kind: "message", label: "Not connected" },
    ]);
    await expect(scratchpadProvider.getChildren()).resolves.toMatchObject([
      { kind: "sqlNotebook", label: "First" },
      { kind: "sqlNotebook", label: "Second" },
    ]);

    scratchpadProvider.setScratchpadFilter("second");
    await expect(scratchpadProvider.getChildren()).resolves.toMatchObject([
      { kind: "sqlNotebook", label: "Second" },
    ]);

    databaseProvider.dispose();
    scratchpadProvider.dispose();
  });

  it("presents distinct initial indexing and available states for one Connexion", () => {
    const server = {
      id: "server",
      name: "postgres@localhost:5432/testdb",
      host: "localhost",
      port: 5432,
      database: "testdb",
      user: "postgres",
    };
    const notIndexed = new SourcesSnapshotItem(server, { status: "not-indexed" });
    const initialIndex = new SourcesSnapshotItem(server, {
      status: "indexing",
      progress: { phase: "reading-catalog" },
    });
    const availableResult = {
      serverId: server.id,
      database: server.database,
      revision: "revision",
      documents: 1,
      symbols: 1,
      generation: 1,
      introspectionMs: 1,
      materializationMs: 1,
      publicationMs: 1,
      symbolQueryMs: 1,
      indexingMs: 1,
      graphQueryMs: 1,
    };
    const available = new SourcesSnapshotItem(server, {
      status: "available",
      result: availableResult,
    });

    expect(notIndexed.command).toMatchObject({
      command: "postgresql-workbench.indexDatabase",
      title: "Index Database",
    });
    expect(initialIndex.description).toBe("indexing · reading catalog");
    expect(initialIndex.contextValue).toBe("postgresql-workbench-sources-indexing");
    expect(initialIndex.accessibilityInformation?.label).toBe(
      "Schemas, testdb, indexing, reading catalog",
    );
    expect(new DatabaseSourceItem(server, { status: "indexing" }).description).toBe("indexing");
    expect(
      new DatabaseSourceItem(server, { status: "indexing", result: availableResult }).description,
    ).toBe("refreshing");
    expect(available.command).toBeUndefined();
  });

  it("keeps object selection neutral instead of opening a source implicitly", () => {
    const routine = new FunctionItem(
      { ...table, name: "total_orders", kind: "function", plpgsql: true },
      snapshot,
    );
    const object = new WorkbenchObjectItem(table, snapshot);

    expect(routine.command).toBeUndefined();
    expect(object.command).toBeUndefined();
  });

  it("keeps relation targets neutral and marks only resolvable targets as navigable", () => {
    const resolved = new WorkbenchRelationTargetItem(
      {
        symbol: {
          uri: table.symbolUri,
          file: table.sourceUri,
          name: table.name,
          kind: table.kind,
          signature: table.signature,
        },
        object: table,
        count: 1,
        members: [],
      },
      snapshot,
    );
    const unresolved = new WorkbenchRelationTargetItem(
      {
        symbol: {
          uri: "code+moniker://./lang:sql/table:external.orders",
          file: "external.sql",
          name: "orders",
          kind: "table",
          signature: "",
        },
        count: 1,
        members: [],
      },
      snapshot,
    );

    expect(resolved.command).toBeUndefined();
    expect(resolved.contextValue).toBe("postgresql-workbench-relation-target");
    expect(unresolved.contextValue).toBe("postgresql-workbench-relation-target-unresolved");
    expect(resolved.tooltip).toBe(`shop.orders\n${SOURCES_DRAG_HINT}`);
    expect(unresolved.tooltip).toBe("table orders");
  });

  it("explains the Shift+drop composition gesture on draggable Sources items", () => {
    const routine = new FunctionItem(
      {
        ...table,
        name: "total_orders",
        kind: "function",
        plpgsql: true,
        params: [{ name: "customer_id", type: "integer" }],
      },
      snapshot,
    );
    const object = new WorkbenchObjectItem(table, snapshot);
    const column = new WorkbenchTableMemberItem(
      { symbolUri: "", sourceUri: "", kind: "column", name: "id", type: "integer", line: 1 },
      table,
    );
    const constraint = new WorkbenchTableMemberItem(
      { symbolUri: "", sourceUri: "", kind: "constraint", name: "orders_pkey", type: "", line: 1 },
      table,
    );

    expect(routine.tooltip).toBe(`shop.total_orders(customer_id: integer)\n${SOURCES_DRAG_HINT}`);
    expect(object.tooltip).toBe(`shop.orders\n${SOURCES_DRAG_HINT}`);
    expect(column.tooltip).toBe(`id · integer\n${SOURCES_DRAG_HINT}`);
    expect(column.accessibilityInformation).toEqual({ label: "id · integer" });
    expect(object.accessibilityInformation).toEqual({ label: "shop.orders" });
    expect(constraint.tooltip).toBe("constraint orders_pkey");
    expect(constraint.accessibilityInformation).toBeUndefined();
    expect(
      new SchemaItem(
        { id: "server", host: "localhost", port: 5432, database: "demo", user: "postgres" },
        "shop",
      ).tooltip,
    ).toBeUndefined();
  });
});

describe("Workbench tree incremental refresh", () => {
  it("updates the exact materialized Sources item and only affected expanded branches", async () => {
    class Emitter<T> {
      private readonly listeners = new Set<(value: T) => void>();
      readonly event = (listener: (value: T) => void) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      };
      fire(value: T): void {
        for (const listener of this.listeners) listener(value);
      }
    }

    const server = {
      id: "server",
      name: "postgres@localhost:5432/testdb",
      host: "localhost",
      port: 5432,
      database: "testdb",
      user: "postgres",
    };
    const result = {
      serverId: "server",
      database: "testdb",
      revision: snapshot.revision,
      documents: 1,
      symbols: 1,
      generation: snapshot.generation,
      introspectionMs: 1,
      materializationMs: 1,
      publicationMs: 1,
      symbolQueryMs: 1,
      indexingMs: 1,
      graphQueryMs: 1,
    };
    const symbol = {
      uri: table.symbolUri,
      file: table.sourceUri,
      name: table.name,
      kind: table.kind,
      signature: table.signature,
      postgres: {
        serverId: table.serverId,
        database: table.database,
        schema: table.schema,
        documentKind: "table" as const,
        oid: table.oid,
        name: table.name,
        signature: table.signature,
      },
    };
    const indexChanges = new Emitter<WorkbenchIndexState>();
    const connectionChanges = new Emitter<{
      serverIds: readonly string[];
      rootsChanged: boolean;
    }>();
    const notebookChanges = new Emitter<void>();
    const ddlChanges = new Emitter<never>();
    let forceStaleRelations = false;
    let currentSnapshot = snapshot;
    const indexedSymbols = [
      symbol,
      {
        ...symbol,
        uri: unchangedTable.symbolUri,
        file: unchangedTable.sourceUri,
        name: unchangedTable.name,
        postgres: {
          ...symbol.postgres,
          oid: unchangedTable.oid,
          name: unchangedTable.name,
          schema: unchangedTable.schema,
        },
      },
      {
        ...symbol,
        uri: "code+moniker://./lang:sql/function:shop.refresh_inventory",
        file: "postgresql://server/testdb/shop/routine/refresh_inventory.sql",
        name: "refresh_inventory",
        kind: "function",
        source: {
          lines: [{ text: "CREATE FUNCTION shop.refresh_inventory() LANGUAGE plpgsql" }],
        },
        postgres: {
          ...symbol.postgres,
          documentKind: "routine",
          oid: 15,
          name: "refresh_inventory",
          schema: "shop",
        },
      },
    ];
    const index = {
      state: { status: "not-indexed", serverId: server.id } as WorkbenchIndexState,
      focusedServer: server,
      indexedSymbols,
      databaseState: () => index.state,
      databaseSymbols: () => indexedSymbols,
      databaseObjectOrigin: () => undefined,
      objectOrigin: () => undefined,
      relations: async (
        _object: WorkbenchObjectModel,
        candidate: Pick<typeof result, "revision" | "generation">,
      ) => ({
        status:
          forceStaleRelations ||
          candidate.revision !== currentSnapshot.revision ||
          candidate.generation !== currentSnapshot.generation
            ? ("stale" as const)
            : ("empty" as const),
        sourceLimited: false,
      }),
      onDidChangeState: indexChanges.event,
    };
    const connections = {
      servers: [server],
      debugCapabilityFor: (serverId: string) => ({ serverId, status: "unavailable" as const }),
      store: { get: () => server },
      onChanged: connectionChanges.event,
      isServerConnected: (id: string) => id === server.id,
      getClient: () => undefined,
    };
    const notebooks = {
      list: async () => [],
      onDidChangeEntries: notebookChanges.event,
    };
    const ddlSync = {
      state: () => ({
        serverId: server.id,
        status: "listening" as const,
        supportSchema: "workbench",
      }),
      onDidChangeState: ddlChanges.event,
    };
    const transactionChanges = new Emitter<string | undefined>();
    const transactions = {
      transaction: () => undefined,
      onDidChange: transactionChanges.event,
    };
    const provider = new WorkbenchTreeProvider(
      connections as never,
      index as never,
      notebooks as never,
      transactions as never,
      ddlSync as never,
    );
    const sources = new SourcesSnapshotItem(server, { status: "not-indexed" });
    const schema = new SchemaItem(server, "shop");
    const reportingSchema = new SchemaItem(server, "reporting");
    const object = new WorkbenchObjectItem(table, snapshot);
    const unchangedObject = new WorkbenchObjectItem(unchangedTable, snapshot);
    const routine = new FunctionItem(
      {
        ...table,
        symbolUri: "code+moniker://./lang:sql/function:shop.refresh_inventory",
        sourceUri: "postgresql://server/testdb/shop/routine/refresh_inventory.sql",
        oid: 15,
        name: "refresh_inventory",
        kind: "function",
        plpgsql: true,
      },
      snapshot,
    );
    const activeDatabase = new DatabaseSourceItem(server, { status: "not-indexed" });
    provider.getTreeItem(activeDatabase);
    provider.getTreeItem(sources);
    expect(provider.sourcesItem(server.id)).toBe(sources);
    expect(provider.getTreeItem(routine).contextValue).toBe("postgresql-workbench-function");
    provider.setExpanded(sources, false);
    const changes: Array<{ kind?: string } | undefined> = [];
    provider.onDidChangeTreeData((item) => changes.push(item));

    index.state = {
      status: "indexing",
      serverId: server.id,
      result,
      progress: { phase: "reading-catalog" },
    };
    indexChanges.fire(index.state);
    expect(changes).toEqual([activeDatabase, sources]);
    expect(activeDatabase.description).toBe("refreshing");
    expect(sources.description).toBe("refreshing · reading catalog");
    expect(sources.iconPath).toMatchObject({ id: "loading~spin" });
    expect(sources.tooltip).toBe(
      "Refreshing PostgreSQL sources for testdb: reading catalog\nPrevious snapshot available: 1 source, 1 symbol, 1 millisecond",
    );
    expect(sources.accessibilityInformation?.label).toBe(
      "Schemas, testdb, refreshing, reading catalog, previous snapshot available",
    );
    expect(sources.contextValue).toBe("postgresql-workbench-sources-indexing");
    expect(sources.command).toBeUndefined();
    expect(provider.getTreeItem(routine).contextValue).toBe("postgresql-workbench-function");

    changes.length = 0;
    index.state = {
      status: "available",
      serverId: server.id,
      result,
      change: { kind: "full", schemas: [], sourceUris: [] },
    };
    indexChanges.fire(index.state);
    expect(changes).toEqual([activeDatabase, sources, routine]);
    expect(activeDatabase.description).toBe("ready");
    expect(sources.description).toBe("available · 1 source · 1 symbol");
    expect(sources.iconPath).toMatchObject({ id: "files" });
    expect(sources.tooltip).toBe("Indexed sources for testdb: 1 source, 1 symbol, 1 millisecond");
    expect(provider.getTreeItem(routine).contextValue).toBe(
      "postgresql-workbench-function-debuggable",
    );
    provider.setExpanded(sources, false);

    changes.length = 0;
    provider.setExpanded(sources, true);
    provider.setExpanded(schema, true);
    provider.setExpanded(reportingSchema, true);
    provider.getTreeItem(schema);
    provider.getTreeItem(reportingSchema);
    await provider.getChildren(sources);
    provider.getTreeItem(object);
    provider.getTreeItem(unchangedObject);
    expect(provider.getParent(schema)).toBe(sources);
    expect(provider.getParent(sources)).toBe(activeDatabase);

    connectionChanges.fire({
      serverIds: [server.id],
      rootsChanged: false,
    });
    expect(changes).toEqual([activeDatabase, sources]);

    changes.length = 0;
    index.state = {
      status: "available",
      serverId: server.id,
      result: { ...result, revision: "full-refresh", generation: 8 },
      change: { kind: "full", schemas: [], sourceUris: [] },
    };
    indexChanges.fire(index.state);
    expect(changes).toHaveLength(6);
    expect(changes[0]).toBe(activeDatabase);
    expect(changes[1]).toBe(sources);
    expect(changes[2]).toBe(schema);
    expect(changes[3]).toBe(reportingSchema);
    expect(changes.slice(4).map((item) => item?.kind)).toEqual(["object", "object"]);

    changes.length = 0;
    index.state = { status: "stale", serverId: server.id, result };
    indexChanges.fire(index.state);
    expect(changes).toEqual([activeDatabase, sources]);
    expect(provider.getTreeItem(routine).contextValue).toBe(
      "postgresql-workbench-function-debuggable",
    );
    expect(sources.description).toBe("stale · previous snapshot available");
    expect(sources.tooltip).toBe(
      "PostgreSQL sources for testdb are stale and require reindexing\nPrevious snapshot available: 1 source, 1 symbol, 1 millisecond",
    );
    expect(sources.command).toMatchObject({
      command: "postgresql-workbench.indexDatabase",
      title: "Reindex Database",
    });

    changes.length = 0;
    index.state = { status: "cancelled", serverId: server.id, result };
    indexChanges.fire(index.state);
    expect(changes).toEqual([activeDatabase, sources]);
    expect(provider.getTreeItem(routine).contextValue).toBe(
      "postgresql-workbench-function-debuggable",
    );
    expect(sources.description).toBe("cancelled · previous snapshot available");
    expect(sources.tooltip).toBe(
      "PostgreSQL source indexing for testdb was cancelled\nPrevious snapshot available: 1 source, 1 symbol, 1 millisecond",
    );
    expect(sources.command).toMatchObject({
      command: "postgresql-workbench.indexDatabase",
      title: "Reindex Database",
    });

    changes.length = 0;
    index.state = { status: "error", serverId: server.id, message: "daemon unavailable", result };
    indexChanges.fire(index.state);
    expect(changes).toEqual([activeDatabase, sources]);
    expect(provider.getTreeItem(routine).contextValue).toBe(
      "postgresql-workbench-function-debuggable",
    );
    expect(sources.tooltip).toBe(
      "PostgreSQL source indexing failed for testdb: daemon unavailable\nPrevious snapshot available: 1 source, 1 symbol, 1 millisecond\nSelect to retry",
    );
    expect(sources.description).toBe("failed · previous snapshot available · retry");
    expect(sources.accessibilityInformation?.label).toBe(
      "Schemas, testdb, indexing failed, daemon unavailable, previous snapshot available, select to retry",
    );

    changes.length = 0;
    const incrementalResult = { ...result, revision: "revision-2", generation: 8 };
    index.state = {
      status: "available",
      serverId: server.id,
      result: incrementalResult,
      change: {
        kind: "incremental",
        schemas: ["shop"],
        sourceUris: [table.sourceUri],
      },
    };
    currentSnapshot = incrementalResult;
    indexChanges.fire(index.state);

    expect(changes.map((item) => item?.kind)).toEqual([
      "databaseSource",
      "sourcesSnapshot",
      "schema",
      "object",
      "object",
      "function",
    ]);
    expect(sources.description).toBe("available · 1 source · 1 symbol");
    expect(changes).toContain(unchangedObject);
    expect(changes).not.toContain(reportingSchema);
    expect(unchangedObject.snapshot).toMatchObject({ revision: "revision-2", generation: 8 });
    expect(changes).not.toContain(undefined);
    expect(await provider.getChildren(unchangedObject)).toMatchObject([
      { label: "No direct indexed relations" },
    ]);

    indexedSymbols.push({
      ...symbol,
      uri: createdTable.symbolUri,
      file: createdTable.sourceUri,
      name: createdTable.name,
      postgres: {
        ...symbol.postgres,
        oid: createdTable.oid,
        name: createdTable.name,
        schema: createdTable.schema,
      },
    });
    changes.length = 0;
    const createdResult = { ...result, revision: "revision-3", generation: 9 };
    index.state = {
      status: "available",
      serverId: server.id,
      result: createdResult,
      change: {
        kind: "incremental",
        schemas: ["shop"],
        sourceUris: [createdTable.sourceUri],
      },
    };
    currentSnapshot = createdResult;
    indexChanges.fire(index.state);
    expect((await provider.getChildren(schema)).map((item) => item.label)).toContain(
      "workbench_ddl_sync_probe",
    );
    expect(changes.map((item) => item?.kind)).toEqual([
      "databaseSource",
      "sourcesSnapshot",
      "schema",
      "object",
      "object",
      "function",
    ]);

    forceStaleRelations = true;
    const staleChildren = await provider.getChildren(unchangedObject);
    expect(staleChildren.at(-1)).toMatchObject({
      label: "Relations are stale — reindex the database",
      iconPath: { id: "refresh" },
      command: {
        command: "postgresql-workbench.indexDatabase",
        title: "Reindex Database",
      },
    });

    changes.length = 0;
    provider.setExpanded(schema, false);
    indexChanges.fire(index.state);
    expect(changes.map((item) => item?.kind)).toEqual([
      "databaseSource",
      "sourcesSnapshot",
      "object",
    ]);

    changes.length = 0;
    provider.setExpanded(sources, false);
    indexChanges.fire(index.state);
    expect(changes.map((item) => item?.kind)).toEqual(["databaseSource", "sourcesSnapshot"]);
    provider.dispose();
  });
});
