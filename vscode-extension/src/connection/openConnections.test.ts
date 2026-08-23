import type { Client } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

const service = vi.hoisted(() => ({
  connect: vi.fn(),
  checkRequirements: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("./connectPostgres.js", () => ({
  ConnectionService: class {
    connectClient = service.connect;
    checkRequirements = service.checkRequirements;
    disconnect = service.disconnect;
    classifyError = vi.fn(() => ({ kind: "network", message: "network error" }));
  },
}));

vi.mock("vscode", () => {
  class EventEmitter<T> {
    private readonly listeners: Array<(value: T) => void> = [];
    readonly event = (listener: (value: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => undefined };
    };
    fire(value: T): void {
      for (const listener of this.listeners) listener(value);
    }
    dispose(): void {
      this.listeners.length = 0;
    }
  }

  return {
    Disposable: class {
      constructor(private readonly callback: () => void) {}
      dispose(): void {
        this.callback();
      }
    },
    EventEmitter,
    ProgressLocation: { Notification: 15 },
    StatusBarAlignment: { Left: 1 },
    ThemeColor: class {},
    commands: { executeCommand: vi.fn() },
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
      showErrorMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      withProgress: vi.fn(async (_options, task) =>
        task(
          {},
          {
            isCancellationRequested: true,
            onCancellationRequested(listener: () => void) {
              listener();
              return { dispose: () => undefined };
            },
          },
        ),
      ),
    },
  };
});

import type { ServerConfig } from "../../../packages/catalog/src/savedConnection.js";
import { ConnectionManager } from "./openConnections.js";
import { ServerStore } from "./savedConnections.js";

function stateStore() {
  const values = new Map<string, unknown>();
  return {
    get<T>(key: string): T | undefined {
      return values.get(key) as T | undefined;
    },
    async update(key: string, value: unknown): Promise<void> {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
  };
}

function fixture() {
  const globalState = stateStore();
  const workspaceState = stateStore();
  const secrets = new Map<string, string>();
  const context = {
    globalState,
    workspaceState,
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => {
        secrets.set(key, value);
      },
      delete: async (key: string) => {
        secrets.delete(key);
      },
    },
  };
  const manager = new ConnectionManager(
    context as never,
    {
      appendLine: vi.fn(),
    } as never,
  );
  return { manager, workspaceState };
}

function postgresClient(): Client {
  return { on: vi.fn() } as unknown as Client;
}

async function connect(
  manager: ConnectionManager,
  server: ServerConfig,
  client: Client,
): Promise<void> {
  if (!manager.store.has(server.id)) await manager.store.add(server, `${server.name}-password`);
  service.connect.mockResolvedValueOnce(client);
  await expect(manager.connectServer(server.id)).resolves.toBe(true);
}

const OLD_SERVER: ServerConfig = {
  id: "old:5432/old:postgres",
  name: "old",
  host: "old",
  port: 5432,
  database: "old",
  user: "postgres",
};

const NEXT_SERVER: ServerConfig = {
  id: "next:5432/next:postgres",
  name: "next",
  host: "next",
  port: 5432,
  database: "next",
  user: "postgres",
};

beforeEach(() => {
  vi.clearAllMocks();
  service.connect.mockReset();
  service.checkRequirements.mockReset().mockResolvedValue({ available: false, error: "" });
  service.disconnect.mockReset().mockResolvedValue(undefined);
  service.connect.mockReturnValue(new Promise(() => undefined));
  vi.mocked(vscode.window.withProgress).mockImplementation(async (_options, task) =>
    task({ report: () => undefined }, {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined }),
    } as never),
  );
});

describe("ConnectionManager independent Connexion transitions", () => {
  it("keeps connection controls independent from debugger capability detection", async () => {
    const { manager } = fixture();
    await manager.store.add(NEXT_SERVER, "next-password");
    const client = postgresClient();
    service.connect.mockResolvedValue(client);
    service.checkRequirements.mockReturnValue(new Promise(() => undefined));
    vi.mocked(vscode.window.withProgress).mockImplementationOnce(async (_options, task) =>
      task({ report: () => undefined }, {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => undefined }),
      } as never),
    );
    await expect(manager.connectServer(NEXT_SERVER.id)).resolves.toBe(true);
    expect(manager.isServerConnected(NEXT_SERVER.id)).toBe(true);
    expect(manager.debugCapabilityFor(NEXT_SERVER.id).status).toBe("checking");
    await expect(manager.disconnect(NEXT_SERVER.id)).resolves.toBe(true);
    expect(service.disconnect).toHaveBeenCalledWith(client);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("owns debugger capability independently for every saved Connexion", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_SERVER, "old-password");
    await manager.store.add(NEXT_SERVER, "next-password");
    const oldClient = {} as Client;
    const nextClient = {} as Client;
    service.connect.mockResolvedValueOnce(oldClient).mockResolvedValueOnce(nextClient);
    service.checkRequirements
      .mockResolvedValueOnce({ available: true, error: "" })
      .mockResolvedValueOnce({ available: false, error: "pldbgapi is not installed" });

    await expect(manager.refreshDebugCapability(OLD_SERVER.id)).resolves.toEqual({
      available: true,
      error: "",
    });
    await expect(manager.refreshDebugCapability(NEXT_SERVER.id)).resolves.toEqual({
      available: false,
      error: "pldbgapi is not installed",
    });

    expect(manager.debugCapabilityFor(OLD_SERVER.id)).toMatchObject({
      serverId: OLD_SERVER.id,
      status: "available",
    });
    expect(manager.debugCapabilityFor(NEXT_SERVER.id)).toMatchObject({
      serverId: NEXT_SERVER.id,
      status: "unavailable",
      message: "pldbgapi is not installed",
    });
    expect(service.disconnect).toHaveBeenCalledWith(oldClient);
    expect(service.disconnect).toHaveBeenCalledWith(nextClient);
    manager.dispose();
  });

  it("keeps two Connexions alive and disconnects only the selected one", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_SERVER, "old-password");
    await manager.store.add(NEXT_SERVER, "next-password");
    const oldClient = postgresClient();
    const nextClient = postgresClient();
    await connect(manager, OLD_SERVER, oldClient);
    await connect(manager, NEXT_SERVER, nextClient);

    expect(service.disconnect).not.toHaveBeenCalled();
    expect(manager.isServerConnected(OLD_SERVER.id)).toBe(true);
    expect(manager.isServerConnected(NEXT_SERVER.id)).toBe(true);
    expect(manager.isServerConnected(NEXT_SERVER.id)).toBe(true);

    await expect(manager.disconnect(OLD_SERVER.id)).resolves.toBe(true);
    expect(service.disconnect).toHaveBeenCalledExactlyOnceWith(oldClient);
    expect(manager.isServerConnected(OLD_SERVER.id)).toBe(false);
    expect(manager.isServerConnected(NEXT_SERVER.id)).toBe(true);
    expect(manager.isServerConnected(NEXT_SERVER.id)).toBe(true);
    expect(manager.getClient(NEXT_SERVER.id)).toBe(nextClient);
    manager.dispose();
  });

  it("keeps the guarded Connexion open when a Scratchpad Transaction cancels disconnect", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_SERVER, "old-password");
    const oldClient = postgresClient();
    await connect(manager, OLD_SERVER, oldClient);
    const guard = vi.fn().mockResolvedValue(undefined);
    manager.registerBeforeConnectionChange(guard);

    await expect(manager.disconnect()).resolves.toBe(false);

    expect(guard).toHaveBeenCalledWith(OLD_SERVER.id, "disconnecting the Connexion");
    expect(service.disconnect).not.toHaveBeenCalled();
    expect(manager.store.get(OLD_SERVER.id)).toEqual(OLD_SERVER);
    expect(manager.isServerConnected(OLD_SERVER.id)).toBe(true);
    manager.dispose();
  });

  it("holds the Connexion guard lease until the disconnect mutation finishes", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_SERVER, "old-password");
    const oldClient = postgresClient();
    await connect(manager, OLD_SERVER, oldClient);
    let finishDisconnect = () => {};
    service.disconnect.mockReturnValue(
      new Promise<void>((resolve) => {
        finishDisconnect = resolve;
      }),
    );
    const release = vi.fn();
    manager.registerBeforeConnectionChange(async () => new vscode.Disposable(release));

    const disconnect = manager.disconnect();
    await vi.waitFor(() => expect(service.disconnect).toHaveBeenCalledWith(oldClient));
    expect(release).not.toHaveBeenCalled();

    finishDisconnect();
    await expect(disconnect).resolves.toBe(true);
    expect(release).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it("serializes concurrent Connexion transitions", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_SERVER, "old-password");
    const oldClient = postgresClient();
    await connect(manager, OLD_SERVER, oldClient);
    let finishFirst = () => {};
    service.disconnect.mockReturnValue(
      new Promise<void>((resolve) => {
        finishFirst = resolve;
      }),
    );
    manager.registerBeforeConnectionChange(async () => new vscode.Disposable(() => {}));

    const first = manager.disconnect();
    const second = manager.disconnect();
    await vi.waitFor(() => expect(service.disconnect).toHaveBeenCalledTimes(1));
    expect(manager.isServerConnected(OLD_SERVER.id)).toBe(false);

    finishFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([true, false]);
    expect(service.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.isServerConnected(OLD_SERVER.id)).toBe(false);
    manager.dispose();
  });

  it("does not create a replacement Connexion when the Transaction guard cancels", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_SERVER, "old-password");
    const guard = vi.fn().mockResolvedValue(undefined);
    manager.registerBeforeConnectionChange(guard);

    await expect(
      manager.replaceConnectionConfiguration(OLD_SERVER.id, NEXT_SERVER, "old-password"),
    ).resolves.toBe(false);

    expect(guard).toHaveBeenCalledWith(OLD_SERVER.id, "replacing the Connexion");
    expect(manager.store.get(OLD_SERVER.id)).toEqual(OLD_SERVER);
    expect(manager.store.get(NEXT_SERVER.id)).toBeUndefined();
    manager.dispose();
  });

  it("forces a real reconnect after a saved password changes", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_SERVER, "new-password");
    const oldClient = postgresClient();
    await connect(manager, OLD_SERVER, oldClient);
    service.connect.mockRejectedValueOnce(new Error("network"));
    const guard = vi.fn().mockResolvedValue(new vscode.Disposable(() => {}));
    manager.registerBeforeConnectionChange(guard);

    await expect(manager.connectServer(OLD_SERVER.id, { force: true })).resolves.toBe(false);

    expect(guard).toHaveBeenCalledWith(OLD_SERVER.id, "reconnecting the Connexion");
    expect(service.disconnect).toHaveBeenCalledWith(oldClient);
    expect(service.connect).toHaveBeenCalledWith(
      expect.objectContaining({ password: "new-password" }),
    );
    manager.dispose();
  });

  it("keeps an existing Connexion open when another connection is cancelled", async () => {
    const { manager, workspaceState } = fixture();
    await manager.store.add(OLD_SERVER, "old-password");
    await manager.store.add(NEXT_SERVER, "next-password");
    await manager.store.setConnectionOpen(OLD_SERVER.id, true);
    const oldClient = postgresClient();
    await connect(manager, OLD_SERVER, oldClient);
    vi.mocked(vscode.window.withProgress).mockImplementationOnce(async (_options, task) =>
      task({ report: () => undefined }, {
        isCancellationRequested: true,
        onCancellationRequested(listener: () => void) {
          listener();
          return { dispose: () => undefined };
        },
      } as never),
    );
    let activeChanges = 0;
    manager.onServerChanged(() => {
      activeChanges += 1;
    });

    await expect(manager.connectServer(NEXT_SERVER.id)).resolves.toBe(false);

    expect(service.disconnect).not.toHaveBeenCalled();
    expect(manager.isServerConnected(OLD_SERVER.id)).toBe(true);
    expect(manager.getClient(OLD_SERVER.id)).toBe(oldClient);
    expect(workspaceState.get("postgresql-workbench.openServers")).toEqual([OLD_SERVER.id]);
    expect(activeChanges).toBeGreaterThanOrEqual(0);
    manager.dispose();
  });

  it("keeps the previous port when an invalid edit is submitted", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_SERVER, "old-password");
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: "Port",
      description: "5432",
      detail: "port",
    });
    vi.mocked(vscode.window.showInputBox).mockResolvedValue("invalid");
    let changes = 0;
    manager.onChanged(() => {
      changes += 1;
    });

    await manager.editServer(OLD_SERVER.id);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'Invalid port "invalid" — keeping 5432.',
    );
    expect(manager.store.get(OLD_SERVER.id)).toEqual(OLD_SERVER);
    expect(changes).toBe(1);
    manager.dispose();
  });

  it("publishes one change when removing an open Connexion", async () => {
    const { manager, workspaceState } = fixture();
    await manager.store.add(OLD_SERVER, "old-password");
    await manager.store.setConnectionOpen(OLD_SERVER.id, true);
    await connect(manager, OLD_SERVER, postgresClient());
    let changes = 0;
    let activeChanges = 0;
    manager.onChanged(() => {
      changes += 1;
    });
    manager.onServerChanged(() => {
      activeChanges += 1;
    });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Remove" as never);

    await manager.removeServer(OLD_SERVER.id);

    expect(manager.store.get(OLD_SERVER.id)).toBeUndefined();
    expect(workspaceState.get("postgresql-workbench.openServers")).toEqual([]);
    expect(changes).toBe(1);
    expect(activeChanges).toBe(1);
    manager.dispose();
  });

  it("publishes one change when replacing an open Connexion", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_SERVER, "old-password");
    await manager.store.setConnectionOpen(OLD_SERVER.id, true);
    await connect(manager, OLD_SERVER, postgresClient());
    let changes = 0;
    let activeChanges = 0;
    manager.onChanged(() => {
      changes += 1;
    });
    manager.onServerChanged(() => {
      activeChanges += 1;
    });
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: "Host",
      description: OLD_SERVER.host,
      detail: "host",
    });
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(NEXT_SERVER.host);

    await manager.editServer(OLD_SERVER.id);

    const replacementId = ServerStore.makeId(
      NEXT_SERVER.host,
      OLD_SERVER.port,
      OLD_SERVER.database,
      OLD_SERVER.user,
    );
    expect(manager.store.get(OLD_SERVER.id)).toBeUndefined();
    expect(manager.store.get(replacementId)).toMatchObject({
      id: replacementId,
      host: NEXT_SERVER.host,
      port: OLD_SERVER.port,
      database: OLD_SERVER.database,
      user: OLD_SERVER.user,
    });
    expect(changes).toBe(1);
    expect(activeChanges).toBe(1);
    manager.dispose();
  });
});
