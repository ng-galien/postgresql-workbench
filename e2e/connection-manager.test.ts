import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => {
  class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();
    readonly event = (listener: (value: T) => void) => {
      this.listeners.add(listener);
      return new Disposable(() => this.listeners.delete(listener));
    };
    fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }
    dispose(): void {
      this.listeners.clear();
    }
  }

  class Disposable {
    constructor(private readonly callback: () => void) {}
    dispose(): void {
      this.callback();
    }
  }

  return {
    Disposable,
    EventEmitter,
    ProgressLocation: { Notification: 15 },
    StatusBarAlignment: { Left: 1 },
    ThemeColor: class {},
    commands: { executeCommand: vi.fn(async () => undefined) },
    window: {
      createStatusBarItem: () => ({
        show: vi.fn(),
        dispose: vi.fn(),
        text: "",
        tooltip: "",
        command: "",
        backgroundColor: undefined,
      }),
      showInputBox: vi.fn(),
      showQuickPick: vi.fn(),
      showErrorMessage: vi.fn(async () => undefined),
      showWarningMessage: vi.fn(async () => undefined),
      showInformationMessage: vi.fn(async () => undefined),
      withProgress: vi.fn(async (_options, task) =>
        task(
          { report: () => undefined },
          {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose: () => undefined }),
          },
        ),
      ),
    },
  };
});

import type { ConnectionConfig } from "../packages/catalog/src/savedConnection.js";
import { ConnectionManager } from "../vscode-extension/src/connection/openConnections.js";
import { ConnectionStore } from "../vscode-extension/src/connection/savedConnections.js";

const ADMIN_CONFIG = {
  host: "127.0.0.1",
  port: 5433,
  database: "postgres",
  user: "postgres",
  password: "postgres",
};
const DATABASE_A = "pgwb_manager_it_a";
const DATABASE_B = "pgwb_manager_it_b";

const CONNECTION_A = connection(DATABASE_A);
const CONNECTION_B = connection(DATABASE_B);
const managers = new Set<ConnectionManager>();
let admin: Client;

beforeAll(async () => {
  admin = new Client(ADMIN_CONFIG);
  await admin.connect();
  for (const database of [DATABASE_A, DATABASE_B]) {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${database}`);
  }
  await withDatabase(DATABASE_A, (client) => client.query("CREATE EXTENSION pldbgapi"));
}, 30_000);

afterEach(async () => {
  for (const manager of managers) {
    for (const connection of [CONNECTION_A, CONNECTION_B]) {
      if (manager.isConnectionConnected(connection.id)) await manager.disconnect(connection.id);
    }
    manager.dispose();
  }
  managers.clear();
  await admin.query(
    `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
      WHERE datname = ANY($1::text[])
        AND pid <> pg_backend_pid()`,
    [[DATABASE_A, DATABASE_B]],
  );
  await withDatabase(DATABASE_A, async (client) => {
    await client.query("CREATE EXTENSION IF NOT EXISTS pldbgapi");
  });
}, 30_000);

afterAll(async () => {
  for (const database of [DATABASE_A, DATABASE_B]) {
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
  }
  await admin.end();
});

describe("e2e: ConnectionManager owns independent PostgreSQL Connections", () => {
  it("opens two Connections concurrently without replacing either session", async () => {
    const manager = connectionManager();
    await manager.store.add(CONNECTION_A, "postgres");
    await manager.store.add(CONNECTION_B, "postgres");

    await expect(
      Promise.all([
        manager.connectConnection(CONNECTION_A.id),
        manager.connectConnection(CONNECTION_B.id),
      ]),
    ).resolves.toEqual([true, true]);

    expect(manager.isConnectionConnected(CONNECTION_A.id)).toBe(true);
    expect(manager.isConnectionConnected(CONNECTION_B.id)).toBe(true);
    expect(await backendPid(requiredClient(manager, CONNECTION_A.id))).toBeGreaterThan(0);
    expect(await backendPid(requiredClient(manager, CONNECTION_B.id))).toBeGreaterThan(0);
  });

  it("keeps stable backend sessions when each Connection is addressed repeatedly", async () => {
    const manager = await connectedManager();
    const clientA = requiredClient(manager, CONNECTION_A.id);
    const clientB = requiredClient(manager, CONNECTION_B.id);
    const pidA = await backendPid(clientA);
    const pidB = await backendPid(clientB);

    for (let index = 0; index < 20; index += 1) {
      const target = index % 2 === 0 ? CONNECTION_A : CONNECTION_B;
      await expect(manager.connectConnection(target.id)).resolves.toBe(true);
    }

    expect(manager.isConnectionConnected(CONNECTION_A.id)).toBe(true);
    expect(manager.isConnectionConnected(CONNECTION_B.id)).toBe(true);
    expect(await backendPid(clientA)).toBe(pidA);
    expect(await backendPid(clientB)).toBe(pidB);
  });

  it("disconnects one Connection without changing the other", async () => {
    const manager = await connectedManager();
    const clientA = requiredClient(manager, CONNECTION_A.id);
    const clientB = requiredClient(manager, CONNECTION_B.id);
    const pidB = await backendPid(clientB);

    await expect(manager.disconnect(CONNECTION_A.id)).resolves.toBe(true);

    expect(manager.isConnectionConnected(CONNECTION_A.id)).toBe(false);
    expect(manager.isConnectionConnected(CONNECTION_B.id)).toBe(true);
    expect(await backendPid(clientB)).toBe(pidB);
    await expect(clientA.query("SELECT 1")).rejects.toThrow();
  });

  it("does not reconnect or replace another Connection after one disconnects", async () => {
    const manager = await connectedManager();
    const clientA = requiredClient(manager, CONNECTION_A.id);
    const pidA = await backendPid(clientA);

    await expect(manager.disconnect(CONNECTION_B.id)).resolves.toBe(true);

    expect(manager.isConnectionConnected(CONNECTION_A.id)).toBe(true);
    expect(await backendPid(clientA)).toBe(pidA);

    await expect(manager.connectConnection(CONNECTION_A.id)).resolves.toBe(true);
    expect(await backendPid(requiredClient(manager, CONNECTION_A.id))).toBe(pidA);
  });

  it("survives repeated disconnect and reconnect cycles on A while B keeps working", async () => {
    const manager = await connectedManager();
    const clientB = requiredClient(manager, CONNECTION_B.id);
    const pidB = await backendPid(clientB);

    for (let cycle = 0; cycle < 10; cycle += 1) {
      await Promise.all([
        manager.disconnect(CONNECTION_A.id),
        clientB.query("SELECT pg_backend_pid() AS pid"),
      ]);
      expect(manager.isConnectionConnected(CONNECTION_A.id)).toBe(false);
      expect(manager.isConnectionConnected(CONNECTION_B.id)).toBe(true);
      await Promise.all([
        manager.connectConnection(CONNECTION_A.id),
        clientB.query("SELECT pg_backend_pid() AS pid"),
      ]);
    }

    expect(await backendPid(clientB)).toBe(pidB);
  });

  it("force-reconnects only the requested Connection", async () => {
    const manager = await connectedManager();
    const oldPidA = await backendPid(requiredClient(manager, CONNECTION_A.id));
    const clientB = requiredClient(manager, CONNECTION_B.id);
    const pidB = await backendPid(clientB);

    await expect(manager.connectConnection(CONNECTION_A.id, { force: true })).resolves.toBe(true);

    expect(await backendPid(requiredClient(manager, CONNECTION_A.id))).not.toBe(oldPidA);
    expect(manager.getClient(CONNECTION_B.id)).toBe(clientB);
    expect(await backendPid(clientB)).toBe(pidB);
  });

  it("preserves every live Connection when a third connection attempt fails", async () => {
    const manager = await connectedManager();
    const clientA = requiredClient(manager, CONNECTION_A.id);
    const clientB = requiredClient(manager, CONNECTION_B.id);
    const pidA = await backendPid(clientA);
    const pidB = await backendPid(clientB);
    const unavailable = connection("unavailable", 59999);
    await manager.store.add(unavailable, "postgres");

    await expect(manager.connectConnection(unavailable.id)).resolves.toBe(false);

    expect(manager.isConnectionConnected(CONNECTION_A.id)).toBe(true);
    expect(manager.isConnectionConnected(CONNECTION_B.id)).toBe(true);
    expect(await backendPid(clientA)).toBe(pidA);
    expect(await backendPid(clientB)).toBe(pidB);
  });

  it("contains an unexpected backend loss and reconnects only that Connection", async () => {
    const manager = await connectedManager();
    const clientA = requiredClient(manager, CONNECTION_A.id);
    const clientB = requiredClient(manager, CONNECTION_B.id);
    const pidA = await backendPid(clientA);
    const pidB = await backendPid(clientB);

    await admin.query("SELECT pg_terminate_backend($1)", [pidA]);
    await vi.waitFor(() => expect(manager.isConnectionConnected(CONNECTION_A.id)).toBe(false), {
      timeout: 5_000,
    });

    expect(manager.isConnectionConnected(CONNECTION_B.id)).toBe(true);
    expect(await backendPid(clientB)).toBe(pidB);

    await expect(manager.connectConnection(CONNECTION_A.id)).resolves.toBe(true);
    const reconnectedA = requiredClient(manager, CONNECTION_A.id);
    expect(await backendPid(reconnectedA)).not.toBe(pidA);
    expect(await backendPid(clientB)).toBe(pidB);
  });

  it("keeps transaction and session state attached to the exact Connection", async () => {
    const manager = await connectedManager();
    const clientA = requiredClient(manager, CONNECTION_A.id);
    const clientB = requiredClient(manager, CONNECTION_B.id);
    const pidA = await backendPid(clientA);

    await clientA.query("BEGIN");
    await clientA.query("CREATE TEMP TABLE pgwb_session_probe(value integer)");
    await clientA.query("INSERT INTO pgwb_session_probe VALUES (42)");
    await manager.connectConnection(CONNECTION_B.id);

    await expect(clientB.query("SELECT * FROM pgwb_session_probe")).rejects.toThrow(
      /pgwb_session_probe/u,
    );
    await expect(manager.disconnect(CONNECTION_B.id)).resolves.toBe(true);
    expect(manager.isConnectionConnected(CONNECTION_A.id)).toBe(true);
    expect(await backendPid(clientA)).toBe(pidA);
    await expect(clientA.query("SELECT value FROM pgwb_session_probe")).resolves.toMatchObject({
      rows: [{ value: 42 }],
    });
    await clientA.query("ROLLBACK");
  });

  it("refreshes debugger capability only for the requested Connection", async () => {
    const manager = await connectedManager();
    await vi.waitFor(
      () => {
        expect(manager.debugCapabilityFor(CONNECTION_A.id).status).toBe("available");
        expect(manager.debugCapabilityFor(CONNECTION_B.id).status).toBe("unavailable");
      },
      { timeout: 5_000 },
    );
    const unchangedB = manager.debugCapabilityFor(CONNECTION_B.id);

    await requiredClient(manager, CONNECTION_A.id).query("DROP EXTENSION pldbgapi");
    await expect(manager.refreshDebugCapability(CONNECTION_A.id)).resolves.toMatchObject({
      available: false,
    });

    expect(manager.debugCapabilityFor(CONNECTION_A.id).status).toBe("unavailable");
    expect(manager.debugCapabilityFor(CONNECTION_B.id)).toEqual(unchangedB);
    expect(manager.isConnectionConnected(CONNECTION_A.id)).toBe(true);
    expect(manager.isConnectionConnected(CONNECTION_B.id)).toBe(true);
  });
});

async function connectedManager(): Promise<ConnectionManager> {
  const manager = connectionManager();
  await manager.store.add(CONNECTION_A, "postgres");
  await manager.store.add(CONNECTION_B, "postgres");
  await expect(manager.connectConnection(CONNECTION_A.id)).resolves.toBe(true);
  await expect(manager.connectConnection(CONNECTION_B.id)).resolves.toBe(true);
  return manager;
}

function connectionManager(): ConnectionManager {
  const values = new Map<string, unknown>();
  const passwords = new Map<string, string>();
  const state = {
    get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
  };
  const manager = new ConnectionManager(
    {
      globalState: state,
      workspaceState: state,
      secrets: {
        get: async (key: string) => passwords.get(key),
        store: async (key: string, value: string) => {
          passwords.set(key, value);
        },
        delete: async (key: string) => {
          passwords.delete(key);
        },
      },
    } as never,
    { appendLine: () => undefined } as never,
  );
  managers.add(manager);
  return manager;
}

function connection(database: string, port = ADMIN_CONFIG.port): ConnectionConfig {
  return {
    id: ConnectionStore.makeId(ADMIN_CONFIG.host, port, database, ADMIN_CONFIG.user),
    name: `${database}@${ADMIN_CONFIG.host}:${port}`,
    host: ADMIN_CONFIG.host,
    port,
    database,
    user: ADMIN_CONFIG.user,
  };
}

function requiredClient(manager: ConnectionManager, connectionId: string): Client {
  const client = manager.getClient(connectionId);
  if (!client) throw new Error(`Expected ${connectionId} to own a PostgreSQL client`);
  return client;
}

async function backendPid(client: Client): Promise<number> {
  const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return Number(result.rows[0]?.pid);
}

async function withDatabase<T>(
  database: string,
  action: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ ...ADMIN_CONFIG, database });
  await client.connect();
  try {
    return await action(client);
  } finally {
    await client.end();
  }
}
