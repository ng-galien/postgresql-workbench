import { describe, expect, it, vi } from "vitest";
import {
  buildRoutineArgs,
  buildRoutineTarget,
  configNameFromRoutine,
  type DebugConfigConnectionManager,
  type DebugConfigLogger,
  type DebugConfigUi,
  type DebugConfigurationLike,
  type DebugLaunchConnection,
  resolveDebugConfiguration,
  type SqlTargetParser,
} from "./launchConfiguration.js";

const noSqlTarget: SqlTargetParser = async () => ({
  schema: null,
  routine: null,
  args: [],
  kind: null,
});

function makeConnection(overrides: Partial<DebugLaunchConnection> = {}): DebugLaunchConnection {
  return {
    id: "localhost:5432/testdb:postgres",
    host: "localhost",
    port: 5432,
    database: "testdb",
    user: "postgres",
    ...overrides,
  };
}

function makeManager(
  connection: DebugLaunchConnection | undefined,
  overrides: Partial<DebugConfigConnectionManager> = {},
): DebugConfigConnectionManager {
  return {
    connection: vi.fn((id: string) => (connection?.id === id ? connection : undefined)),
    connectedConnectionIds: connection ? [connection.id] : [],
    pickConnection: vi.fn(async () => undefined),
    describeConnection: vi.fn((id: string) => id),
    isConnectionConnected: vi.fn(() => Boolean(connection)),
    connectConnection: vi.fn(async () => true),
    refreshDebugCapability: vi.fn(async () => ({ available: true, error: "" })),
    getPassword: vi.fn(async () => "secret"),
    ...overrides,
  };
}

describe("debug launch configuration", () => {
  it("builds debug names from structured routine targets", () => {
    expect(
      configNameFromRoutine({
        schema: "public",
        name: "demo",
        kind: "function",
      }),
    ).toBe("Debug public.demo");
  });

  it("builds structured routine targets and args", () => {
    expect(
      buildRoutineTarget({
        schema: "public",
        name: "demo",
        params: [
          { name: "a", type: "integer", mode: "in" },
          { name: "b", type: "text", mode: "in" },
        ],
        line: 1,
        kind: "function",
      }),
    ).toEqual({
      schema: "public",
      name: "demo",
      kind: "function",
      argTypes: ["integer", "text"],
    });
    expect(buildRoutineArgs(["42", "NULL", "hello"])).toEqual([
      { value: "42" },
      { value: null },
      { value: "hello" },
    ]);
  });

  it("rejects configs without sql or routine", async () => {
    const ui: DebugConfigUi = { showErrorMessage: vi.fn() };
    const config: DebugConfigurationLike = {};

    const resolved = await resolveDebugConfiguration(
      config,
      makeManager(undefined),
      ui,
      noSqlTarget,
    );

    expect(resolved).toBeUndefined();
    expect(ui.showErrorMessage).toHaveBeenCalledOnce();
  });

  it("keeps inline connection configs untouched", async () => {
    const config: DebugConfigurationLike = {
      routine: {
        schema: "public",
        name: "test_simple",
        kind: "function",
        argTypes: ["integer", "text"],
      },
      routineArgs: [{ value: "1" }, { value: "x" }],
      host: "localhost",
      port: 5433,
      database: "testdb",
      user: "postgres",
      password: "postgres",
    };
    const ui: DebugConfigUi = { showErrorMessage: vi.fn() };
    const out: DebugConfigLogger = { appendLine: vi.fn() };
    const cm = makeManager(undefined, {
      pickConnection: vi.fn(async () => {
        throw new Error("should not pick");
      }),
    });

    const resolved = await resolveDebugConfiguration(config, cm, ui, noSqlTarget, out);

    expect(resolved).toBe(config);
    expect(cm.pickConnection).not.toHaveBeenCalled();
    expect(out.appendLine).toHaveBeenCalledWith(
      "resolveDebugConfiguration: inline connection localhost:5433/testdb",
    );
    expect(resolved?.stopOnEntry).toBe(true);
  });

  it("preserves an explicit run-to-breakpoint configuration", async () => {
    const config: DebugConfigurationLike = {
      sql: "SELECT test_simple(1, 'run')",
      stopOnEntry: false,
      host: "localhost",
      port: 5433,
      database: "testdb",
      user: "postgres",
      password: "postgres",
    };

    const resolved = await resolveDebugConfiguration(
      config,
      makeManager(undefined),
      { showErrorMessage: vi.fn() },
      noSqlTarget,
    );

    expect(resolved?.stopOnEntry).toBe(false);
  });

  it("keeps raw SQL launches usable without a host-side syntax parser", async () => {
    const resolved = await resolveDebugConfiguration(
      {
        sql: "SELECT test_simple(1, 'standalone')",
        host: "localhost",
        port: 5433,
        database: "testdb",
        user: "postgres",
        password: "postgres",
      },
      makeManager(undefined),
      { showErrorMessage: vi.fn() },
    );

    expect(resolved?.name).toBe("Debug PL/pgSQL");
  });

  it("resolves active connection credentials and connects if needed", async () => {
    const connection = makeConnection({ ssl: "require" });
    const ui: DebugConfigUi = { showErrorMessage: vi.fn() };
    const out: DebugConfigLogger = { appendLine: vi.fn() };
    const cm = makeManager(connection, {
      isConnectionConnected: vi.fn(() => false),
    });
    const config: DebugConfigurationLike = {
      routine: {
        schema: "public",
        name: "test_simple",
        kind: "function",
        argTypes: ["integer", "text"],
      },
      routineArgs: [{ value: "1" }, { value: "x" }],
    };

    const resolved = await resolveDebugConfiguration(config, cm, ui, noSqlTarget, out);

    expect(cm.connectConnection).toHaveBeenCalledWith(connection.id);
    expect(resolved).toMatchObject({
      type: "postgresql-workbench",
      request: "launch",
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.user,
      password: "secret",
      ssl: "require",
    });
  });

  it("picks a connection when no Connection is selected", async () => {
    const connection = makeConnection();
    const ui: DebugConfigUi = { showErrorMessage: vi.fn() };
    let connectedIds: readonly string[] = [];
    const pickedManager: DebugConfigConnectionManager = {
      ...makeManager(connection),
      get connectedConnectionIds() {
        return connectedIds;
      },
      pickConnection: vi.fn(async function (this: void) {
        connectedIds = [connection.id];
        return connection.id;
      }),
      isConnectionConnected: vi.fn(() => true),
    };
    const config: DebugConfigurationLike = {
      routine: {
        schema: "public",
        name: "test_simple",
        kind: "function",
        argTypes: ["integer"],
      },
      routineArgs: [{ value: "1" }],
    };

    const resolved = await resolveDebugConfiguration(config, pickedManager, ui, noSqlTarget);

    expect(pickedManager.pickConnection).toHaveBeenCalledOnce();
    expect(resolved?.host).toBe(connection.host);
  });

  it("uses the exact picked Connection when several Connections are already connected", async () => {
    const first = makeConnection({ id: "first", host: "first.example" });
    const second = makeConnection({ id: "second", host: "second.example" });
    const ui: DebugConfigUi = { showErrorMessage: vi.fn() };
    const connections = new Map([
      [first.id, first],
      [second.id, second],
    ]);
    const cm: DebugConfigConnectionManager = {
      ...makeManager(undefined),
      connection: vi.fn((id: string) => connections.get(id)),
      connectedConnectionIds: [first.id, second.id],
      pickConnection: vi.fn(async () => second.id),
      isConnectionConnected: vi.fn(() => true),
    };
    const config: DebugConfigurationLike = { sql: "SELECT public.test_simple(1)" };

    const resolved = await resolveDebugConfiguration(config, cm, ui, noSqlTarget);

    expect(cm.pickConnection).toHaveBeenCalledOnce();
    expect(resolved?.host).toBe(second.host);
    expect(resolved?.connection).toBe(second.id);
  });

  it("never falls back to another connection when the associated connection is gone", async () => {
    const other = makeConnection();
    const ui: DebugConfigUi = { showErrorMessage: vi.fn() };
    const cm = makeManager(other, {
      pickConnection: vi.fn(async () => other.id),
    });
    const config: DebugConfigurationLike = {
      connection: "missing-connection-id",
      sql: "SELECT public.test_simple(1)",
    };

    const resolved = await resolveDebugConfiguration(config, cm, ui, noSqlTarget);

    expect(resolved).toBeUndefined();
    expect(cm.pickConnection).not.toHaveBeenCalled();
    expect(ui.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("no longer exists"));
  });

  it("normalizes a persisted server target before considering any active Connection", async () => {
    const legacy = makeConnection({ id: "legacy", host: "legacy.example" });
    const active = makeConnection({ id: "active", host: "active.example" });
    const connections = new Map([
      [legacy.id, legacy],
      [active.id, active],
    ]);
    const ui: DebugConfigUi = { showErrorMessage: vi.fn() };
    const cm: DebugConfigConnectionManager = {
      ...makeManager(undefined),
      connection: vi.fn((id: string) => connections.get(id)),
      connectedConnectionIds: [active.id],
      pickConnection: vi.fn(async () => active.id),
      isConnectionConnected: vi.fn(() => true),
    };
    const config: DebugConfigurationLike = {
      server: legacy.id,
      sql: "SELECT public.test_simple(1)",
    };

    const resolved = await resolveDebugConfiguration(config, cm, ui, noSqlTarget);

    expect(resolved).toMatchObject({ connection: legacy.id, host: legacy.host });
    expect(resolved).not.toHaveProperty("server");
    expect(cm.pickConnection).not.toHaveBeenCalled();
  });

  it("aborts when connection fails", async () => {
    const connection = makeConnection();
    const ui: DebugConfigUi = { showErrorMessage: vi.fn() };
    const cm = makeManager(connection, {
      isConnectionConnected: vi.fn(() => false),
      connectConnection: vi.fn(async () => false),
    });

    const resolved = await resolveDebugConfiguration(
      {
        routine: {
          schema: "public",
          name: "test_simple",
          kind: "function",
          argTypes: ["integer", "text"],
        },
        routineArgs: [{ value: "1" }, { value: "x" }],
      },
      cm,
      ui,
      noSqlTarget,
    );

    expect(resolved).toBeUndefined();
    expect(cm.connectConnection).toHaveBeenCalledWith(connection.id);
  });

  it("rejects a debug launch before DAP startup when the exact Connection lacks pldbgapi", async () => {
    const connection = makeConnection();
    const ui: DebugConfigUi = { showErrorMessage: vi.fn() };
    const cm = makeManager(connection, {
      refreshDebugCapability: vi.fn(async () => ({
        available: false,
        error: 'pldbgapi extension not installed on "testdb".',
      })),
    });

    const resolved = await resolveDebugConfiguration(
      {
        sql: "SELECT public.test_simple(1, 'x')",
        connection: connection.id,
      },
      cm,
      ui,
      noSqlTarget,
    );

    expect(resolved).toBeUndefined();
    expect(cm.refreshDebugCapability).toHaveBeenCalledWith(connection.id);
    expect(ui.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("PL/pgSQL debugging is unavailable"),
    );
  });

  it("uses the explicitly associated Connection", async () => {
    const connection = makeConnection();
    const ui: DebugConfigUi = { showErrorMessage: vi.fn() };
    const cm = makeManager(connection, {
      isConnectionConnected: vi.fn(() => true),
      connectConnection: vi.fn(async () => {
        throw new Error("must not switch context");
      }),
    });

    const resolved = await resolveDebugConfiguration(
      {
        sql: "SELECT public.test_simple(1, 'x')",
        connection: connection.id,
      },
      cm,
      ui,
      noSqlTarget,
    );

    expect(cm.connectConnection).not.toHaveBeenCalled();
    expect(resolved).toMatchObject({
      host: connection.host,
      database: connection.database,
    });
  });
});
