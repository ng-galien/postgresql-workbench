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
  readonly end = vi.fn(async (): Promise<void> => undefined);
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>();

  constructor(
    private readonly listener = false,
    readonly processID = 1_001,
  ) {}

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

class DelayedListenClient extends FakeClient {
  readonly listenStarted = deferred<void>();
  readonly releaseListen = deferred<void>();

  override async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
    if (sql === "LISTEN plpgsql_workbench_ddl") {
      this.queries.push(sql);
      this.listenStarted.resolve();
      await this.releaseListen.promise;
      return { rows: [] };
    }
    return super.query(sql);
  }
}

class NotifyingListenClient extends FakeClient {
  override async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
    if (sql === "LISTEN plpgsql_workbench_ddl") {
      this.queries.push(sql);
      this.emit("notification", {
        channel: "plpgsql_workbench_ddl",
        payload: ddlPayload("100"),
      });
      return { rows: [] };
    }
    return super.query(sql);
  }
}

class ErroringListenClient extends FakeClient {
  override async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
    if (sql === "LISTEN plpgsql_workbench_ddl") {
      this.queries.push(sql);
      this.emit(
        "error",
        Object.assign(new Error("listener failed during LISTEN"), { code: "08006" }),
      );
      return { rows: [] };
    }
    return super.query(sql);
  }
}

class FailingClient extends FakeClient {
  override async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
    this.queries.push(sql);
    throw Object.assign(new Error("database unavailable"), { code: "08006" });
  }
}

describe("WorkbenchDdlSyncController", () => {
  it("buffers a DDL notification delivered while LISTEN is completing", async () => {
    vi.useFakeTimers();
    const listener = new NotifyingListenClient(true);
    const refresh = new FakeClient();
    const connections = connectionsWithClients([listener, refresh]);
    const index = indexStub();
    const controller = new WorkbenchDdlSyncController(
      connections.value as unknown as ConnectionManager,
      index.value as unknown as WorkbenchIndexController,
      { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    );
    try {
      await drainMicrotasks(50);
      expect(controller.state(SERVER.id).status).toBe("listening");
      expect(index.markDatabaseStale).toHaveBeenCalledWith(
        SERVER.id,
        SERVER.database,
        "PostgreSQL schema changed in transaction 100",
      );
      expect(controller.diagnosticState(SERVER.id).listener?.queuedNotifications).toBe(1);
      expect(index.value.synchronizeActiveDatabaseDdl).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);
      await drainMicrotasks();
      expect(index.value.synchronizeActiveDatabaseDdl).toHaveBeenCalledOnce();
      expect(index.value.synchronizeActiveDatabaseDdl.mock.calls[0]?.[2]).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      controller.dispose();
    }
  });

  it("handles a listener error emitted during LISTEN startup", async () => {
    const listener = new ErroringListenClient(true);
    const connections = connectionsWithClients([listener]);
    const index = indexStub();
    const controller = new WorkbenchDdlSyncController(
      connections.value as unknown as ConnectionManager,
      index.value as unknown as WorkbenchIndexController,
      { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    );

    await vi.waitFor(() => expect(listener.end).toHaveBeenCalledOnce());
    expect(controller.state(SERVER.id).status).toBe("unavailable");
    expect(index.markDatabaseStale).toHaveBeenCalledWith(
      SERVER.id,
      SERVER.database,
      "Schema synchronization listener is unavailable",
    );
    controller.dispose();
  });

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
    const appendLine = vi.fn();
    const controller = new WorkbenchDdlSyncController(
      connections as unknown as ConnectionManager,
      index as unknown as WorkbenchIndexController,
      { appendLine } as unknown as vscode.OutputChannel,
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
    expect(index.markDatabaseStale).toHaveBeenCalledWith(
      SERVER.id,
      SERVER.database,
      "PostgreSQL schema changed in transaction 101",
    );
    expect(index.isDatabaseStale()).toBe(true);
    expect(synchronize).not.toHaveBeenCalled();
    listener.emit("notification", { channel: "plpgsql_workbench_ddl", payload });

    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledTimes(1));
    expect(synchronize.mock.calls[0]?.[2]).toHaveLength(1);
    expect(refresh.end).toHaveBeenCalledOnce();
    expect(appendLine).toHaveBeenCalledWith(
      expect.stringContaining("Workbench DDL notification received: database=app"),
    );
    expect(appendLine).toHaveBeenCalledWith(
      expect.stringContaining("mode=incremental objects=table:1"),
    );
    expect(appendLine).toHaveBeenCalledWith(
      expect.stringContaining("Workbench DDL refresh complete: database=app mode=incremental"),
    );
    expect(controller.diagnosticState(SERVER.id)).toMatchObject({
      state: { status: "listening" },
      listener: {
        queuedNotifications: 0,
        flushActive: false,
      },
      refresh: { active: false, queued: 0 },
      lastReceivedTransactionId: "101",
      lastCompletedTransactionId: "101",
    });

    controller.dispose();
  });

  it("stops on opt-out and resumes the existing provisioning on opt-in", async () => {
    const firstListener = new FakeClient(true);
    const secondListener = new FakeClient(true);
    const refresh = new FakeClient();
    const clients = [firstListener, secondListener, refresh];
    let server: ServerConfig = { ...SERVER, schemaSync: { ...SERVER.schemaSync } };
    const connectionListeners = new Set<() => void>();
    const connections = {
      get servers() {
        return [server];
      },
      store: { get: (serverId: string) => (serverId === server.id ? server : undefined) },
      onChanged(callback: () => void): vscode.Disposable {
        connectionListeners.add(callback);
        return { dispose: () => connectionListeners.delete(callback) };
      },
      createDedicatedClient: vi.fn(async () => clients.shift() as unknown as Client),
      isActiveServer: () => true,
    };
    const index = indexStub();
    const controller = new WorkbenchDdlSyncController(
      connections as unknown as ConnectionManager,
      index.value as unknown as WorkbenchIndexController,
      { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    );
    await vi.waitFor(() => expect(controller.state(SERVER.id).status).toBe("listening"));

    server = { ...server, schemaSync: { enabled: false, supportSchema: "workbench" } };
    for (const changed of connectionListeners) changed();
    await vi.waitFor(() => expect(controller.state(SERVER.id).status).toBe("disabled"));
    expect(firstListener.end).toHaveBeenCalledOnce();

    server = { ...server, schemaSync: { enabled: true, supportSchema: "workbench" } };
    for (const changed of connectionListeners) changed();
    await vi.waitFor(() => expect(controller.state(SERVER.id).status).toBe("listening"));
    expect(secondListener.queries.at(-1)).toBe("LISTEN plpgsql_workbench_ddl");
    expect(secondListener.queries.some((query) => query.includes("CREATE EVENT TRIGGER"))).toBe(
      false,
    );
    expect(index.value.synchronizeActiveDatabaseDdl).toHaveBeenCalledOnce();
    expect(index.value.synchronizeActiveDatabaseDdl.mock.calls[0]?.[3]).toBe(
      "listener reconnected after a notification gap",
    );
    controller.dispose();
  });

  it("serializes immediate opt-in behind an opt-out whose listener close is delayed", async () => {
    const listenerClosed = deferred<void>();
    const firstListener = new FakeClient(true, 1_001);
    firstListener.end.mockImplementation(async () => listenerClosed.promise);
    const secondListener = new FakeClient(true, 1_002);
    const refresh = new FakeClient(false, 1_003);
    const clients = [firstListener, secondListener, refresh];
    let server: ServerConfig = { ...SERVER, schemaSync: { ...SERVER.schemaSync } };
    const connectionListeners = new Set<() => void>();
    const setSchemaSyncOverride = vi.fn(
      async (_serverId: string, schemaSync: ServerConfig["schemaSync"]) => {
        server = { ...server, schemaSync };
        for (const changed of connectionListeners) changed();
      },
    );
    const connections = {
      get servers() {
        return [server];
      },
      store: { get: (serverId: string) => (serverId === server.id ? server : undefined) },
      onChanged(callback: () => void): vscode.Disposable {
        connectionListeners.add(callback);
        return { dispose: () => connectionListeners.delete(callback) };
      },
      setSchemaSyncOverride,
      createDedicatedClient: vi.fn(async () => clients.shift() as unknown as Client),
      isActiveServer: () => true,
    };
    const index = indexStub();
    const controller = new WorkbenchDdlSyncController(
      connections as unknown as ConnectionManager,
      index.value as unknown as WorkbenchIndexController,
      { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    );
    await vi.waitFor(() => expect(controller.state(SERVER.id).status).toBe("listening"));

    const disabling = controller.setConnectionEnabled(SERVER.id, false);
    await vi.waitFor(() => expect(firstListener.end).toHaveBeenCalledOnce());
    const enabling = controller.setConnectionEnabled(SERVER.id, true);
    expect(setSchemaSyncOverride).not.toHaveBeenCalled();
    expect(server.schemaSync?.enabled).toBe(true);
    expect(controller.diagnosticState(SERVER.id).lifecycle).toMatchObject({
      active: true,
      queued: 1,
    });

    listenerClosed.resolve();
    await Promise.all([disabling, enabling]);

    await vi.waitFor(() => expect(controller.state(SERVER.id).status).toBe("listening"));
    expect(secondListener.queries.at(-1)).toBe("LISTEN plpgsql_workbench_ddl");
    expect(setSchemaSyncOverride.mock.calls.map((call) => call[1]?.enabled)).toEqual([false, true]);
    expect(firstListener.end).toHaveBeenCalledOnce();
    expect(secondListener.end).not.toHaveBeenCalled();
    expect(index.value.synchronizeActiveDatabaseDdl).toHaveBeenCalledOnce();
    expect(controller.diagnosticState(SERVER.id)).toMatchObject({
      desired: { enabled: true, supportSchema: "workbench" },
      state: { status: "listening" },
      listener: { processId: 1_002 },
      lifecycle: { active: false, queued: 0 },
    });
    controller.dispose();
  });

  it("invalidates a delayed LISTEN across opt-out and opt-in without losing the restart", async () => {
    const firstListener = new DelayedListenClient(true, 2_001);
    const secondListener = new FakeClient(true, 2_002);
    const refresh = new FakeClient(false, 2_003);
    const clients = [firstListener, secondListener, refresh];
    let server: ServerConfig = { ...SERVER, schemaSync: { ...SERVER.schemaSync } };
    const connectionListeners = new Set<() => void>();
    const setSchemaSyncOverride = vi.fn(
      async (_serverId: string, schemaSync: ServerConfig["schemaSync"]) => {
        server = { ...server, schemaSync };
        for (const changed of connectionListeners) changed();
      },
    );
    const connections = {
      get servers() {
        return [server];
      },
      store: { get: (serverId: string) => (serverId === server.id ? server : undefined) },
      onChanged(callback: () => void): vscode.Disposable {
        connectionListeners.add(callback);
        return { dispose: () => connectionListeners.delete(callback) };
      },
      setSchemaSyncOverride,
      createDedicatedClient: vi.fn(async () => clients.shift() as unknown as Client),
      isActiveServer: () => true,
    };
    const index = indexStub();
    const controller = new WorkbenchDdlSyncController(
      connections as unknown as ConnectionManager,
      index.value as unknown as WorkbenchIndexController,
      { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    );
    await firstListener.listenStarted.promise;

    const disabling = controller.setConnectionEnabled(SERVER.id, false);
    const enabling = controller.setConnectionEnabled(SERVER.id, true);
    expect(controller.diagnosticState(SERVER.id).lifecycle).toMatchObject({
      active: true,
      queued: 2,
    });

    firstListener.releaseListen.resolve();
    await Promise.all([disabling, enabling]);
    await vi.waitFor(() => expect(controller.state(SERVER.id).status).toBe("listening"));

    expect(firstListener.end).toHaveBeenCalledOnce();
    expect(secondListener.queries.at(-1)).toBe("LISTEN plpgsql_workbench_ddl");
    expect(secondListener.end).not.toHaveBeenCalled();
    expect(connections.createDedicatedClient).toHaveBeenCalledTimes(3);
    expect(index.value.synchronizeActiveDatabaseDdl).toHaveBeenCalledOnce();
    expect(controller.diagnosticState(SERVER.id)).toMatchObject({
      desired: { enabled: true, supportSchema: "workbench" },
      state: { status: "listening" },
      listener: { processId: 2_002 },
      lifecycle: { active: false, queued: 0 },
    });
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

  it("preserves a newer full-refresh debt when the listener closes during an older refresh", async () => {
    const firstListener = new FakeClient(true, 3_001);
    const firstRefreshClient = new FakeClient(false, 3_002);
    const secondListener = new FakeClient(true, 3_003);
    const secondRefreshClient = new FakeClient(false, 3_004);
    const connections = connectionsWithClients([
      firstListener,
      firstRefreshClient,
      secondListener,
      secondRefreshClient,
    ]);
    const firstRefresh = deferred<{ generation: number }>();
    let stale = false;
    let refreshCount = 0;
    const synchronize = vi.fn(
      async (
        _client: unknown,
        _identity: { serverId: string; database: string },
        _objects: readonly unknown[],
        _fallbackReason?: string,
      ) => {
        refreshCount += 1;
        const result =
          refreshCount === 1 ? await firstRefresh.promise : { generation: refreshCount + 1 };
        stale = false;
        return result;
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

    vi.useFakeTimers();
    try {
      firstListener.emit("notification", {
        channel: "plpgsql_workbench_ddl",
        payload: "not-json",
      });
      firstListener.emit("notification", {
        channel: "plpgsql_workbench_ddl",
        payload: ddlPayload("103"),
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(synchronize).toHaveBeenCalledOnce();
      expect(controller.diagnosticState(SERVER.id).fullRefreshDebtEpoch).toBe(1);

      firstListener.emit("error", new Error("listener connection lost"));
      await drainMicrotasks();
      expect(firstListener.end).toHaveBeenCalledOnce();
      expect(controller.diagnosticState(SERVER.id)).toMatchObject({
        state: { status: "desynchronized" },
        lifecycle: { reconnectScheduled: true },
        fullRefreshDebtEpoch: 2,
      });

      firstRefresh.resolve({ generation: 2 });
      await drainMicrotasks();
      expect(controller.diagnosticState(SERVER.id).fullRefreshDebtEpoch).toBe(2);
      expect(index.isDatabaseStale()).toBe(true);

      await vi.advanceTimersByTimeAsync(2_000);
      await drainMicrotasks();
      expect(synchronize).toHaveBeenCalledTimes(2);
      expect(synchronize.mock.calls[1]?.[3]).toBe("listener reconnected after a notification gap");
      expect(controller.diagnosticState(SERVER.id)).toMatchObject({
        state: { status: "listening" },
        listener: { processId: 3_003 },
        lifecycle: { reconnectScheduled: false },
        refresh: { active: false, queued: 0 },
      });
      expect(controller.diagnosticState(SERVER.id).fullRefreshDebtEpoch).toBeUndefined();
      expect(index.isDatabaseStale()).toBe(false);
      expect(connections.value.createDedicatedClient).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
      controller.dispose();
    }
  });

  it("retries a failed activation refresh before accepting later incremental DDL", async () => {
    const firstListener = new FakeClient(true, 4_001);
    const failedRefreshClient = new FakeClient(false, 4_002);
    const secondListener = new FakeClient(true, 4_003);
    const successfulRefreshClient = new FakeClient(false, 4_004);
    const clients = [firstListener, failedRefreshClient, secondListener, successfulRefreshClient];
    const connectionListeners = new Set<() => void>();
    let active = false;
    const connections = {
      servers: [SERVER],
      store: { get: (serverId: string) => (serverId === SERVER.id ? SERVER : undefined) },
      onChanged(callback: () => void): vscode.Disposable {
        connectionListeners.add(callback);
        return { dispose: () => connectionListeners.delete(callback) };
      },
      createDedicatedClient: vi.fn(async () => clients.shift() as unknown as Client),
      isActiveServer: () => active,
    };
    let stale = false;
    let refreshCount = 0;
    const synchronize = vi.fn(
      async (
        _client: unknown,
        _identity: { serverId: string; database: string },
        _objects: readonly unknown[],
        _fallbackReason?: string,
      ) => {
        refreshCount += 1;
        if (refreshCount === 1) throw new Error("catalog refresh failed");
        stale = false;
        return { generation: refreshCount + 1 };
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

    vi.useFakeTimers();
    try {
      firstListener.emit("notification", {
        channel: "plpgsql_workbench_ddl",
        payload: ddlPayload("201"),
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(synchronize).not.toHaveBeenCalled();
      expect(controller.diagnosticState(SERVER.id)).toMatchObject({
        fullRefreshDebtEpoch: 1,
        pendingFullRefreshTransactionId: "201",
        lastReceivedTransactionId: "201",
      });
      expect(controller.diagnosticState(SERVER.id).lastCompletedTransactionId).toBeUndefined();

      active = true;
      for (const changed of connectionListeners) changed();
      await drainMicrotasks();
      expect(synchronize).toHaveBeenCalledOnce();
      expect(synchronize.mock.calls[0]?.[2]).toEqual([]);
      expect(synchronize.mock.calls[0]?.[3]).toBe(
        "DatabaseContext became active after schema changes while inactive",
      );
      expect(firstListener.end).toHaveBeenCalledOnce();
      expect(controller.diagnosticState(SERVER.id)).toMatchObject({
        state: { status: "desynchronized" },
        lifecycle: { reconnectScheduled: true },
        pendingFullRefreshTransactionId: "201",
      });
      expect(controller.diagnosticState(SERVER.id).lastCompletedTransactionId).toBeUndefined();

      firstListener.emit("notification", {
        channel: "plpgsql_workbench_ddl",
        payload: ddlPayload("202"),
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(synchronize).toHaveBeenCalledOnce();
      expect(controller.diagnosticState(SERVER.id).lastReceivedTransactionId).toBe("201");

      await vi.advanceTimersByTimeAsync(2_000);
      await drainMicrotasks();
      expect(synchronize).toHaveBeenCalledTimes(2);
      expect(synchronize.mock.calls[1]?.[2]).toEqual([]);
      expect(synchronize.mock.calls[1]?.[3]).toBe("listener reconnected after a notification gap");
      expect(controller.diagnosticState(SERVER.id)).toMatchObject({
        state: { status: "listening" },
        listener: { processId: 4_003 },
        lastCompletedTransactionId: "201",
      });
      expect(controller.diagnosticState(SERVER.id).fullRefreshDebtEpoch).toBeUndefined();
      expect(controller.diagnosticState(SERVER.id).pendingFullRefreshTransactionId).toBeUndefined();
      expect(connections.createDedicatedClient).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
      controller.dispose();
    }
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
    await vi.waitFor(() => expect(createDedicatedClient).toHaveBeenCalledOnce());

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
    const provisioning = new FakeClient();
    const provisionedListener = new FakeClient(true);
    const provisioningRefresh = new FakeClient();
    const firstConnections = connectionsWithClients([
      notProvisioned,
      provisioning,
      provisionedListener,
      provisioningRefresh,
    ]);
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
    await first.provision(SERVER.id);
    expect(first.state(SERVER.id).status).toBe("listening");
    expect(firstIndex.value.synchronizeActiveDatabaseDdl).toHaveBeenCalledOnce();
    expect(firstIndex.value.synchronizeActiveDatabaseDdl.mock.calls[0]?.[3]).toBe(
      "listener reconnected after a notification gap",
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

  it("forgets provisioning state when a connection is removed and recreated with the same id", async () => {
    const notProvisioned = new FakeClient();
    const recreatedListener = new FakeClient(true, 4_001);
    const refresh = new FakeClient(false, 4_002);
    const clients = [notProvisioned, recreatedListener, refresh];
    let server: ServerConfig | undefined = {
      ...SERVER,
      schemaSync: { ...SERVER.schemaSync },
    };
    const connectionListeners = new Set<() => void>();
    const createDedicatedClient = vi.fn(async () => clients.shift() as unknown as Client);
    const connections = {
      get servers() {
        return server ? [server] : [];
      },
      store: { get: (serverId: string) => (serverId === SERVER.id ? server : undefined) },
      onChanged(callback: () => void): vscode.Disposable {
        connectionListeners.add(callback);
        return { dispose: () => connectionListeners.delete(callback) };
      },
      createDedicatedClient,
      isActiveServer: (serverId: string) => serverId === SERVER.id,
    };
    const index = indexStub();
    const controller = new WorkbenchDdlSyncController(
      connections as unknown as ConnectionManager,
      index.value as unknown as WorkbenchIndexController,
      { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    );

    await vi.waitFor(() =>
      expect(controller.state(SERVER.id).status).toBe("provisioning-required"),
    );
    expect(createDedicatedClient).toHaveBeenCalledOnce();

    server = undefined;
    for (const changed of connectionListeners) changed();
    await vi.waitFor(() =>
      expect(controller.diagnosticState(SERVER.id)).toMatchObject({
        desired: undefined,
        state: { status: "disabled" },
        fullRefreshDebtEpoch: undefined,
      }),
    );

    server = { ...SERVER, schemaSync: { ...SERVER.schemaSync } };
    for (const changed of connectionListeners) changed();
    await vi.waitFor(() => expect(controller.state(SERVER.id).status).toBe("listening"));

    expect(createDedicatedClient).toHaveBeenCalledTimes(3);
    expect(recreatedListener.queries.at(-1)).toBe("LISTEN plpgsql_workbench_ddl");
    expect(index.value.synchronizeActiveDatabaseDdl).toHaveBeenCalledOnce();
    expect(index.value.synchronizeActiveDatabaseDdl.mock.calls[0]?.[3]).toBe(
      "listener connected while index freshness was unknown",
    );
    expect(controller.diagnosticState(SERVER.id)).toMatchObject({
      state: { status: "listening" },
      listener: { processId: 4_001 },
    });
    controller.dispose();
  });

  it("forces a full refresh when a listening connection is removed and recreated", async () => {
    const listenerClosed = deferred<void>();
    const firstListener = new FakeClient(true, 5_001);
    firstListener.end.mockImplementation(async () => listenerClosed.promise);
    const recreatedListener = new FakeClient(true, 5_002);
    const refresh = new FakeClient(false, 5_003);
    const clients = [firstListener, recreatedListener, refresh];
    let server: ServerConfig | undefined = {
      ...SERVER,
      schemaSync: { ...SERVER.schemaSync },
    };
    const connectionListeners = new Set<() => void>();
    const createDedicatedClient = vi.fn(async () => clients.shift() as unknown as Client);
    const connections = {
      get servers() {
        return server ? [server] : [];
      },
      store: { get: (serverId: string) => (serverId === SERVER.id ? server : undefined) },
      onChanged(callback: () => void): vscode.Disposable {
        connectionListeners.add(callback);
        return { dispose: () => connectionListeners.delete(callback) };
      },
      createDedicatedClient,
      isActiveServer: (serverId: string) => serverId === SERVER.id,
    };
    const index = indexStub();
    const controller = new WorkbenchDdlSyncController(
      connections as unknown as ConnectionManager,
      index.value as unknown as WorkbenchIndexController,
      { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    );

    await vi.waitFor(() => expect(controller.state(SERVER.id).status).toBe("listening"));
    expect(index.value.synchronizeActiveDatabaseDdl).not.toHaveBeenCalled();

    server = undefined;
    for (const changed of connectionListeners) changed();
    await vi.waitFor(() => expect(firstListener.end).toHaveBeenCalledOnce());
    server = { ...SERVER, schemaSync: { ...SERVER.schemaSync } };
    for (const changed of connectionListeners) changed();
    expect(index.markDatabaseStale).toHaveBeenCalledWith(
      SERVER.id,
      SERVER.database,
      "PostgreSQL connection removed; schema notifications may have been missed",
    );
    listenerClosed.resolve();
    await vi.waitFor(() => expect(createDedicatedClient).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(controller.diagnosticState(SERVER.id)).toMatchObject({
        state: { status: "listening" },
        listener: { processId: 5_002 },
      }),
    );

    expect(recreatedListener.queries.at(-1)).toBe("LISTEN plpgsql_workbench_ddl");
    expect(index.value.synchronizeActiveDatabaseDdl).toHaveBeenCalledOnce();
    expect(index.value.synchronizeActiveDatabaseDdl.mock.calls[0]?.[3]).toBe(
      "listener connected while index freshness was unknown",
    );
    controller.dispose();
  });

  it("refreshes before the first LISTEN after enabling a previously disabled connection", async () => {
    const listener = new FakeClient(true, 6_001);
    const refresh = new FakeClient(false, 6_002);
    const clients = [listener, refresh];
    let server: ServerConfig = {
      ...SERVER,
      schemaSync: { enabled: false, supportSchema: "workbench" },
    };
    const connectionListeners = new Set<() => void>();
    const setSchemaSyncOverride = vi.fn(
      async (_serverId: string, schemaSync: ServerConfig["schemaSync"]) => {
        server = { ...server, schemaSync };
        for (const changed of connectionListeners) changed();
      },
    );
    const connections = {
      get servers() {
        return [server];
      },
      store: { get: (serverId: string) => (serverId === SERVER.id ? server : undefined) },
      onChanged(callback: () => void): vscode.Disposable {
        connectionListeners.add(callback);
        return { dispose: () => connectionListeners.delete(callback) };
      },
      setSchemaSyncOverride,
      createDedicatedClient: vi.fn(async () => clients.shift() as unknown as Client),
      isActiveServer: (serverId: string) => serverId === SERVER.id,
    };
    const index = indexStub();
    const controller = new WorkbenchDdlSyncController(
      connections as unknown as ConnectionManager,
      index.value as unknown as WorkbenchIndexController,
      { appendLine: vi.fn() } as unknown as vscode.OutputChannel,
    );
    await vi.waitFor(() => expect(controller.state(SERVER.id).status).toBe("disabled"));

    await controller.setConnectionEnabled(SERVER.id, true);

    expect(controller.state(SERVER.id).status).toBe("listening");
    expect(listener.queries.at(-1)).toBe("LISTEN plpgsql_workbench_ddl");
    expect(index.value.synchronizeActiveDatabaseDdl).toHaveBeenCalledOnce();
    expect(index.value.synchronizeActiveDatabaseDdl.mock.calls[0]?.[3]).toBe(
      "listener reconnected after a notification gap",
    );
    expect(setSchemaSyncOverride).toHaveBeenCalledWith(
      SERVER.id,
      expect.objectContaining({ enabled: true }),
    );
    controller.dispose();
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
  const synchronizeActiveDatabaseDdl = vi.fn(
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
  return {
    markDatabaseStale,
    value: {
      markDatabaseStale,
      isDatabaseStale: () => stale,
      synchronizeActiveDatabaseDdl,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function drainMicrotasks(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}
