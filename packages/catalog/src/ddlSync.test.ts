import type { Client } from "pg";
import { describe, expect, it, vi } from "vitest";

/** The Schema Sync settings and log a test controller runs with. */
function testHost() {
  return {
    log: vi.fn(),
    settings: () => ({ enabled: true, supportSchema: "workbench" }),
    onSettingsChanged: () => ({ dispose: () => {} }),
  };
}

import {
  type DdlSyncConnections,
  type DdlSyncIndex,
  WorkbenchDdlSyncController,
} from "./ddlSync.js";
import type { ConnectionConfig } from "./savedConnection.js";

/** The change the Connections publish; only the two fields the listener reads. */
type ConnectionChange = {
  connectionIds: readonly string[];
  rootsChanged?: boolean;
  debugCapabilityOnly?: boolean;
};

const CONNECTION: ConnectionConfig = {
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
  it("reconciles only the Connection named by a connection event", async () => {
    const connectionA = {
      ...CONNECTION,
      id: "connection-a",
      database: "a",
      schemaSync: { enabled: false },
    };
    const connectionB = {
      ...CONNECTION,
      id: "connection-b",
      database: "b",
      schemaSync: { enabled: false },
    };
    const listeners = new Set<(change: ConnectionChange) => void>();
    const connections = {
      connections: [connectionA, connectionB],
      store: {
        get: (connectionId: string) =>
          [connectionA, connectionB].find((connection) => connection.id === connectionId),
      },
      isConnectionConnected: () => false,
      onChanged: (listener: (change: ConnectionChange) => void) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    };
    const controller = new WorkbenchDdlSyncController(
      connections as unknown as DdlSyncConnections,
      indexStub().value as unknown as DdlSyncIndex,
      testHost(),
    );
    await drainMicrotasks();
    const beforeA = controller.diagnosticState(connectionA.id).lifecycle.epoch;
    const beforeB = controller.diagnosticState(connectionB.id).lifecycle.epoch;

    for (const listener of listeners) {
      listener({ connectionIds: [connectionA.id], rootsChanged: false });
    }
    await drainMicrotasks();

    expect(controller.diagnosticState(connectionA.id).lifecycle.epoch).toBeGreaterThan(beforeA);
    expect(controller.diagnosticState(connectionB.id).lifecycle.epoch).toBe(beforeB);

    const afterA = controller.diagnosticState(connectionA.id).lifecycle.epoch;
    for (const listener of listeners) {
      listener({ connectionIds: [connectionA.id], rootsChanged: false, debugCapabilityOnly: true });
    }
    await drainMicrotasks();
    expect(controller.diagnosticState(connectionA.id).lifecycle.epoch).toBe(afterA);
    controller.dispose();
  });

  it("buffers a DDL notification delivered while LISTEN is completing", async () => {
    vi.useFakeTimers();
    const listener = new NotifyingListenClient(true);
    const refresh = new FakeClient();
    const connections = connectionsWithClients([listener, refresh]);
    const index = indexStub();
    const controller = new WorkbenchDdlSyncController(
      connections.value as unknown as DdlSyncConnections,
      index.value as unknown as DdlSyncIndex,
      testHost(),
    );
    try {
      await drainMicrotasks(50);
      expect(controller.state(CONNECTION.id).status).toBe("listening");
      expect(index.markDatabaseStale).toHaveBeenCalledWith(
        CONNECTION.id,
        CONNECTION.database,
        "PostgreSQL schema changed in transaction 100",
      );
      expect(controller.diagnosticState(CONNECTION.id).listener?.queuedNotifications).toBe(1);
      expect(index.value.synchronizeDatabaseDdl).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);
      await drainMicrotasks();
      expect(index.value.synchronizeDatabaseDdl).toHaveBeenCalledOnce();
      expect(index.value.synchronizeDatabaseDdl.mock.calls[0]?.[2]).toHaveLength(1);
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
      connections.value as unknown as DdlSyncConnections,
      index.value as unknown as DdlSyncIndex,
      testHost(),
    );

    await vi.waitFor(() => expect(listener.end).toHaveBeenCalledOnce());
    expect(controller.state(CONNECTION.id).status).toBe("unavailable");
    expect(index.markDatabaseStale).toHaveBeenCalledWith(
      CONNECTION.id,
      CONNECTION.database,
      "Schema synchronization listener is unavailable",
    );
    controller.dispose();
  });

  it("listens with a dedicated client and coalesces DDL into an incremental refresh", async () => {
    const listener = new FakeClient(true);
    const refresh = new FakeClient();
    const connectionListeners = new Set<
      (change: { connectionIds: string[]; rootsChanged: boolean }) => void
    >();
    const clients = [listener, refresh];
    const connections = {
      connections: [CONNECTION],
      store: {
        get: (connectionId: string) => (connectionId === CONNECTION.id ? CONNECTION : undefined),
      },
      onChanged(callback: (change: { connectionIds: string[]; rootsChanged: boolean }) => void) {
        connectionListeners.add(callback);
        return { dispose: () => connectionListeners.delete(callback) };
      },
      createDedicatedClient: vi.fn(async () => clients.shift() as unknown as Client),
    };
    let stale = false;
    const synchronize = vi.fn(
      async (
        _client: unknown,
        _identity: { connectionId: string; database: string },
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
      synchronizeDatabaseDdl: synchronize,
    };
    const appendLine = vi.fn();
    const controller = new WorkbenchDdlSyncController(
      connections as unknown as DdlSyncConnections,
      index as unknown as DdlSyncIndex,
      { ...testHost(), log: appendLine },
    );

    await vi.waitFor(() => expect(controller.state(CONNECTION.id).status).toBe("listening"));
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
      CONNECTION.id,
      CONNECTION.database,
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
    expect(controller.diagnosticState(CONNECTION.id)).toMatchObject({
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
    let connection: ConnectionConfig = { ...CONNECTION, schemaSync: { ...CONNECTION.schemaSync } };
    const connectionListeners = new Set<
      (change: { connectionIds: string[]; rootsChanged: boolean }) => void
    >();
    const connections = {
      get connections() {
        return [connection];
      },
      store: {
        get: (connectionId: string) => (connectionId === connection.id ? connection : undefined),
      },
      onChanged(callback: (change: { connectionIds: string[]; rootsChanged: boolean }) => void) {
        connectionListeners.add(callback);
        return { dispose: () => connectionListeners.delete(callback) };
      },
      createDedicatedClient: vi.fn(async () => clients.shift() as unknown as Client),
    };
    const index = indexStub();
    const controller = new WorkbenchDdlSyncController(
      connections as unknown as DdlSyncConnections,
      index.value as unknown as DdlSyncIndex,
      testHost(),
    );
    await vi.waitFor(() => expect(controller.state(CONNECTION.id).status).toBe("listening"));

    connection = { ...connection, schemaSync: { enabled: false, supportSchema: "workbench" } };
    for (const changed of connectionListeners)
      changed({ connectionIds: [CONNECTION.id], rootsChanged: false });
    await vi.waitFor(() => expect(controller.state(CONNECTION.id).status).toBe("disabled"));
    expect(firstListener.end).toHaveBeenCalledOnce();

    connection = { ...connection, schemaSync: { enabled: true, supportSchema: "workbench" } };
    for (const changed of connectionListeners)
      changed({ connectionIds: [CONNECTION.id], rootsChanged: false });
    await vi.waitFor(() => expect(controller.state(CONNECTION.id).status).toBe("listening"));
    expect(secondListener.queries.at(-1)).toBe("LISTEN plpgsql_workbench_ddl");
    expect(secondListener.queries.some((query) => query.includes("CREATE EVENT TRIGGER"))).toBe(
      false,
    );
    expect(index.value.synchronizeDatabaseDdl).toHaveBeenCalledOnce();
    expect(index.value.synchronizeDatabaseDdl.mock.calls[0]?.[3]).toBe(
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
    let connection: ConnectionConfig = { ...CONNECTION, schemaSync: { ...CONNECTION.schemaSync } };
    const connectionListeners = new Set<
      (change: { connectionIds: string[]; rootsChanged: boolean }) => void
    >();
    const setSchemaSyncOverride = vi.fn(
      async (_connectionId: string, schemaSync: ConnectionConfig["schemaSync"]) => {
        connection = { ...connection, schemaSync };
        for (const changed of connectionListeners)
          changed({ connectionIds: [CONNECTION.id], rootsChanged: false });
      },
    );
    const connections = {
      get connections() {
        return [connection];
      },
      store: {
        get: (connectionId: string) => (connectionId === connection.id ? connection : undefined),
      },
      onChanged(callback: (change: { connectionIds: string[]; rootsChanged: boolean }) => void) {
        connectionListeners.add(callback);
        return { dispose: () => connectionListeners.delete(callback) };
      },
      setSchemaSyncOverride,
      createDedicatedClient: vi.fn(async () => clients.shift() as unknown as Client),
    };
    const index = indexStub();
    const controller = new WorkbenchDdlSyncController(
      connections as unknown as DdlSyncConnections,
      index.value as unknown as DdlSyncIndex,
      testHost(),
    );
    await vi.waitFor(() => expect(controller.state(CONNECTION.id).status).toBe("listening"));

    const disabling = controller.setConnectionEnabled(CONNECTION.id, false);
    await vi.waitFor(() => expect(firstListener.end).toHaveBeenCalledOnce());
    const enabling = controller.setConnectionEnabled(CONNECTION.id, true);
    expect(setSchemaSyncOverride).not.toHaveBeenCalled();
    expect(connection.schemaSync?.enabled).toBe(true);
    expect(controller.diagnosticState(CONNECTION.id).lifecycle).toMatchObject({
      active: true,
      queued: 1,
    });

    listenerClosed.resolve();
    await Promise.all([disabling, enabling]);

    await vi.waitFor(() => expect(controller.state(CONNECTION.id).status).toBe("listening"));
    expect(secondListener.queries.at(-1)).toBe("LISTEN plpgsql_workbench_ddl");
    expect(setSchemaSyncOverride.mock.calls.map((call) => call[1]?.enabled)).toEqual([false, true]);
    expect(firstListener.end).toHaveBeenCalledOnce();
    expect(secondListener.end).not.toHaveBeenCalled();
    expect(index.value.synchronizeDatabaseDdl).toHaveBeenCalledOnce();
    expect(controller.diagnosticState(CONNECTION.id)).toMatchObject({
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
    let connection: ConnectionConfig = { ...CONNECTION, schemaSync: { ...CONNECTION.schemaSync } };
    const connectionListeners = new Set<
      (change: { connectionIds: string[]; rootsChanged: boolean }) => void
    >();
    const setSchemaSyncOverride = vi.fn(
      async (_connectionId: string, schemaSync: ConnectionConfig["schemaSync"]) => {
        connection = { ...connection, schemaSync };
        for (const changed of connectionListeners)
          changed({ connectionIds: [CONNECTION.id], rootsChanged: false });
      },
    );
    const connections = {
      get connections() {
        return [connection];
      },
      store: {
        get: (connectionId: string) => (connectionId === connection.id ? connection : undefined),
      },
      onChanged(callback: (change: { connectionIds: string[]; rootsChanged: boolean }) => void) {
        connectionListeners.add(callback);
        return { dispose: () => connectionListeners.delete(callback) };
      },
      setSchemaSyncOverride,
      createDedicatedClient: vi.fn(async () => clients.shift() as unknown as Client),
    };
    const index = indexStub();
    const controller = new WorkbenchDdlSyncController(
      connections as unknown as DdlSyncConnections,
      index.value as unknown as DdlSyncIndex,
      testHost(),
    );
    await firstListener.listenStarted.promise;

    const disabling = controller.setConnectionEnabled(CONNECTION.id, false);
    const enabling = controller.setConnectionEnabled(CONNECTION.id, true);
    expect(controller.diagnosticState(CONNECTION.id).lifecycle).toMatchObject({
      active: true,
      queued: 2,
    });

    firstListener.releaseListen.resolve();
    await Promise.all([disabling, enabling]);
    await vi.waitFor(() => expect(controller.state(CONNECTION.id).status).toBe("listening"));

    expect(firstListener.end).toHaveBeenCalledOnce();
    expect(secondListener.queries.at(-1)).toBe("LISTEN plpgsql_workbench_ddl");
    expect(secondListener.end).not.toHaveBeenCalled();
    expect(connections.createDedicatedClient).toHaveBeenCalledTimes(3);
    expect(index.value.synchronizeDatabaseDdl).toHaveBeenCalledOnce();
    expect(controller.diagnosticState(CONNECTION.id)).toMatchObject({
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
        _identity: { connectionId: string; database: string },
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
      synchronizeDatabaseDdl: synchronize,
    };
    const controller = new WorkbenchDdlSyncController(
      connections.value as unknown as DdlSyncConnections,
      index as unknown as DdlSyncIndex,
      testHost(),
    );
    await vi.waitFor(() => expect(controller.state(CONNECTION.id).status).toBe("listening"));

    listener.emit("notification", {
      channel: "plpgsql_workbench_ddl",
      payload: "not-json",
    });
    expect(controller.state(CONNECTION.id).status).toBe("desynchronized");
    listener.emit("notification", {
      channel: "plpgsql_workbench_ddl",
      payload: ddlPayload("102"),
    });

    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledOnce());
    expect(synchronize.mock.calls[0]?.[3]).toBe(
      "schema listener missed or rejected a DDL notification",
    );
    expect(controller.state(CONNECTION.id).status).toBe("listening");
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
        _identity: { connectionId: string; database: string },
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
      synchronizeDatabaseDdl: synchronize,
    };
    const controller = new WorkbenchDdlSyncController(
      connections.value as unknown as DdlSyncConnections,
      index as unknown as DdlSyncIndex,
      testHost(),
    );
    await vi.waitFor(() => expect(controller.state(CONNECTION.id).status).toBe("listening"));

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
      expect(controller.diagnosticState(CONNECTION.id).fullRefreshDebtEpoch).toBe(1);

      firstListener.emit("error", new Error("listener connection lost"));
      await drainMicrotasks();
      expect(firstListener.end).toHaveBeenCalledOnce();
      expect(controller.diagnosticState(CONNECTION.id)).toMatchObject({
        state: { status: "desynchronized" },
        lifecycle: { reconnectScheduled: true },
        fullRefreshDebtEpoch: 2,
      });

      firstRefresh.resolve({ generation: 2 });
      await drainMicrotasks();
      expect(controller.diagnosticState(CONNECTION.id).fullRefreshDebtEpoch).toBe(2);
      expect(index.isDatabaseStale()).toBe(true);

      await vi.advanceTimersByTimeAsync(2_000);
      await drainMicrotasks();
      expect(synchronize).toHaveBeenCalledTimes(2);
      expect(synchronize.mock.calls[1]?.[3]).toBe("listener reconnected after a notification gap");
      expect(controller.diagnosticState(CONNECTION.id)).toMatchObject({
        state: { status: "listening" },
        listener: { processId: 3_003 },
        lifecycle: { reconnectScheduled: false },
        refresh: { active: false, queued: 0 },
      });
      expect(controller.diagnosticState(CONNECTION.id).fullRefreshDebtEpoch).toBeUndefined();
      expect(index.isDatabaseStale()).toBe(false);
      expect(connections.value.createDedicatedClient).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
      controller.dispose();
    }
  });

  it("refreshes DDL for its exact Connection without a global context gate", async () => {
    const listener = new FakeClient(true, 4_001);
    const connections = {
      connections: [CONNECTION],
      store: {
        get: (connectionId: string) => (connectionId === CONNECTION.id ? CONNECTION : undefined),
      },
      onChanged: () => ({ dispose: vi.fn() }),
      createDedicatedClient: vi.fn(async () => listener as unknown as Client),
    };
    let stale = false;
    const synchronize = vi.fn(
      async (
        _client: unknown,
        _identity: { connectionId: string; database: string },
        _objects: readonly unknown[],
        _fallbackReason?: string,
      ) => {
        stale = false;
        return { generation: 2 };
      },
    );
    const index = {
      markDatabaseStale: vi.fn(() => {
        stale = true;
      }),
      isDatabaseStale: () => stale,
      synchronizeDatabaseDdl: synchronize,
    };
    const controller = new WorkbenchDdlSyncController(
      connections as unknown as DdlSyncConnections,
      index as unknown as DdlSyncIndex,
      testHost(),
    );
    await vi.waitFor(() => expect(controller.state(CONNECTION.id).status).toBe("listening"));

    listener.emit("notification", {
      channel: "plpgsql_workbench_ddl",
      payload: ddlPayload("201"),
    });
    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledOnce());
    expect(synchronize.mock.calls[0]?.[2]).toMatchObject([
      { commandTag: "ALTER TABLE", objectIdentity: "app.account" },
    ]);
    expect(synchronize.mock.calls[0]?.[3]).toBeUndefined();
    await vi.waitFor(() =>
      expect(controller.diagnosticState(CONNECTION.id)).toMatchObject({
        state: { status: "listening" },
        listener: { processId: 4_001 },
        lastReceivedTransactionId: "201",
        lastCompletedTransactionId: "201",
      }),
    );
    expect(stale).toBe(false);
    controller.dispose();
  });

  it("deduplicates concurrent starts and cannot leave a listener after opt-out", async () => {
    const listener = new FakeClient(true);
    let resolveClient: ((client: Client) => void) | undefined;
    const pendingClient = new Promise<Client>((resolve) => {
      resolveClient = resolve;
    });
    let connection: ConnectionConfig = { ...CONNECTION, schemaSync: { ...CONNECTION.schemaSync } };
    const connectionListeners = new Set<
      (change: { connectionIds: string[]; rootsChanged: boolean }) => void
    >();
    const createDedicatedClient = vi.fn(() => pendingClient);
    const connections = {
      get connections() {
        return [connection];
      },
      store: {
        get: (connectionId: string) => (connectionId === connection.id ? connection : undefined),
      },
      onChanged(callback: (change: { connectionIds: string[]; rootsChanged: boolean }) => void) {
        connectionListeners.add(callback);
        return { dispose: () => connectionListeners.delete(callback) };
      },
      createDedicatedClient,
    };
    const index = indexStub();
    const controller = new WorkbenchDdlSyncController(
      connections as unknown as DdlSyncConnections,
      index.value as unknown as DdlSyncIndex,
      testHost(),
    );
    for (const changed of connectionListeners)
      changed({ connectionIds: [CONNECTION.id], rootsChanged: false });
    for (const changed of connectionListeners)
      changed({ connectionIds: [CONNECTION.id], rootsChanged: false });
    await vi.waitFor(() => expect(createDedicatedClient).toHaveBeenCalledOnce());

    connection = { ...connection, schemaSync: { enabled: false, supportSchema: "workbench" } };
    for (const changed of connectionListeners)
      changed({ connectionIds: [CONNECTION.id], rootsChanged: false });
    resolveClient!(listener as unknown as Client);

    await vi.waitFor(() => expect(listener.end).toHaveBeenCalledOnce());
    expect(listener.queries).not.toContain("LISTEN plpgsql_workbench_ddl");
    expect(controller.state(CONNECTION.id).status).toBe("disabled");
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
      firstConnections.value as unknown as DdlSyncConnections,
      firstIndex.value as unknown as DdlSyncIndex,
      testHost(),
    );
    await vi.waitFor(() => expect(first.state(CONNECTION.id).status).toBe("provisioning-required"));
    expect(firstIndex.markDatabaseStale).toHaveBeenCalledWith(
      CONNECTION.id,
      CONNECTION.database,
      "Schema synchronization requires explicit database provisioning",
    );
    await first.provision(CONNECTION.id);
    expect(first.state(CONNECTION.id).status).toBe("listening");
    expect(firstIndex.value.synchronizeDatabaseDdl).toHaveBeenCalledOnce();
    expect(firstIndex.value.synchronizeDatabaseDdl.mock.calls[0]?.[3]).toBe(
      "listener reconnected after a notification gap",
    );
    first.dispose();

    const listener = new FakeClient(true);
    const removal = new FailingClient();
    const secondConnections = connectionsWithClients([listener, removal]);
    const secondIndex = indexStub();
    const second = new WorkbenchDdlSyncController(
      secondConnections.value as unknown as DdlSyncConnections,
      secondIndex.value as unknown as DdlSyncIndex,
      testHost(),
    );
    await vi.waitFor(() => expect(second.state(CONNECTION.id).status).toBe("listening"));

    await expect(second.removeProvisioning(CONNECTION.id)).rejects.toThrow("database unavailable");
    expect(listener.end).toHaveBeenCalledOnce();
    expect(second.state(CONNECTION.id).status).toBe("unavailable");
    expect(secondIndex.markDatabaseStale).toHaveBeenCalledWith(
      CONNECTION.id,
      CONNECTION.database,
      "Schema synchronization removal failed after the listener stopped",
    );
    second.dispose();
  });

  it("forgets provisioning state when a connection is removed and recreated with the same id", async () => {
    const notProvisioned = new FakeClient();
    const recreatedListener = new FakeClient(true, 4_001);
    const refresh = new FakeClient(false, 4_002);
    const clients = [notProvisioned, recreatedListener, refresh];
    let connection: ConnectionConfig | undefined = {
      ...CONNECTION,
      schemaSync: { ...CONNECTION.schemaSync },
    };
    const connectionListeners = new Set<
      (change: { connectionIds: string[]; rootsChanged: boolean }) => void
    >();
    const createDedicatedClient = vi.fn(async () => clients.shift() as unknown as Client);
    const connections = {
      get connections() {
        return connection ? [connection] : [];
      },
      store: {
        get: (connectionId: string) => (connectionId === CONNECTION.id ? connection : undefined),
      },
      onChanged(callback: (change: { connectionIds: string[]; rootsChanged: boolean }) => void) {
        connectionListeners.add(callback);
        return { dispose: () => connectionListeners.delete(callback) };
      },
      createDedicatedClient,
    };
    const index = indexStub();
    const controller = new WorkbenchDdlSyncController(
      connections as unknown as DdlSyncConnections,
      index.value as unknown as DdlSyncIndex,
      testHost(),
    );

    await vi.waitFor(() =>
      expect(controller.state(CONNECTION.id).status).toBe("provisioning-required"),
    );
    expect(createDedicatedClient).toHaveBeenCalledOnce();

    connection = undefined;
    for (const changed of connectionListeners)
      changed({ connectionIds: [CONNECTION.id], rootsChanged: false });
    await vi.waitFor(() =>
      expect(controller.diagnosticState(CONNECTION.id)).toMatchObject({
        desired: undefined,
        state: { status: "disabled" },
        fullRefreshDebtEpoch: undefined,
      }),
    );

    connection = { ...CONNECTION, schemaSync: { ...CONNECTION.schemaSync } };
    for (const changed of connectionListeners)
      changed({ connectionIds: [CONNECTION.id], rootsChanged: false });
    await vi.waitFor(() => expect(controller.state(CONNECTION.id).status).toBe("listening"));

    expect(createDedicatedClient).toHaveBeenCalledTimes(3);
    expect(recreatedListener.queries.at(-1)).toBe("LISTEN plpgsql_workbench_ddl");
    expect(index.value.synchronizeDatabaseDdl).toHaveBeenCalledOnce();
    expect(index.value.synchronizeDatabaseDdl.mock.calls[0]?.[3]).toBe(
      "listener connected while index freshness was unknown",
    );
    expect(controller.diagnosticState(CONNECTION.id)).toMatchObject({
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
    let connection: ConnectionConfig | undefined = {
      ...CONNECTION,
      schemaSync: { ...CONNECTION.schemaSync },
    };
    const connectionListeners = new Set<
      (change: { connectionIds: string[]; rootsChanged: boolean }) => void
    >();
    const createDedicatedClient = vi.fn(async () => clients.shift() as unknown as Client);
    const connections = {
      get connections() {
        return connection ? [connection] : [];
      },
      store: {
        get: (connectionId: string) => (connectionId === CONNECTION.id ? connection : undefined),
      },
      onChanged(callback: (change: { connectionIds: string[]; rootsChanged: boolean }) => void) {
        connectionListeners.add(callback);
        return { dispose: () => connectionListeners.delete(callback) };
      },
      createDedicatedClient,
    };
    const index = indexStub();
    const controller = new WorkbenchDdlSyncController(
      connections as unknown as DdlSyncConnections,
      index.value as unknown as DdlSyncIndex,
      testHost(),
    );

    await vi.waitFor(() => expect(controller.state(CONNECTION.id).status).toBe("listening"));
    expect(index.value.synchronizeDatabaseDdl).not.toHaveBeenCalled();

    connection = undefined;
    for (const changed of connectionListeners)
      changed({ connectionIds: [CONNECTION.id], rootsChanged: false });
    await vi.waitFor(() => expect(firstListener.end).toHaveBeenCalledOnce());
    connection = { ...CONNECTION, schemaSync: { ...CONNECTION.schemaSync } };
    for (const changed of connectionListeners)
      changed({ connectionIds: [CONNECTION.id], rootsChanged: false });
    expect(index.markDatabaseStale).toHaveBeenCalledWith(
      CONNECTION.id,
      CONNECTION.database,
      "PostgreSQL connection removed; schema notifications may have been missed",
    );
    listenerClosed.resolve();
    await vi.waitFor(() => expect(createDedicatedClient).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(controller.diagnosticState(CONNECTION.id)).toMatchObject({
        state: { status: "listening" },
        listener: { processId: 5_002 },
      }),
    );

    expect(recreatedListener.queries.at(-1)).toBe("LISTEN plpgsql_workbench_ddl");
    expect(index.value.synchronizeDatabaseDdl).toHaveBeenCalledOnce();
    expect(index.value.synchronizeDatabaseDdl.mock.calls[0]?.[3]).toBe(
      "listener connected while index freshness was unknown",
    );
    controller.dispose();
  });

  it("refreshes before the first LISTEN after enabling a previously disabled connection", async () => {
    const listener = new FakeClient(true, 6_001);
    const refresh = new FakeClient(false, 6_002);
    const clients = [listener, refresh];
    let connection: ConnectionConfig = {
      ...CONNECTION,
      schemaSync: { enabled: false, supportSchema: "workbench" },
    };
    const connectionListeners = new Set<
      (change: { connectionIds: string[]; rootsChanged: boolean }) => void
    >();
    const setSchemaSyncOverride = vi.fn(
      async (_connectionId: string, schemaSync: ConnectionConfig["schemaSync"]) => {
        connection = { ...connection, schemaSync };
        for (const changed of connectionListeners)
          changed({ connectionIds: [CONNECTION.id], rootsChanged: false });
      },
    );
    const connections = {
      get connections() {
        return [connection];
      },
      store: {
        get: (connectionId: string) => (connectionId === CONNECTION.id ? connection : undefined),
      },
      onChanged(callback: (change: { connectionIds: string[]; rootsChanged: boolean }) => void) {
        connectionListeners.add(callback);
        return { dispose: () => connectionListeners.delete(callback) };
      },
      setSchemaSyncOverride,
      createDedicatedClient: vi.fn(async () => clients.shift() as unknown as Client),
    };
    const index = indexStub();
    const controller = new WorkbenchDdlSyncController(
      connections as unknown as DdlSyncConnections,
      index.value as unknown as DdlSyncIndex,
      testHost(),
    );
    await vi.waitFor(() => expect(controller.state(CONNECTION.id).status).toBe("disabled"));

    await controller.setConnectionEnabled(CONNECTION.id, true);

    expect(controller.state(CONNECTION.id).status).toBe("listening");
    expect(listener.queries.at(-1)).toBe("LISTEN plpgsql_workbench_ddl");
    expect(index.value.synchronizeDatabaseDdl).toHaveBeenCalledOnce();
    expect(index.value.synchronizeDatabaseDdl.mock.calls[0]?.[3]).toBe(
      "listener reconnected after a notification gap",
    );
    expect(setSchemaSyncOverride).toHaveBeenCalledWith(
      CONNECTION.id,
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
  const connectionListeners = new Set<
    (change: { connectionIds: string[]; rootsChanged: boolean }) => void
  >();
  return {
    value: {
      connections: [CONNECTION],
      store: {
        get: (connectionId: string) => (connectionId === CONNECTION.id ? CONNECTION : undefined),
      },
      onChanged(callback: (change: { connectionIds: string[]; rootsChanged: boolean }) => void) {
        connectionListeners.add(callback);
        return { dispose: () => connectionListeners.delete(callback) };
      },
      createDedicatedClient: vi.fn(async () => clients.shift() as unknown as Client),
    },
  };
}

function indexStub() {
  let stale = false;
  const markDatabaseStale = vi.fn(() => {
    stale = true;
  });
  const synchronizeDatabaseDdl = vi.fn(
    async (
      _client: unknown,
      _identity: { connectionId: string; database: string },
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
      synchronizeDatabaseDdl,
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
