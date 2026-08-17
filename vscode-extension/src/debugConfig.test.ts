import { describe, expect, it, vi } from "vitest";
import {
  buildRoutineArgs,
  buildRoutineTarget,
  configNameFromRoutine,
  type DebugConfigConnectionManager,
  type DebugConfigLogger,
  type DebugConfigUi,
  type DebugConfigurationLike,
  resolveDebugConfiguration,
  type SqlTargetParser,
} from "./debugConfig.js";
import type { ServerConfig } from "./serverStore.js";

const noSqlTarget: SqlTargetParser = async () => ({
  schema: null,
  routine: null,
  args: [],
  kind: null,
});

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: "localhost:5432/testdb:postgres",
    name: "postgres@localhost:5432/testdb",
    host: "localhost",
    port: 5432,
    database: "testdb",
    user: "postgres",
    ...overrides,
  };
}

function makeManager(
  server: ServerConfig | undefined,
  overrides: Partial<DebugConfigConnectionManager> = {},
): DebugConfigConnectionManager {
  return {
    activeServer: server,
    store: {
      get: vi.fn((id: string) => (server?.id === id ? server : undefined)),
    },
    commands: { pickConnection: vi.fn(async () => false) },
    isActiveServer: vi.fn(() => Boolean(server)),
    connectServer: vi.fn(async () => true),
    getPassword: vi.fn(async () => "secret"),
    ...overrides,
  };
}

describe("debugConfig", () => {
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
      commands: {
        pickConnection: vi.fn(async () => {
          throw new Error("should not pick");
        }),
      },
    });

    const resolved = await resolveDebugConfiguration(config, cm, ui, noSqlTarget, out);

    expect(resolved).toBe(config);
    expect(cm.commands.pickConnection).not.toHaveBeenCalled();
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

  it("resolves active server credentials and connects if needed", async () => {
    const server = makeServer({ ssl: "require" });
    const ui: DebugConfigUi = { showErrorMessage: vi.fn() };
    const out: DebugConfigLogger = { appendLine: vi.fn() };
    const cm = makeManager(server, {
      isActiveServer: vi.fn(() => false),
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

    expect(cm.connectServer).toHaveBeenCalledWith(server.id);
    expect(resolved).toMatchObject({
      type: "postgresql-workbench",
      request: "launch",
      host: server.host,
      port: server.port,
      database: server.database,
      user: server.user,
      password: "secret",
      ssl: "require",
    });
  });

  it("picks a server when none is active", async () => {
    const server = makeServer();
    const ui: DebugConfigUi = { showErrorMessage: vi.fn() };
    const cm = makeManager(undefined);
    const pickedManager: DebugConfigConnectionManager = {
      ...cm,
      activeServer: undefined,
      commands: {
        pickConnection: vi.fn(async function (this: void) {
          pickedManager.activeServer = server;
          return true;
        }),
      },
      isActiveServer: vi.fn(() => true),
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

    expect(pickedManager.commands.pickConnection).toHaveBeenCalledOnce();
    expect(resolved?.host).toBe(server.host);
  });

  it("never falls back to another connection when the associated server is gone", async () => {
    const other = makeServer();
    const ui: DebugConfigUi = { showErrorMessage: vi.fn() };
    const cm = makeManager(other, {
      commands: { pickConnection: vi.fn(async () => true) },
    });
    const config: DebugConfigurationLike = {
      server: "missing-server-id",
      sql: "SELECT public.test_simple(1)",
    };

    const resolved = await resolveDebugConfiguration(config, cm, ui, noSqlTarget);

    expect(resolved).toBeUndefined();
    expect(cm.commands.pickConnection).not.toHaveBeenCalled();
    expect(ui.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("no longer exists"));
  });

  it("aborts when connection fails", async () => {
    const server = makeServer();
    const ui: DebugConfigUi = { showErrorMessage: vi.fn() };
    const cm = makeManager(server, {
      isActiveServer: vi.fn(() => false),
      connectServer: vi.fn(async () => false),
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
    expect(cm.connectServer).toHaveBeenCalledWith(server.id);
  });

  it("uses an associated server without changing the active DatabaseContext", async () => {
    const server = makeServer();
    const ui: DebugConfigUi = { showErrorMessage: vi.fn() };
    const cm = makeManager(server, {
      isActiveServer: vi.fn(() => false),
      connectServer: vi.fn(async () => {
        throw new Error("must not switch context");
      }),
    });

    const resolved = await resolveDebugConfiguration(
      {
        sql: "SELECT public.test_simple(1, 'x')",
        server: server.id,
        preserveDatabaseContext: true,
      },
      cm,
      ui,
      noSqlTarget,
    );

    expect(cm.connectServer).not.toHaveBeenCalled();
    expect(resolved).toMatchObject({
      host: server.host,
      database: server.database,
      preserveDatabaseContext: true,
    });
  });
});
