import type { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { ConnectionManager } from "./connectionManager.js";
import type { ServerConfig } from "./serverStore.js";
import type { WorkbenchIndexController } from "./workbenchIndexController.js";

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

  return {
    EventEmitter,
    workspace: {
      getConfiguration: () => ({
        get: (_key: string, fallback: unknown) => fallback,
      }),
      onDidChangeConfiguration: () => ({ dispose: () => undefined }),
    },
  };
});

import { WorkbenchDdlSyncController } from "./workbenchDdlSync.js";

const SERVER: ServerConfig = {
  id: "local:5432/app:postgres",
  name: "postgres@local/app",
  host: "local",
  port: 5432,
  database: "app",
  user: "postgres",
  schemaSync: { enabled: true, supportSchema: "workbench" },
};

class FakeClient {
  readonly queries: string[] = [];
  readonly end = vi.fn(async () => undefined);
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>();

  constructor(private readonly listener = false) {}

  async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
    this.queries.push(sql);
    if (this.listener && sql.includes("schema_exists")) {
      return {
        rows: [
          {
            schema_exists: true,
            ddl_function_exists: true,
            drop_function_exists: true,
            ddl_trigger_exists: true,
            drop_trigger_exists: true,
            database_oid: "42",
          },
        ],
      };
    }
    return { rows: [] };
  }

  on(event: string, listener: (...args: never[]) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value as never);
  }
}

class FailingClient extends FakeClient {
  override async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
    this.queries.push(sql);
    throw Object.assign(new Error("database unavailable"), { code: "08006" });
  }
}

describe("WorkbenchDdlSyncController", () => {
  it("listens with a dedicated client and coalesces DDL into an incremental refresh", async () => {
    const listener = new FakeClient(true);
    const refresh = new FakeClient();
    const connectionListeners = new Set<() => void>();
    const clients = [listener, refresh];
    const connections = {
      servers: [SERVER],
      store: { get: (serverId: string) => (serverId === SERVER.id ? SERVER : undefined) },
      onChanged(callback: () => void): vscode.Disposable {
        connectionListeners.add(callback);
        return { dispose: () => connectionListeners.delete(callback) };
      },
      createDedicatedClient: vi.fn(async () => clients.shift() as unknown as Client),
      isActiveServer: (serverId: string) => serverId === SERVER.id,
    };
    let stale = false;
    const synchronize = vi.fn(
      async (
        _client: unknown,
        _identity: { serverId: string; database: string },
        _objects: readonly unknown[],
      ) => {
        stale = false;
        return {};
      },
    );
    const index = {
      markDatabaseStale: vi.fn(() => {
        stale = true;
      }),
      isDatabaseStale: () => stale,
      synchronizeActiveDatabaseDdl: synchronize,
    };
    const controller = new WorkbenchDdlSyncController(
      connections as unknown as ConnectionManager,
      index as unknown as WorkbenchIndexController,
      { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    );

    await vi.waitFor(() => expect(controller.state(SERVER.id).status).toBe("listening"));
    expect(listener.queries.at(-1)).toBe("LISTEN plpgsql_workbench_ddl");

    const payload = JSON.stringify({
      v: 1,
      db: 42,
      tx: "101",
      event: "ddl_command_end",
      objects: [
        {
          classid: 1259,
          objid: 9001,
          objsubid: 0,
          command_tag: "ALTER TABLE",
          object_type: "table",
          schema_name: "app",
          object_identity: "app.account",
        },
      ],
    });
    listener.emit("notification", { channel: "plpgsql_workbench_ddl", payload });
    listener.emit("notification", { channel: "plpgsql_workbench_ddl", payload });

    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledTimes(1));
    expect(index.markDatabaseStale).toHaveBeenCalledWith(
      SERVER.id,
      SERVER.database,
      "PostgreSQL schema changed in transaction 101",
    );
    expect(synchronize.mock.calls[0]?.[2]).toHaveLength(1);
    expect(refresh.end).toHaveBeenCalledOnce();

    controller.dispose();
  });

  it("forces a full refresh after rejecting a notification before accepting later DDL", async () => {
    const listener = new FakeClient(true);
    const refresh = new FakeClient();
    const connections = connectionsWithClients([listener, refresh]);
    let stale = false;
    const synchronize = vi.fn(
      async (
        _client: unknown,
        _identity: { serverId: string; database: string },
        _objects: readonly unknown[],
        _fallbackReason?: string,
      ) => {
        stale = false;
        return {};
      },
    );
    const index = {
      markDatabaseStale: vi.fn(() => {
        stale = true;
      }),
      isDatabaseStale: () => stale,
      synchronizeActiveDatabaseDdl: synchronize,
    };
    const controller = new WorkbenchDdlSyncController(
      connections.value as unknown as ConnectionManager,
      index as unknown as WorkbenchIndexController,
      { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    );
    await vi.waitFor(() => expect(controller.state(SERVER.id).status).toBe("listening"));

    listener.emit("notification", {
      channel: "plpgsql_workbench_ddl",
      payload: "not-json",
    });
    expect(controller.state(SERVER.id).status).toBe("desynchronized");
    listener.emit("notification", {
      channel: "plpgsql_workbench_ddl",
      payload: ddlPayload("102"),
    });

    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledOnce());
    expect(synchronize.mock.calls[0]?.[3]).toBe(
      "schema listener missed or rejected a DDL notification",
    );
    expect(controller.state(SERVER.id).status).toBe("listening");
    controller.dispose();
  });

  it("deduplicates concurrent starts and cannot leave a listener after opt-out", async () => {
    const listener = new FakeClient(true);
    let resolveClient: ((client: Client) => void) | undefined;
    const pendingClient = new Promise<Client>((resolve) => {
      resolveClient = resolve;
    });
    let server: ServerConfig = { ...SERVER, schemaSync: { ...SERVER.schemaSync } };
    const connectionListeners = new Set<() => void>();
    const createDedicatedClient = vi.fn(() => pendingClient);
    const connections = {
      get servers() {
        return [server];
      },
      store: { get: (serverId: string) => (serverId === server.id ? server : undefined) },
      onChanged(callback: () => void): vscode.Disposable {
        connectionListeners.add(callback);
        return { dispose: () => connectionListeners.delete(callback) };
      },
      createDedicatedClient,
      isActiveServer: () => true,
    };
    const index = indexStub();
    const controller = new WorkbenchDdlSyncController(
      connections as unknown as ConnectionManager,
      index.value as unknown as WorkbenchIndexController,
      { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    );
    for (const changed of connectionListeners) changed();
    for (const changed of connectionListeners) changed();
    expect(createDedicatedClient).toHaveBeenCalledOnce();

    server = { ...server, schemaSync: { enabled: false, supportSchema: "workbench" } };
    for (const changed of connectionListeners) changed();
    resolveClient!(listener as unknown as Client);

    await vi.waitFor(() => expect(listener.end).toHaveBeenCalledOnce());
    expect(listener.queries).not.toContain("LISTEN plpgsql_workbench_ddl");
    expect(controller.state(SERVER.id).status).toBe("disabled");
    expect(createDedicatedClient).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("marks the index stale when provisioning is missing or removal fails", async () => {
    const notProvisioned = new FakeClient();
    const firstConnections = connectionsWithClients([notProvisioned]);
    const firstIndex = indexStub();
    const first = new WorkbenchDdlSyncController(
      firstConnections.value as unknown as ConnectionManager,
      firstIndex.value as unknown as WorkbenchIndexController,
      { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    );
    await vi.waitFor(() => expect(first.state(SERVER.id).status).toBe("provisioning-required"));
    expect(firstIndex.markDatabaseStale).toHaveBeenCalledWith(
      SERVER.id,
      SERVER.database,
      "Schema synchronization requires explicit database provisioning",
    );
    first.dispose();

    const listener = new FakeClient(true);
    const removal = new FailingClient();
    const secondConnections = connectionsWithClients([listener, removal]);
    const secondIndex = indexStub();
    const second = new WorkbenchDdlSyncController(
      secondConnections.value as unknown as ConnectionManager,
      secondIndex.value as unknown as WorkbenchIndexController,
      { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    );
    await vi.waitFor(() => expect(second.state(SERVER.id).status).toBe("listening"));

    await expect(second.removeProvisioning(SERVER.id)).rejects.toThrow("database unavailable");
    expect(listener.end).toHaveBeenCalledOnce();
    expect(second.state(SERVER.id).status).toBe("unavailable");
    expect(secondIndex.markDatabaseStale).toHaveBeenCalledWith(
      SERVER.id,
      SERVER.database,
      "Schema synchronization removal failed after the listener stopped",
    );
    second.dispose();
  });
});

function ddlPayload(transactionId: string): string {
  return JSON.stringify({
    v: 1,
    db: 42,
    tx: transactionId,
    event: "ddl_command_end",
    objects: [
      {
        classid: 1259,
        objid: 9001,
        objsubid: 0,
        command_tag: "ALTER TABLE",
        object_type: "table",
        schema_name: "app",
        object_identity: "app.account",
      },
    ],
  });
}

function connectionsWithClients(clients: FakeClient[]) {
  const connectionListeners = new Set<() => void>();
  return {
    value: {
      servers: [SERVER],
      store: { get: (serverId: string) => (serverId === SERVER.id ? SERVER : undefined) },
      onChanged(callback: () => void): vscode.Disposable {
        connectionListeners.add(callback);
        return { dispose: () => connectionListeners.delete(callback) };
      },
      createDedicatedClient: vi.fn(async () => clients.shift() as unknown as Client),
      isActiveServer: (serverId: string) => serverId === SERVER.id,
    },
  };
}

function indexStub() {
  let stale = false;
  const markDatabaseStale = vi.fn(() => {
    stale = true;
  });
  return {
    markDatabaseStale,
    value: {
      markDatabaseStale,
      isDatabaseStale: () => stale,
      synchronizeActiveDatabaseDdl: vi.fn(async () => {
        stale = false;
        return {};
      }),
    },
  };
}
