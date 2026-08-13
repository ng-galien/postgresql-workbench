import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { LocalCodeMonikerSession } from "../../src/workbench/localCodeMoniker.js";
import type {
  PostgresCatalogSnapshot,
  VirtualSqlSourceSet,
} from "../../src/workbench/postgresCatalog.js";
import type { ConnectionManager } from "./connectionManager.js";

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

  return { EventEmitter };
});

import type { WorkbenchIndexResult } from "./workbenchIndexController.js";
import { WorkbenchIndexController } from "./workbenchIndexController.js";

interface TestServer {
  id: string;
  database: string;
}

class FakeConnections {
  private readonly listeners = new Set<() => void>();
  activeServer: TestServer | undefined = { id: "server-a", database: "database-a" };
  isConnected = true;

  onChanged(listener: () => void): vscode.Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => this.listeners.delete(listener),
    };
  }

  getClient(): { query(): Promise<never> } {
    return {
      query: () => Promise.reject(new Error("catalog unavailable")),
    };
  }

  switchTo(server: TestServer | undefined): void {
    this.activeServer = server;
    this.isConnected = server !== undefined;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

describe("WorkbenchIndexController connection state", () => {
  it("clears a pre-publication indexing error on switch and disconnect", async () => {
    const connections = new FakeConnections();
    const controller = new WorkbenchIndexController(
      {
        extensionPath: "/extension",
        globalStorageUri: { fsPath: "/storage" },
      } as vscode.ExtensionContext,
      connections as unknown as ConnectionManager,
      { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    );

    await expect(controller.indexActiveDatabase()).rejects.toThrow("catalog unavailable");
    expect(controller.state).toMatchObject({
      status: "error",
      serverId: "server-a",
    });

    connections.switchTo({ id: "server-b", database: "database-b" });

    expect(controller.state).toEqual({ status: "not-indexed" });
    expect(controller.indexedSymbols).toEqual([]);

    await expect(controller.indexActiveDatabase()).rejects.toThrow("catalog unavailable");
    expect(controller.state).toMatchObject({
      status: "error",
      serverId: "server-b",
    });

    connections.switchTo(undefined);

    expect(controller.state).toEqual({ status: "not-indexed" });
    controller.dispose();
  });

  it("keeps the previous source snapshot visible in a distinct failed state", async () => {
    const connections = new FakeConnections();
    const controller = new WorkbenchIndexController(
      {
        extensionPath: "/extension",
        globalStorageUri: { fsPath: "/storage" },
      } as vscode.ExtensionContext,
      connections as unknown as ConnectionManager,
      { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    );
    const result: WorkbenchIndexResult = {
      serverId: "server-a",
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
    const internals = controller as unknown as {
      stateScope: string;
      currentState: { status: "available"; serverId: string; result: WorkbenchIndexResult };
      currentSymbols: (typeof symbol)[];
    };
    internals.stateScope = "server-a\0database-a";
    internals.currentState = { status: "available", serverId: "server-a", result };
    internals.currentSymbols = [symbol];

    await expect(controller.indexActiveDatabase()).rejects.toThrow("catalog unavailable");

    expect(controller.state).toMatchObject({ status: "error", result });
    expect(controller.indexedSymbols).toEqual([symbol]);
    controller.dispose();
  });

  it("cancels a refresh without replacing the previous source snapshot", async () => {
    const connections = new FakeConnections();
    const controller = new WorkbenchIndexController(
      {
        extensionPath: "/extension",
        globalStorageUri: { fsPath: "/storage" },
      } as vscode.ExtensionContext,
      connections as unknown as ConnectionManager,
      { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    );
    const result: WorkbenchIndexResult = {
      serverId: "server-a",
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
    const internals = controller as unknown as {
      stateScope: string;
      currentState: { status: "available"; serverId: string; result: WorkbenchIndexResult };
      currentSymbols: (typeof symbol)[];
    };
    internals.stateScope = "server-a\0database-a";
    internals.currentState = { status: "available", serverId: "server-a", result };
    internals.currentSymbols = [symbol];

    const refresh = controller.indexActiveDatabase();
    expect(controller.state).toMatchObject({
      status: "indexing",
      result,
      progress: { phase: "reading-catalog" },
    });
    expect(controller.cancelActiveDatabaseIndex()).toBe(true);
    expect(controller.cancelActiveDatabaseIndex()).toBe(false);
    expect(controller.state).toMatchObject({
      status: "indexing",
      result,
      progress: { phase: "cancelling" },
    });

    await expect(refresh).rejects.toThrow("indexing was cancelled");
    expect(controller.state).toMatchObject({ status: "cancelled", result });
    expect(controller.indexedSymbols).toEqual([symbol]);
    controller.dispose();
  });

  it.each(["late validation failure", "late cancellation"])(
    "restores the published source set after a %s",
    async (failure) => {
      const connections = new FakeConnections();
      const controller = new WorkbenchIndexController(
        {
          extensionPath: "/extension",
          globalStorageUri: { fsPath: "/storage" },
        } as vscode.ExtensionContext,
        connections as unknown as ConnectionManager,
        { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
      );
      const previousResult: WorkbenchIndexResult = {
        serverId: "server-a",
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
            uri: "postgresql://server-a/database-a/old.sql",
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
            uri: "postgresql://server-a/database-a/new.sql",
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
      const scope = "server-a\0database-a";
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
      const previousPublished = { scope, serverId: "server-a", srcset: "postgres-test" };
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
          serverId: string,
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
          "server-a",
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
