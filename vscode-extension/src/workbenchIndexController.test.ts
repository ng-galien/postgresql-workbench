import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
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

  it("keeps the previous source snapshot visible while a same-context refresh fails", async () => {
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

    expect(controller.state).toMatchObject({ status: "stale", result });
    expect(controller.indexedSymbols).toEqual([symbol]);
    controller.dispose();
  });
});
