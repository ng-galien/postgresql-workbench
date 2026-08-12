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
  FunctionItem,
  SchemaItem,
  SourcesSnapshotItem,
  WorkbenchObjectItem,
  WorkbenchRelationTargetItem,
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
  it("makes the Sources node itself start indexing without a redundant status child", () => {
    const server = {
      id: "server",
      name: "postgres@localhost:5432/testdb",
      host: "localhost",
      port: 5432,
      database: "testdb",
      user: "postgres",
    };
    const notIndexed = new SourcesSnapshotItem(server, true, { status: "not-indexed" });
    const available = new SourcesSnapshotItem(server, true, {
      status: "available",
      result: {
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
      },
    });

    expect(notIndexed.command).toMatchObject({
      command: "postgresql-workbench.indexActiveDatabase",
      title: "Index Database",
    });
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
    const connectionChanges = new Emitter<void>();
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
    ];
    const index = {
      state: { status: "available", serverId: server.id, result } as WorkbenchIndexState,
      indexedSymbols,
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
      activeServer: server,
      isConnected: true,
      pldbgapiAvailable: false,
      store: { get: () => server },
      onChanged: connectionChanges.event,
      isActiveServer: (id: string) => id === server.id,
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
    const provider = new WorkbenchTreeProvider(
      connections as never,
      index as never,
      notebooks as never,
      ddlSync as never,
    );
    const sources = new SourcesSnapshotItem(server, true, { status: "not-indexed" });
    const schema = new SchemaItem("shop");
    const reportingSchema = new SchemaItem("reporting");
    const object = new WorkbenchObjectItem(table, snapshot);
    const unchangedObject = new WorkbenchObjectItem(unchangedTable, snapshot);
    provider.getTreeItem(sources);
    expect(provider.activeSourcesItem()).toBe(sources);
    const changes: Array<{ kind?: string } | undefined> = [];
    provider.onDidChangeTreeData((item) => changes.push(item));

    index.state = { status: "indexing", serverId: server.id, result };
    indexChanges.fire(index.state);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toBe(sources);
    expect(sources.description).toBe("indexing");
    expect(sources.iconPath).toMatchObject({ id: "loading~spin" });
    expect(sources.tooltip).toBe("Indexing PostgreSQL sources for testdb…");
    expect(sources.command).toBeUndefined();

    changes.length = 0;
    index.state = {
      status: "available",
      serverId: server.id,
      result,
      change: { kind: "full", schemas: [], sourceUris: [] },
    };
    indexChanges.fire(index.state);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toBe(sources);
    expect(sources.description).toBe("available");
    expect(sources.iconPath).toMatchObject({ id: "files" });
    expect(sources.tooltip).toBe("Indexed sources for testdb");

    changes.length = 0;
    provider.setExpanded(sources, true);
    provider.setExpanded(schema, true);
    provider.setExpanded(reportingSchema, true);
    await provider.getChildren(sources);
    provider.getTreeItem(schema);
    provider.getTreeItem(reportingSchema);
    provider.getTreeItem(object);
    provider.getTreeItem(unchangedObject);

    connectionChanges.fire();
    expect(changes).toEqual([undefined]);

    changes.length = 0;
    index.state = {
      status: "available",
      serverId: server.id,
      result: { ...result, revision: "full-refresh", generation: 8 },
      change: { kind: "full", schemas: [], sourceUris: [] },
    };
    indexChanges.fire(index.state);
    expect(changes).toHaveLength(5);
    expect(changes[0]).toBe(sources);
    expect(changes[1]).toBe(schema);
    expect(changes[2]).toBe(reportingSchema);
    expect(changes.slice(3).map((item) => item?.kind)).toEqual(["object", "object"]);

    changes.length = 0;
    index.state = { status: "stale", serverId: server.id, result };
    indexChanges.fire(index.state);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toBe(sources);
    expect(sources.description).toBe("stale");
    expect(sources.tooltip).toBe("PostgreSQL sources for testdb are stale and require reindexing");
    expect(sources.command).toMatchObject({
      command: "postgresql-workbench.indexActiveDatabase",
      title: "Reindex Database",
    });

    changes.length = 0;
    index.state = { status: "error", serverId: server.id, message: "daemon unavailable", result };
    indexChanges.fire(index.state);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toBe(sources);
    expect(sources.tooltip).toBe(
      "PostgreSQL source indexing failed for testdb: daemon unavailable",
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
      "sourcesSnapshot",
      "schema",
      "object",
      "object",
    ]);
    expect(sources.description).toBe("available");
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
      "sourcesSnapshot",
      "schema",
      "object",
      "object",
    ]);

    forceStaleRelations = true;
    const staleChildren = await provider.getChildren(unchangedObject);
    expect(staleChildren.at(-1)).toMatchObject({
      label: "Relations are stale — reindex the database",
      iconPath: { id: "refresh" },
      command: {
        command: "postgresql-workbench.indexActiveDatabase",
        title: "Reindex Database",
      },
    });

    changes.length = 0;
    provider.setExpanded(schema, false);
    indexChanges.fire(index.state);
    expect(changes.map((item) => item?.kind)).toEqual(["sourcesSnapshot", "object"]);

    changes.length = 0;
    provider.setExpanded(sources, false);
    indexChanges.fire(index.state);
    expect(changes.map((item) => item?.kind)).toEqual(["sourcesSnapshot"]);
    provider.dispose();
  });
});
