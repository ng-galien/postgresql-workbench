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

import type { ServerConfig } from "../packages/catalog/src/savedConnection.js";
import { ConnectionManager } from "../vscode-extension/src/connection/openConnections.js";
import { ServerStore } from "../vscode-extension/src/connection/savedConnections.js";

const ADMIN_CONFIG = {
  host: "127.0.0.1",
  port: 5433,
  database: "postgres",
  user: "postgres",
  password: "postgres",
};
const DATABASE_A = "pgwb_manager_it_a";
const DATABASE_B = "pgwb_manager_it_b";

const SERVER_A = server(DATABASE_A);
const SERVER_B = server(DATABASE_B);
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
    for (const server of [SERVER_A, SERVER_B]) {
      if (manager.isServerConnected(server.id)) await manager.disconnect(server.id);
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

describe("e2e: ConnectionManager owns independent PostgreSQL Connexions", () => {
  it("opens two Connexions concurrently without replacing either session", async () => {
    const manager = connectionManager();
    await manager.store.add(SERVER_A, "postgres");
    await manager.store.add(SERVER_B, "postgres");

    await expect(
      Promise.all([manager.connectServer(SERVER_A.id), manager.connectServer(SERVER_B.id)]),
    ).resolves.toEqual([true, true]);

    expect(manager.isServerConnected(SERVER_A.id)).toBe(true);
    expect(manager.isServerConnected(SERVER_B.id)).toBe(true);
    expect(await backendPid(requiredClient(manager, SERVER_A.id))).toBeGreaterThan(0);
    expect(await backendPid(requiredClient(manager, SERVER_B.id))).toBeGreaterThan(0);
  });

  it("keeps stable backend sessions when each Connexion is addressed repeatedly", async () => {
    const manager = await connectedManager();
    const clientA = requiredClient(manager, SERVER_A.id);
    const clientB = requiredClient(manager, SERVER_B.id);
    const pidA = await backendPid(clientA);
    const pidB = await backendPid(clientB);

    for (let index = 0; index < 20; index += 1) {
      const target = index % 2 === 0 ? SERVER_A : SERVER_B;
      await expect(manager.connectServer(target.id)).resolves.toBe(true);
    }

    expect(manager.isServerConnected(SERVER_A.id)).toBe(true);
    expect(manager.isServerConnected(SERVER_B.id)).toBe(true);
    expect(await backendPid(clientA)).toBe(pidA);
    expect(await backendPid(clientB)).toBe(pidB);
  });

  it("disconnects one Connexion without changing the other", async () => {
    const manager = await connectedManager();
    const clientA = requiredClient(manager, SERVER_A.id);
    const clientB = requiredClient(manager, SERVER_B.id);
    const pidB = await backendPid(clientB);

    await expect(manager.disconnect(SERVER_A.id)).resolves.toBe(true);

    expect(manager.isServerConnected(SERVER_A.id)).toBe(false);
    expect(manager.isServerConnected(SERVER_B.id)).toBe(true);
    expect(await backendPid(clientB)).toBe(pidB);
    await expect(clientA.query("SELECT 1")).rejects.toThrow();
  });

  it("does not reconnect or replace another Connexion after one disconnects", async () => {
    const manager = await connectedManager();
    const clientA = requiredClient(manager, SERVER_A.id);
    const pidA = await backendPid(clientA);

    await expect(manager.disconnect(SERVER_B.id)).resolves.toBe(true);

    expect(manager.isServerConnected(SERVER_A.id)).toBe(true);
    expect(await backendPid(clientA)).toBe(pidA);

    await expect(manager.connectServer(SERVER_A.id)).resolves.toBe(true);
    expect(await backendPid(requiredClient(manager, SERVER_A.id))).toBe(pidA);
  });

  it("survives repeated disconnect and reconnect cycles on A while B keeps working", async () => {
    const manager = await connectedManager();
    const clientB = requiredClient(manager, SERVER_B.id);
    const pidB = await backendPid(clientB);

    for (let cycle = 0; cycle < 10; cycle += 1) {
      await Promise.all([
        manager.disconnect(SERVER_A.id),
        clientB.query("SELECT pg_backend_pid() AS pid"),
      ]);
      expect(manager.isServerConnected(SERVER_A.id)).toBe(false);
      expect(manager.isServerConnected(SERVER_B.id)).toBe(true);
      await Promise.all([
        manager.connectServer(SERVER_A.id),
        clientB.query("SELECT pg_backend_pid() AS pid"),
      ]);
    }

    expect(await backendPid(clientB)).toBe(pidB);
  });

  it("force-reconnects only the requested Connexion", async () => {
    const manager = await connectedManager();
    const oldPidA = await backendPid(requiredClient(manager, SERVER_A.id));
    const clientB = requiredClient(manager, SERVER_B.id);
    const pidB = await backendPid(clientB);

    await expect(manager.connectServer(SERVER_A.id, { force: true })).resolves.toBe(true);

    expect(await backendPid(requiredClient(manager, SERVER_A.id))).not.toBe(oldPidA);
    expect(manager.getClient(SERVER_B.id)).toBe(clientB);
    expect(await backendPid(clientB)).toBe(pidB);
  });

  it("preserves every live Connexion when a third connection attempt fails", async () => {
    const manager = await connectedManager();
    const clientA = requiredClient(manager, SERVER_A.id);
    const clientB = requiredClient(manager, SERVER_B.id);
    const pidA = await backendPid(clientA);
    const pidB = await backendPid(clientB);
    const unavailable = server("unavailable", 59999);
    await manager.store.add(unavailable, "postgres");

    await expect(manager.connectServer(unavailable.id)).resolves.toBe(false);

    expect(manager.isServerConnected(SERVER_A.id)).toBe(true);
    expect(manager.isServerConnected(SERVER_B.id)).toBe(true);
    expect(await backendPid(clientA)).toBe(pidA);
    expect(await backendPid(clientB)).toBe(pidB);
  });

  it("contains an unexpected backend loss and reconnects only that Connexion", async () => {
    const manager = await connectedManager();
    const clientA = requiredClient(manager, SERVER_A.id);
    const clientB = requiredClient(manager, SERVER_B.id);
    const pidA = await backendPid(clientA);
    const pidB = await backendPid(clientB);

    await admin.query("SELECT pg_terminate_backend($1)", [pidA]);
    await vi.waitFor(() => expect(manager.isServerConnected(SERVER_A.id)).toBe(false), {
      timeout: 5_000,
    });

    expect(manager.isServerConnected(SERVER_B.id)).toBe(true);
    expect(await backendPid(clientB)).toBe(pidB);

    await expect(manager.connectServer(SERVER_A.id)).resolves.toBe(true);
    const reconnectedA = requiredClient(manager, SERVER_A.id);
    expect(await backendPid(reconnectedA)).not.toBe(pidA);
    expect(await backendPid(clientB)).toBe(pidB);
  });

  it("keeps transaction and session state attached to the exact Connexion", async () => {
    const manager = await connectedManager();
    const clientA = requiredClient(manager, SERVER_A.id);
    const clientB = requiredClient(manager, SERVER_B.id);
    const pidA = await backendPid(clientA);

    await clientA.query("BEGIN");
    await clientA.query("CREATE TEMP TABLE pgwb_session_probe(value integer)");
    await clientA.query("INSERT INTO pgwb_session_probe VALUES (42)");
    await manager.connectServer(SERVER_B.id);

    await expect(clientB.query("SELECT * FROM pgwb_session_probe")).rejects.toThrow(
      /pgwb_session_probe/u,
    );
    await expect(manager.disconnect(SERVER_B.id)).resolves.toBe(true);
    expect(manager.isServerConnected(SERVER_A.id)).toBe(true);
    expect(await backendPid(clientA)).toBe(pidA);
    await expect(clientA.query("SELECT value FROM pgwb_session_probe")).resolves.toMatchObject({
      rows: [{ value: 42 }],
    });
    await clientA.query("ROLLBACK");
  });

  it("refreshes debugger capability only for the requested Connexion", async () => {
    const manager = await connectedManager();
    await vi.waitFor(
      () => {
        expect(manager.debugCapabilityFor(SERVER_A.id).status).toBe("available");
        expect(manager.debugCapabilityFor(SERVER_B.id).status).toBe("unavailable");
      },
      { timeout: 5_000 },
    );
    const unchangedB = manager.debugCapabilityFor(SERVER_B.id);

    await requiredClient(manager, SERVER_A.id).query("DROP EXTENSION pldbgapi");
    await expect(manager.refreshDebugCapability(SERVER_A.id)).resolves.toMatchObject({
      available: false,
    });

    expect(manager.debugCapabilityFor(SERVER_A.id).status).toBe("unavailable");
    expect(manager.debugCapabilityFor(SERVER_B.id)).toEqual(unchangedB);
    expect(manager.isServerConnected(SERVER_A.id)).toBe(true);
    expect(manager.isServerConnected(SERVER_B.id)).toBe(true);
  });
});

async function connectedManager(): Promise<ConnectionManager> {
  const manager = connectionManager();
  await manager.store.add(SERVER_A, "postgres");
  await manager.store.add(SERVER_B, "postgres");
  await expect(manager.connectServer(SERVER_A.id)).resolves.toBe(true);
  await expect(manager.connectServer(SERVER_B.id)).resolves.toBe(true);
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

function server(database: string, port = ADMIN_CONFIG.port): ServerConfig {
  return {
    id: ServerStore.makeId(ADMIN_CONFIG.host, port, database, ADMIN_CONFIG.user),
    name: `${database}@${ADMIN_CONFIG.host}:${port}`,
    host: ADMIN_CONFIG.host,
    port,
    database,
    user: ADMIN_CONFIG.user,
  };
}

function requiredClient(manager: ConnectionManager, serverId: string): Client {
  const client = manager.getClient(serverId);
  if (!client) throw new Error(`Expected ${serverId} to own a PostgreSQL client`);
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
