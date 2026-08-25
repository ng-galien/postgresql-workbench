import { describe, expect, it, vi } from "vitest";

/** The environment a test controller indexes in. */
function testHost() {
  return {
    log: vi.fn(),
    runtimePath: () => "/extension/runtime/code-moniker",
    workspaceRoots: () => ["/storage/code-moniker-workspace"],
    commandTimeoutMs: () => 120_000,
    acceptanceControlEnabled: () =>
      Boolean(process.env.POSTGRESQL_WORKBENCH_ACCEPTANCE_CONTROL_FILE),
  };
}

import type { LocalCodeMonikerSession } from "./localCodeMoniker.js";
import type { PostgresCatalogSnapshot, VirtualSqlSourceSet } from "./postgresCatalog.js";
import {
  postgresDatabaseDocumentRoot,
  postgresDocumentUri,
  postgresSourceSetName,
} from "./postgresCatalog.js";

const SCOPE_A = postgresDatabaseDocumentRoot({
  connectionId: "connection-a",
  database: "database-a",
});
const SCOPE_B = postgresDatabaseDocumentRoot({
  connectionId: "connection-b",
  database: "database-b",
});

vi.mock("vscode", () => {
  class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();

    readonly event = (listener: (value: T) => void) => {
      this.listeners.add(listener);
      return {
        dispose: () => this.listeners.delete(listener),
      };
    };

    fire(value: T): void {
      for (const listener of this.listeners) {
        listener(value);
      }
    }

    dispose(): void {
      this.listeners.clear();
    }
  }

  return {
    EventEmitter,
    ExtensionMode: {
      Production: 1,
      Development: 2,
      Test: 3,
    },
  };
});

vi.mock("./postgresCatalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./postgresCatalog.js")>();
  return {
    ...actual,
    readPostgresCatalog: vi.fn(actual.readPostgresCatalog),
  };
});

import type { WorkbenchIndexResult } from "./indexController.js";
import { type IndexConnections, WorkbenchIndexController } from "./indexController.js";
import { readPostgresCatalog } from "./postgresCatalog.js";

function state(controller: WorkbenchIndexController, connectionId = "connection-a") {
  return controller.databaseState({
    connectionId,
    database: connectionId === "connection-a" ? "database-a" : "database-b",
  });
}

function symbols(controller: WorkbenchIndexController, connectionId = "connection-a") {
  return controller.databaseSymbols({
    connectionId,
    database: connectionId === "connection-a" ? "database-a" : "database-b",
  });
}

function seedAvailable(
  controller: WorkbenchIndexController,
  result: WorkbenchIndexResult,
  indexedSymbols: readonly {
    uri: string;
    file: string;
    name: string;
    kind: string;
    signature: string;
  }[],
): void {
  const scope = postgresDatabaseDocumentRoot(result);
  const internals = controller as unknown as {
    states: Map<string, unknown>;
    registries: Map<string, unknown>;
  };
  internals.registries.set(scope, {
    result,
    symbols: [...indexedSymbols],
    sourceSet: { srcset: "postgres-test", revision: result.revision, documents: [] },
    documents: new Map(),
    origins: new Map(),
    foreignKeys: [],
    viewDependencies: [],
    resources: new Map(),
  });
  internals.states.set(scope, { status: "available", connectionId: result.connectionId, result });
}

interface TestConnection {
  id: string;
  database: string;
}

class FakeConnections {
  private readonly listeners = new Set<(change: { connectionIds: string[] }) => void>();
  private connection: TestConnection | undefined = { id: "connection-a", database: "database-a" };

  get connections(): TestConnection[] {
    return this.connection ? [this.connection] : [];
  }

  get connectedConnectionIds(): string[] {
    return this.connection ? [this.connection.id] : [];
  }

  readonly store = {
    get: (id: string) => (this.connection?.id === id ? this.connection : undefined),
  };

  isConnectionConnected(id: string): boolean {
    return this.connection?.id === id;
  }

  onChanged(listener: (change: { connectionIds: string[] }) => void): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => this.listeners.delete(listener),
    };
  }

  getClient(id: string): { query(): Promise<never> } | undefined {
    if (this.connection?.id !== id) return undefined;
    return {
      query: () => Promise.reject(new Error("catalog unavailable")),
    };
  }

  switchTo(connection: TestConnection | undefined): void {
    const previous = this.connection;
    this.connection = connection;
    for (const listener of this.listeners) {
      listener({
        connectionIds: [...new Set([previous?.id, connection?.id].filter(Boolean) as string[])],
      });
    }
  }
}

describe("WorkbenchIndexController connection state", () => {
  it("indexes each newly connected Connection automatically", async () => {
    const connections = new FakeConnections();
    connections.switchTo(undefined);
    const controller = new WorkbenchIndexController(
      testHost(),
      connections as unknown as IndexConnections,
    );
    const result: WorkbenchIndexResult = {
      connectionId: "connection-a",
      database: "database-a",
      revision: "revision-a",
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
    const indexPostgresDatabase = vi
      .spyOn(controller, "indexPostgresDatabase")
      .mockResolvedValue(result);

    connections.switchTo({ id: "connection-a", database: "database-a" });
    await vi.waitFor(() => expect(indexPostgresDatabase).toHaveBeenCalledTimes(1));

    connections.switchTo({ id: "connection-a", database: "database-a" });
    await Promise.resolve();
    expect(indexPostgresDatabase).toHaveBeenCalledTimes(1);

    connections.switchTo(undefined);
    expect(state(controller)).toMatchObject({
      status: "not-indexed",
      connectionId: "connection-a",
    });

    connections.switchTo({ id: "connection-a", database: "database-a" });
    await vi.waitFor(() => expect(indexPostgresDatabase).toHaveBeenCalledTimes(2));
    controller.dispose();
  });

  it("serializes an ad hoc database refresh and invalidates an older active snapshot", async () => {
    const connections = new FakeConnections();
    const controller = new WorkbenchIndexController(
      testHost(),
      connections as unknown as IndexConnections,
    );
    const result: WorkbenchIndexResult = {
      connectionId: "connection-a",
      database: "database-a",
      revision: "revision-b",
      documents: 1,
      symbols: 1,
      generation: 2,
      introspectionMs: 1,
      materializationMs: 1,
      publicationMs: 1,
      symbolQueryMs: 1,
      indexingMs: 1,
      graphQueryMs: 1,
    };
    let releasePrevious = () => {};
    const previous = new Promise<WorkbenchIndexResult>((resolve) => {
      releasePrevious = () => resolve({ ...result, revision: "revision-a", generation: 1 });
    });
    const runPostgresDatabaseIndex = vi.fn().mockResolvedValue(result);
    const internals = controller as unknown as {
      scopeRuns: Map<string, { connectionId: string; tail: Promise<unknown> }>;
      runPostgresDatabaseIndex: typeof runPostgresDatabaseIndex;
      scopeRefreshEpoch(scope: string): number;
    };
    internals.scopeRuns.set(SCOPE_A, { connectionId: "connection-a", tail: previous });
    internals.runPostgresDatabaseIndex = runPostgresDatabaseIndex;
    const oldEpoch = internals.scopeRefreshEpoch(SCOPE_A);

    const refresh = controller.indexPostgresDatabase({ query: vi.fn() } as never, {
      connectionId: "connection-a",
      database: "database-a",
    });
    const otherRefresh = controller.indexPostgresDatabase({ query: vi.fn() } as never, {
      connectionId: "connection-b",
      database: "database-b",
    });

    expect(internals.scopeRuns.has(SCOPE_A)).toBe(true);
    expect(internals.scopeRefreshEpoch(SCOPE_A)).toBeGreaterThan(oldEpoch);
    // Another Connection never waits behind this scope's queue.
    await expect(otherRefresh).resolves.toBe(result);
    expect(runPostgresDatabaseIndex).toHaveBeenCalledTimes(1);
    expect(runPostgresDatabaseIndex.mock.calls[0]?.[1]).toEqual({
      connectionId: "connection-b",
      database: "database-b",
    });
    releasePrevious();
    await expect(refresh).resolves.toBe(result);
    expect(runPostgresDatabaseIndex).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("publishes a refreshed registry only for its exact Connection", () => {
    const connections = new FakeConnections();
    const controller = new WorkbenchIndexController(
      testHost(),
      connections as unknown as IndexConnections,
    );
    const result: WorkbenchIndexResult = {
      connectionId: "connection-a",
      database: "database-a",
      revision: "revision-b",
      documents: 1,
      symbols: 1,
      generation: 2,
      introspectionMs: 1,
      materializationMs: 1,
      publicationMs: 1,
      symbolQueryMs: 1,
      indexingMs: 1,
      graphQueryMs: 1,
    };
    const symbol = {
      uri: "sql:table:orders",
      file: "orders.sql",
      name: "orders",
      kind: "table",
      signature: "",
    };
    const refreshedRegistry = {
      result,
      symbols: [symbol],
      sourceSet: { srcset: "postgres-test", revision: "revision-b", documents: [] },
      documents: new Map(),
      origins: new Map(),
      foreignKeys: [],
      viewDependencies: [],
      resources: new Map(),
    };
    const internals = controller as unknown as {
      publishRegistry(
        scope: string,
        registry: typeof refreshedRegistry,
        change: { kind: "full"; schemas: []; sourceUris: [] },
      ): void;
    };

    internals.publishRegistry(SCOPE_A, refreshedRegistry, {
      kind: "full",
      schemas: [],
      sourceUris: [],
    });

    expect(state(controller)).toMatchObject({ status: "available", result });
    expect(symbols(controller)).toEqual([symbol]);
    controller.dispose();
  });

  it("holds an acceptance index phase until that exact run and phase are released", async () => {
    const previousControlFile = process.env.POSTGRESQL_WORKBENCH_ACCEPTANCE_CONTROL_FILE;
    process.env.POSTGRESQL_WORKBENCH_ACCEPTANCE_CONTROL_FILE = "/tmp/workbench-control.json";
    const connections = new FakeConnections();
    const controller = new WorkbenchIndexController(
      testHost(),
      connections as unknown as IndexConnections,
    );

    try {
      controller.armAcceptancePhaseGate(["reading-catalog"]);
      const refresh = controller.indexDatabase("connection-a");
      await vi.waitFor(() => {
        expect(controller.acceptanceSnapshot()).toMatchObject({
          activeRun: { cancelled: false, id: 1 },
          currentRunPending: true,
          gate: {
            nextPhase: "reading-catalog",
            reachedPhase: "reading-catalog",
            runId: 1,
          },
          state: {
            status: "indexing",
            progress: { phase: "reading-catalog" },
          },
        });
      });

      controller.releaseAcceptancePhaseGate(1, "reading-catalog");
      await expect(refresh).rejects.toThrow("catalog unavailable");
      expect(controller.acceptanceSnapshot()).toMatchObject({
        activeRun: undefined,
        currentRunPending: false,
        gate: undefined,
        lastSettledRun: { id: 1, status: "error" },
      });
    } finally {
      controller.dispose();
      if (previousControlFile === undefined) {
        delete process.env.POSTGRESQL_WORKBENCH_ACCEPTANCE_CONTROL_FILE;
      } else {
        process.env.POSTGRESQL_WORKBENCH_ACCEPTANCE_CONTROL_FILE = previousControlFile;
      }
    }
  });

  it("settles a failed run without changing another Connection state", async () => {
    const previousControlFile = process.env.POSTGRESQL_WORKBENCH_ACCEPTANCE_CONTROL_FILE;
    process.env.POSTGRESQL_WORKBENCH_ACCEPTANCE_CONTROL_FILE = "/tmp/workbench-control.json";
    const connections = new FakeConnections();
    const controller = new WorkbenchIndexController(
      testHost(),
      connections as unknown as IndexConnections,
    );
    const result: WorkbenchIndexResult = {
      connectionId: "connection-b",
      database: "database-b",
      revision: "revision-b",
      documents: 1,
      symbols: 1,
      generation: 2,
      introspectionMs: 1,
      materializationMs: 1,
      publicationMs: 1,
      symbolQueryMs: 1,
      indexingMs: 1,
      graphQueryMs: 1,
    };
    const internals = controller as unknown as {
      registries: Map<
        string,
        {
          result: WorkbenchIndexResult;
          symbols: [];
          documents: Map<string, never>;
          origins: Map<string, never>;
          foreignKeys: [];
          viewDependencies: [];
          resources: Map<string, never>;
        }
      >;
    };
    internals.registries.set(SCOPE_B, {
      result,
      symbols: [],
      documents: new Map<string, never>(),
      origins: new Map<string, never>(),
      foreignKeys: [],
      viewDependencies: [],
      resources: new Map<string, never>(),
    });

    try {
      controller.armAcceptancePhaseGate(["reading-catalog"]);
      const refresh = controller.indexDatabase("connection-a");
      await vi.waitFor(() => {
        expect(controller.acceptanceSnapshot().gate).toMatchObject({
          reachedPhase: "reading-catalog",
          runId: 1,
        });
      });

      connections.switchTo({ id: "connection-b", database: "database-b" });
      expect(state(controller, "connection-b")).toMatchObject({
        status: "available",
        connectionId: "connection-b",
      });
      controller.releaseAcceptancePhaseGate(1, "reading-catalog");
      await expect(refresh).rejects.toThrow("catalog unavailable");
      expect(controller.acceptanceSnapshot()).toMatchObject({
        lastSettledRun: { id: 1, status: "error" },
        state: { status: "error", connectionId: "connection-a" },
      });
      expect(state(controller, "connection-b")).toMatchObject({
        status: "available",
        connectionId: "connection-b",
      });
    } finally {
      controller.dispose();
      if (previousControlFile === undefined) {
        delete process.env.POSTGRESQL_WORKBENCH_ACCEPTANCE_CONTROL_FILE;
      } else {
        process.env.POSTGRESQL_WORKBENCH_ACCEPTANCE_CONTROL_FILE = previousControlFile;
      }
    }
  });

  it("keeps pre-publication errors scoped to their exact Connection", async () => {
    const connections = new FakeConnections();
    const controller = new WorkbenchIndexController(
      testHost(),
      connections as unknown as IndexConnections,
    );

    await expect(controller.indexDatabase("connection-a")).rejects.toThrow("catalog unavailable");
    expect(state(controller)).toMatchObject({
      status: "error",
      connectionId: "connection-a",
    });

    connections.switchTo({ id: "connection-b", database: "database-b" });

    await vi.waitFor(() =>
      expect(state(controller, "connection-b")).toMatchObject({
        status: "error",
        connectionId: "connection-b",
      }),
    );
    expect(symbols(controller, "connection-b")).toEqual([]);

    connections.switchTo(undefined);

    expect(state(controller, "connection-b")).toMatchObject({
      status: "error",
      connectionId: "connection-b",
    });
    controller.dispose();
  });

  it("keeps the previous source snapshot visible in a distinct failed state", async () => {
    const connections = new FakeConnections();
    const controller = new WorkbenchIndexController(
      testHost(),
      connections as unknown as IndexConnections,
    );
    const result: WorkbenchIndexResult = {
      connectionId: "connection-a",
      database: "database-a",
      revision: "revision-a",
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
    const symbol = {
      uri: "sql:table:orders",
      file: "orders.sql",
      name: "orders",
      kind: "table",
      signature: "",
    };
    seedAvailable(controller, result, [symbol]);

    await expect(controller.indexDatabase("connection-a")).rejects.toThrow("catalog unavailable");

    expect(state(controller)).toMatchObject({ status: "error", result });
    expect(symbols(controller)).toEqual([symbol]);
    controller.dispose();
  });

  it("cancels a refresh without replacing the previous source snapshot", async () => {
    const connections = new FakeConnections();
    const controller = new WorkbenchIndexController(
      testHost(),
      connections as unknown as IndexConnections,
    );
    const result: WorkbenchIndexResult = {
      connectionId: "connection-a",
      database: "database-a",
      revision: "revision-a",
      documents: 2,
      symbols: 8,
      generation: 1,
      introspectionMs: 1,
      materializationMs: 1,
      publicationMs: 1,
      symbolQueryMs: 1,
      indexingMs: 1,
      graphQueryMs: 1,
    };
    const symbol = {
      uri: "sql:table:orders",
      file: "orders.sql",
      name: "orders",
      kind: "table",
      signature: "",
    };
    seedAvailable(controller, result, [symbol]);

    const refresh = controller.indexDatabase("connection-a");
    expect(state(controller)).toMatchObject({
      status: "indexing",
      result,
      progress: { phase: "reading-catalog" },
    });
    expect(controller.cancelDatabaseIndex("connection-b")).toBe(false);
    expect(state(controller)).toMatchObject({
      status: "indexing",
      result,
      progress: { phase: "reading-catalog" },
    });
    expect(controller.cancelDatabaseIndex("connection-a")).toBe(true);
    expect(controller.cancelDatabaseIndex()).toBe(false);
    expect(state(controller)).toMatchObject({
      status: "indexing",
      result,
      progress: { phase: "cancelling" },
    });

    await expect(refresh).rejects.toThrow("indexing was cancelled");
    expect(state(controller)).toMatchObject({ status: "cancelled", result });
    expect(symbols(controller)).toEqual([symbol]);
    controller.dispose();
  });

  it("tracks an automatic refresh as a cancellable run of its exact Connection", async () => {
    const connections = new FakeConnections();
    const controller = new WorkbenchIndexController(
      testHost(),
      connections as unknown as IndexConnections,
    );
    const result: WorkbenchIndexResult = {
      connectionId: "connection-a",
      database: "database-a",
      revision: "revision-a",
      documents: 2,
      symbols: 8,
      generation: 1,
      introspectionMs: 1,
      materializationMs: 1,
      publicationMs: 1,
      symbolQueryMs: 1,
      indexingMs: 1,
      graphQueryMs: 1,
    };
    seedAvailable(controller, result, []);
    const abortCatalogReads: Array<() => void> = [];
    let catalogReleased = false;
    const releaseCatalog = () => {
      catalogReleased = true;
      for (const abort of abortCatalogReads.splice(0)) abort();
    };
    const client = {
      query: () =>
        new Promise<never>((_, reject) => {
          const abort = () => reject(new Error("catalog read aborted"));
          if (catalogReleased) abort();
          else abortCatalogReads.push(abort);
        }),
    };

    const refresh = controller.indexPostgresDatabase(client as never, {
      connectionId: "connection-a",
      database: "database-a",
    });
    expect(state(controller)).toMatchObject({
      status: "indexing",
      result,
      progress: { phase: "reading-catalog" },
    });
    expect(controller.cancelDatabaseIndex("connection-b")).toBe(false);
    expect(controller.cancelDatabaseIndex("connection-a")).toBe(true);
    expect(state(controller)).toMatchObject({
      status: "indexing",
      progress: { phase: "cancelling" },
    });
    releaseCatalog();
    await expect(refresh).rejects.toThrow("indexing was cancelled");
    expect(state(controller)).toMatchObject({ status: "cancelled", result });
    controller.dispose();
  });

  it.each(["late validation failure", "late cancellation"])(
    "restores the published source set after a %s",
    async (failure) => {
      const connections = new FakeConnections();
      const controller = new WorkbenchIndexController(
        testHost(),
        connections as unknown as IndexConnections,
      );
      const previousResult: WorkbenchIndexResult = {
        connectionId: "connection-a",
        database: "database-a",
        revision: "revision-a",
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
      const previousSourceSet: VirtualSqlSourceSet = {
        srcset: "postgres-test",
        revision: "revision-a",
        documents: [
          {
            uri: "postgresql://connection-a/database-a/old.sql",
            language: "sql",
            content: "SELECT 1;",
          },
        ],
      };
      const candidateSourceSet: VirtualSqlSourceSet = {
        srcset: "postgres-test",
        revision: "revision-b",
        documents: [
          {
            uri: "postgresql://connection-a/database-a/new.sql",
            language: "sql",
            content: "SELECT 2;",
          },
        ],
      };
      const catalog: PostgresCatalogSnapshot = {
        sourceSet: candidateSourceSet,
        metrics: { introspectionMs: 1, materializationMs: 1, documentCount: 1 },
        origins: new Map(),
        foreignKeys: [],
        viewDependencies: [],
      };
      const replace = vi.fn().mockResolvedValue(undefined);
      const remove = vi.fn().mockResolvedValue(undefined);
      const session = {
        client: {
          workspace: {
            status: vi
              .fn()
              .mockResolvedValueOnce({ phase: "ready", generation: 1 })
              .mockResolvedValue({ phase: "ready", generation: 3 }),
          },
          sources: { replace, remove },
        },
      } as unknown as LocalCodeMonikerSession;
      const scope = SCOPE_A;
      const previousRegistry = {
        result: previousResult,
        symbols: [],
        sourceSet: previousSourceSet,
        documents: new Map(previousSourceSet.documents.map((document) => [document.uri, document])),
        origins: new Map(),
        foreignKeys: [],
        viewDependencies: [],
        resources: new Map(),
      };
      const previousPublished = { scope, connectionId: "connection-a", srcset: "postgres-test" };
      const internals = controller as unknown as {
        registries: Map<string, typeof previousRegistry>;
        published: Map<string, typeof previousPublished>;
        ensureSession: () => Promise<LocalCodeMonikerSession>;
        assertCapabilities: () => void;
        readDatabaseSymbols: () => Promise<{
          generation: number;
          symbolQueryMs: number;
          rows: [];
        }>;
        probeGraph: () => Promise<number>;
        publishAndReadCatalog: (
          catalog: PostgresCatalogSnapshot,
          connectionId: string,
          database: string,
          started: number,
          isCurrent: () => boolean,
          reportProgress?: (progress: { phase: string }) => Promise<void>,
        ) => Promise<unknown>;
      };
      internals.registries.set(scope, previousRegistry);
      internals.published.set(scope, previousPublished);
      internals.ensureSession = vi.fn().mockResolvedValue(session);
      internals.assertCapabilities = vi.fn();
      internals.readDatabaseSymbols = vi.fn().mockResolvedValue({
        generation: 2,
        symbolQueryMs: 1,
        rows: [],
      });
      internals.probeGraph =
        failure === "late validation failure"
          ? vi.fn().mockRejectedValue(new Error(failure))
          : vi.fn().mockResolvedValue(1);

      await expect(
        internals.publishAndReadCatalog(
          catalog,
          "connection-a",
          "database-a",
          performance.now(),
          () => true,
          async (progress) => {
            if (failure === "late cancellation" && progress.phase === "checking-relations") {
              throw new Error(failure);
            }
          },
        ),
      ).rejects.toThrow(failure);

      expect(replace).toHaveBeenCalledTimes(2);
      expect(replace.mock.calls[0]?.[0]).toMatchObject({ revision: "revision-b" });
      expect(replace.mock.calls[1]?.[0]).toMatchObject({ revision: "revision-a" });
      expect(remove).not.toHaveBeenCalled();
      expect(internals.registries.get(scope)).toBe(previousRegistry);
      expect(internals.published.get(scope)).toBe(previousPublished);
      expect(previousResult.generation).toBe(3);
      controller.dispose();
    },
  );
});

describe("WorkbenchIndexController Code Moniker readiness", () => {
  it("uses the active session timeout while the workspace is loading", async () => {
    vi.useFakeTimers();
    const connections = new FakeConnections();
    let configuredTimeoutMs = 25;
    const controller = new WorkbenchIndexController(
      { ...testHost(), commandTimeoutMs: () => configuredTimeoutMs },
      connections as unknown as IndexConnections,
    );
    const session = {
      workbenchCommandTimeoutMs: configuredTimeoutMs,
      client: {
        workspace: { status: vi.fn().mockResolvedValue({ phase: "loading" }) },
      },
    } as unknown as LocalCodeMonikerSession;
    configuredTimeoutMs = 1;
    const internals = controller as unknown as {
      ensureSession: () => Promise<LocalCodeMonikerSession>;
      assertCapabilities: () => void;
      publishAndReadCatalog: (
        catalog: PostgresCatalogSnapshot,
        connectionId: string,
        database: string,
        started: number,
        isCurrent: () => boolean,
      ) => Promise<unknown>;
    };
    internals.ensureSession = vi.fn().mockResolvedValue(session);
    internals.assertCapabilities = vi.fn();

    try {
      const result = expect(
        internals.publishAndReadCatalog(
          {
            sourceSet: { srcset: "postgres-test", revision: "revision-a", documents: [] },
            metrics: { introspectionMs: 0, materializationMs: 0, documentCount: 0 },
            origins: new Map(),
            foreignKeys: [],
            viewDependencies: [],
          },
          "connection-a",
          "database-a",
          performance.now(),
          () => true,
        ),
      ).rejects.toThrow("Code Moniker workspace remained loading for 25 ms");
      await vi.advanceTimersByTimeAsync(50);
      await result;
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });
});

function indexResult(overrides: Partial<WorkbenchIndexResult> = {}): WorkbenchIndexResult {
  return {
    connectionId: "connection-a",
    database: "database-a",
    revision: "revision-a",
    documents: 1,
    symbols: 2,
    generation: 1,
    introspectionMs: 1,
    materializationMs: 1,
    publicationMs: 1,
    symbolQueryMs: 1,
    indexingMs: 1,
    graphQueryMs: 1,
    ...overrides,
  };
}

function tableRegistry(result: WorkbenchIndexResult) {
  const identity = { connectionId: result.connectionId, database: result.database };
  const sourceUri = postgresDocumentUri(identity, "shop", "table", "orders");
  const sourceSet = postgresSourceSetName(identity);
  const table = {
    ...identity,
    schema: "shop",
    documentKind: "table" as const,
    oid: 10,
    name: "orders",
    signature: "shop.orders",
  };
  return {
    result,
    symbols: [
      {
        uri: `sql:${sourceSet}:table:orders`,
        file: sourceUri,
        name: "orders",
        kind: "table",
        signature: "shop.orders",
        postgres: table,
      },
      {
        uri: `sql:${sourceSet}:column:orders.id`,
        file: sourceUri,
        name: "id",
        kind: "column",
        signature: "bigint",
        line_range: [2, 2] as [number, number],
        postgres: table,
      },
    ],
    sourceSet: { srcset: sourceSet, revision: result.revision, documents: [] },
    documents: new Map(),
    origins: new Map(),
    foreignKeys: [],
    viewDependencies: [],
    resources: new Map(),
  };
}

function newController(connections: FakeConnections): WorkbenchIndexController {
  return new WorkbenchIndexController(testHost(), connections as unknown as IndexConnections);
}

describe("WorkbenchIndexController SQL authoring snapshot", () => {
  const scope = SCOPE_A;

  it("memoizes the snapshot until the registry or its staleness changes", () => {
    const controller = newController(new FakeConnections());
    const registry = tableRegistry(indexResult());
    type Registry = ReturnType<typeof tableRegistry>;
    const internals = controller as unknown as {
      registries: Map<string, Registry>;
      publishRegistry(
        scope: string,
        registry: Registry,
        change: { kind: "full"; schemas: []; sourceUris: [] },
      ): void;
    };
    internals.registries.set(scope, registry);
    const identity = { connectionId: "connection-a", database: "database-a" };

    const first = controller.sqlAuthoringSnapshot(identity);
    expect(first).toMatchObject({
      status: "available",
      revision: "revision-a",
      objects: [{ name: "orders", kind: "table", columns: [{ name: "id", type: "bigint" }] }],
    });
    expect(controller.sqlAuthoringSnapshot(identity)).toBe(first);

    controller.markDatabaseStale("connection-a", "database-a", "schema changed");
    const stale = controller.sqlAuthoringSnapshot(identity);
    expect(stale).not.toBe(first);
    expect(stale).toMatchObject({ status: "stale", revision: "revision-a" });
    expect(controller.sqlAuthoringSnapshot(identity)).toBe(stale);

    const refreshed = tableRegistry(indexResult({ revision: "revision-b", generation: 2 }));
    internals.registries.set(scope, refreshed);
    internals.publishRegistry(scope, refreshed, { kind: "full", schemas: [], sourceUris: [] });
    const rebuilt = controller.sqlAuthoringSnapshot(identity);
    expect(rebuilt).not.toBe(stale);
    expect(rebuilt).toMatchObject({ status: "available", revision: "revision-b", generation: 2 });
    expect(controller.sqlAuthoringSnapshot(identity)).toBe(rebuilt);

    registry.result.generation = 7;
    internals.registries.set(scope, registry);
    expect(controller.sqlAuthoringSnapshot(identity)).toMatchObject({ generation: 7 });
    registry.result.generation = 8;
    expect(controller.sqlAuthoringSnapshot(identity)).toMatchObject({ generation: 8 });
    controller.dispose();
  });

  it("keeps equal object names and OIDs in independent Connection URI scopes", () => {
    const controller = newController(new FakeConnections());
    const first = tableRegistry(indexResult());
    const secondIdentity = { connectionId: "connection-b", database: "database-b" };
    const second = tableRegistry(
      indexResult({ ...secondIdentity, revision: "revision-b", generation: 2 }),
    );
    const internals = controller as unknown as {
      registries: Map<string, typeof first>;
    };
    internals.registries.set(SCOPE_A, first);
    internals.registries.set(SCOPE_B, second);

    const firstSnapshot = controller.sqlAuthoringSnapshot({
      connectionId: "connection-a",
      database: "database-a",
    });
    const secondSnapshot = controller.sqlAuthoringSnapshot(secondIdentity);

    expect(first.sourceSet.srcset).not.toBe(second.sourceSet.srcset);
    expect(first.symbols[0]?.file).not.toBe(second.symbols[0]?.file);
    expect(firstSnapshot).toMatchObject({
      connectionId: "connection-a",
      database: "database-a",
      revision: "revision-a",
      objects: [{ name: "orders", oid: 10 }],
    });
    expect(secondSnapshot).toMatchObject({
      connectionId: "connection-b",
      database: "database-b",
      revision: "revision-b",
      objects: [{ name: "orders", oid: 10 }],
    });
    controller.dispose();
  });

  it("clears only the refreshed Connection stale flag and publishes its exact state", async () => {
    const connections = new FakeConnections();
    const controller = newController(connections);
    const identity = { connectionId: "connection-b", database: "database-b" };
    const inactiveScope = SCOPE_B;
    const previous = tableRegistry(indexResult({ ...identity }));
    const refreshed = tableRegistry(indexResult({ ...identity, revision: "revision-b" }));
    const internals = controller as unknown as {
      registries: Map<string, typeof previous>;
      publishAndReadCatalog: () => Promise<unknown>;
    };
    internals.registries.set(inactiveScope, previous);
    internals.publishAndReadCatalog = vi.fn(async () => {
      internals.registries.set(inactiveScope, refreshed);
      return {
        result: refreshed.result,
        registry: refreshed,
        session: { metadata: { source: "test" } },
      };
    });
    vi.mocked(readPostgresCatalog).mockResolvedValueOnce({} as never);
    const states: unknown[] = [];
    controller.onDidChangeState((state) => states.push(state));

    controller.markDatabaseStale(identity.connectionId, identity.database, "schema changed");
    expect(state(controller, "connection-b")).toMatchObject({
      status: "stale",
      connectionId: "connection-b",
    });
    expect(controller.isDatabaseStale(identity.connectionId, identity.database)).toBe(true);
    expect(controller.sqlAuthoringSnapshot(identity)).toMatchObject({ status: "stale" });

    await expect(
      controller.indexPostgresDatabase({ query: vi.fn() } as never, identity),
    ).resolves.toBe(refreshed.result);

    expect(controller.isDatabaseStale(identity.connectionId, identity.database)).toBe(false);
    expect(controller.sqlAuthoringSnapshot(identity)).toMatchObject({
      status: "available",
      revision: "revision-b",
    });
    expect(states.at(-1)).toMatchObject({
      status: "available",
      connectionId: "connection-b",
      result: refreshed.result,
    });
    expect(state(controller, "connection-b")).toMatchObject({
      status: "available",
      result: refreshed.result,
    });
    expect(symbols(controller, "connection-b")).toEqual(refreshed.symbols);
    controller.dispose();
  });
});
