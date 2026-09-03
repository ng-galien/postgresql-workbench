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

import type { ConnectionConfig } from "../../../packages/catalog/src/savedConnection.js";
import { ConnectionManager } from "./openConnections.js";
import { ConnectionStore } from "./savedConnections.js";

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
  connection: ConnectionConfig,
  client: Client,
): Promise<void> {
  if (!manager.store.has(connection.id))
    await manager.store.add(connection, `${connection.name}-password`);
  service.connect.mockResolvedValueOnce(client);
  await expect(manager.connectConnection(connection.id)).resolves.toBe(true);
}

const OLD_CONNECTION: ConnectionConfig = {
  id: "old:5432/old:postgres",
  name: "old",
  host: "old",
  port: 5432,
  database: "old",
  user: "postgres",
};

const NEXT_CONNECTION: ConnectionConfig = {
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

describe("ConnectionManager independent Connection transitions", () => {
  it("names the shared PostgreSQL session and applies the saved client tuning", async () => {
    const { manager } = fixture();
    const connection: ConnectionConfig = {
      ...NEXT_CONNECTION,
      tuning: { keepAlive: true, searchPath: "shop, public" },
    };
    await manager.store.add(connection, "next-password");
    service.connect.mockResolvedValue(postgresClient());

    await expect(manager.connectConnection(connection.id)).resolves.toBe(true);

    expect(service.connect).toHaveBeenCalledWith({
      host: "next",
      port: 5432,
      database: "next",
      user: "postgres",
      password: "next-password",
      tuning: connection.tuning,
      applicationName: "postgresql-workbench:connection",
    });
    manager.dispose();
  });

  it("keeps connection controls independent from debugger capability detection", async () => {
    const { manager } = fixture();
    await manager.store.add(NEXT_CONNECTION, "next-password");
    const client = postgresClient();
    service.connect.mockResolvedValue(client);
    service.checkRequirements.mockReturnValue(new Promise(() => undefined));
    vi.mocked(vscode.window.withProgress).mockImplementationOnce(async (_options, task) =>
      task({ report: () => undefined }, {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => undefined }),
      } as never),
    );
    await expect(manager.connectConnection(NEXT_CONNECTION.id)).resolves.toBe(true);
    expect(manager.isConnectionConnected(NEXT_CONNECTION.id)).toBe(true);
    expect(manager.debugCapabilityFor(NEXT_CONNECTION.id).status).toBe("checking");
    await expect(manager.disconnect(NEXT_CONNECTION.id)).resolves.toBe(true);
    expect(service.disconnect).toHaveBeenCalledWith(client);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("owns debugger capability independently for every saved Connection", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_CONNECTION, "old-password");
    await manager.store.add(NEXT_CONNECTION, "next-password");
    const oldClient = {} as Client;
    const nextClient = {} as Client;
    service.connect.mockResolvedValueOnce(oldClient).mockResolvedValueOnce(nextClient);
    service.checkRequirements
      .mockResolvedValueOnce({ available: true, error: "" })
      .mockResolvedValueOnce({ available: false, error: "pldbgapi is not installed" });

    await expect(manager.refreshDebugCapability(OLD_CONNECTION.id)).resolves.toEqual({
      available: true,
      error: "",
    });
    await expect(manager.refreshDebugCapability(NEXT_CONNECTION.id)).resolves.toEqual({
      available: false,
      error: "pldbgapi is not installed",
    });

    expect(manager.debugCapabilityFor(OLD_CONNECTION.id)).toMatchObject({
      connectionId: OLD_CONNECTION.id,
      status: "available",
    });
    expect(manager.debugCapabilityFor(NEXT_CONNECTION.id)).toMatchObject({
      connectionId: NEXT_CONNECTION.id,
      status: "unavailable",
      message: "pldbgapi is not installed",
    });
    expect(service.disconnect).toHaveBeenCalledWith(oldClient);
    expect(service.disconnect).toHaveBeenCalledWith(nextClient);
    manager.dispose();
  });

  it("keeps two Connections alive and disconnects only the selected one", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_CONNECTION, "old-password");
    await manager.store.add(NEXT_CONNECTION, "next-password");
    const oldClient = postgresClient();
    const nextClient = postgresClient();
    await connect(manager, OLD_CONNECTION, oldClient);
    await connect(manager, NEXT_CONNECTION, nextClient);

    expect(service.disconnect).not.toHaveBeenCalled();
    expect(manager.isConnectionConnected(OLD_CONNECTION.id)).toBe(true);
    expect(manager.isConnectionConnected(NEXT_CONNECTION.id)).toBe(true);
    expect(manager.isConnectionConnected(NEXT_CONNECTION.id)).toBe(true);

    await expect(manager.disconnect(OLD_CONNECTION.id)).resolves.toBe(true);
    expect(service.disconnect).toHaveBeenCalledExactlyOnceWith(oldClient);
    expect(manager.isConnectionConnected(OLD_CONNECTION.id)).toBe(false);
    expect(manager.isConnectionConnected(NEXT_CONNECTION.id)).toBe(true);
    expect(manager.isConnectionConnected(NEXT_CONNECTION.id)).toBe(true);
    expect(manager.getClient(NEXT_CONNECTION.id)).toBe(nextClient);
    manager.dispose();
  });

  it("keeps the guarded Connection open when a Scratchpad Transaction cancels disconnect", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_CONNECTION, "old-password");
    const oldClient = postgresClient();
    await connect(manager, OLD_CONNECTION, oldClient);
    const guard = vi.fn().mockResolvedValue(undefined);
    manager.registerBeforeConnectionChange(guard);

    await expect(manager.disconnect()).resolves.toBe(false);

    expect(guard).toHaveBeenCalledWith(OLD_CONNECTION.id, "disconnecting the Connection");
    expect(service.disconnect).not.toHaveBeenCalled();
    expect(manager.store.get(OLD_CONNECTION.id)).toEqual(OLD_CONNECTION);
    expect(manager.isConnectionConnected(OLD_CONNECTION.id)).toBe(true);
    manager.dispose();
  });

  it("holds the Connection guard lease until the disconnect mutation finishes", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_CONNECTION, "old-password");
    const oldClient = postgresClient();
    await connect(manager, OLD_CONNECTION, oldClient);
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

  it("serializes concurrent Connection transitions", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_CONNECTION, "old-password");
    const oldClient = postgresClient();
    await connect(manager, OLD_CONNECTION, oldClient);
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
    expect(manager.isConnectionConnected(OLD_CONNECTION.id)).toBe(false);

    finishFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([true, false]);
    expect(service.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.isConnectionConnected(OLD_CONNECTION.id)).toBe(false);
    manager.dispose();
  });

  it("does not create a replacement Connection when the Transaction guard cancels", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_CONNECTION, "old-password");
    const guard = vi.fn().mockResolvedValue(undefined);
    manager.registerBeforeConnectionChange(guard);

    await expect(
      manager.replaceConnectionConfiguration(OLD_CONNECTION.id, NEXT_CONNECTION, "old-password"),
    ).resolves.toBe(false);

    expect(guard).toHaveBeenCalledWith(OLD_CONNECTION.id, "replacing the Connection");
    expect(manager.store.get(OLD_CONNECTION.id)).toEqual(OLD_CONNECTION);
    expect(manager.store.get(NEXT_CONNECTION.id)).toBeUndefined();
    manager.dispose();
  });

  it("forces a real reconnect after a saved password changes", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_CONNECTION, "new-password");
    const oldClient = postgresClient();
    await connect(manager, OLD_CONNECTION, oldClient);
    service.connect.mockRejectedValueOnce(new Error("network"));
    const guard = vi.fn().mockResolvedValue(new vscode.Disposable(() => {}));
    manager.registerBeforeConnectionChange(guard);

    await expect(manager.connectConnection(OLD_CONNECTION.id, { force: true })).resolves.toBe(
      false,
    );

    expect(guard).toHaveBeenCalledWith(OLD_CONNECTION.id, "reconnecting the Connection");
    expect(service.disconnect).toHaveBeenCalledWith(oldClient);
    expect(service.connect).toHaveBeenCalledWith(
      expect.objectContaining({ password: "new-password" }),
    );
    manager.dispose();
  });

  it("keeps an existing Connection open when another connection is cancelled", async () => {
    const { manager, workspaceState } = fixture();
    await manager.store.add(OLD_CONNECTION, "old-password");
    await manager.store.add(NEXT_CONNECTION, "next-password");
    await manager.store.setConnectionOpen(OLD_CONNECTION.id, true);
    const oldClient = postgresClient();
    await connect(manager, OLD_CONNECTION, oldClient);
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
    manager.onConnectionChanged(() => {
      activeChanges += 1;
    });

    await expect(manager.connectConnection(NEXT_CONNECTION.id)).resolves.toBe(false);

    expect(service.disconnect).not.toHaveBeenCalled();
    expect(manager.isConnectionConnected(OLD_CONNECTION.id)).toBe(true);
    expect(manager.getClient(OLD_CONNECTION.id)).toBe(oldClient);
    expect(workspaceState.get("postgresql-workbench.openServers")).toEqual([OLD_CONNECTION.id]);
    expect(activeChanges).toBeGreaterThanOrEqual(0);
    manager.dispose();
  });

  it("releases a failed Connection transition before waiting for a recovery action", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_CONNECTION, "old-password");
    service.connect.mockRejectedValueOnce(new Error("network"));
    let progressSettled = false;
    vi.mocked(vscode.window.withProgress).mockImplementationOnce(async (_options, task) => {
      const result = await task({ report: () => undefined }, {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => undefined }),
      } as never);
      progressSettled = true;
      return result;
    });
    vi.mocked(vscode.window.showErrorMessage).mockImplementationOnce(() => {
      expect(progressSettled).toBe(true);
      return new Promise(() => undefined);
    });

    await expect(manager.connectConnection(OLD_CONNECTION.id)).resolves.toBe(false);

    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce("Remove" as never);
    await expect(manager.commands.removeConnection(OLD_CONNECTION.id)).resolves.toBeUndefined();
    expect(manager.store.get(OLD_CONNECTION.id)).toBeUndefined();
    expect(vscode.commands.executeCommand).toHaveBeenCalledWith("notifications.hideToasts");
    manager.dispose();
  });

  it("keeps the previous port when an invalid edit is submitted", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_CONNECTION, "old-password");
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

    await manager.commands.editConnection(OLD_CONNECTION.id);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'Invalid port "invalid" — keeping 5432.',
    );
    expect(manager.store.get(OLD_CONNECTION.id)).toEqual(OLD_CONNECTION);
    expect(changes).toBe(1);
    manager.dispose();
  });

  it("publishes one change when removing an open Connection", async () => {
    const { manager, workspaceState } = fixture();
    await manager.store.add(OLD_CONNECTION, "old-password");
    await manager.store.setConnectionOpen(OLD_CONNECTION.id, true);
    await connect(manager, OLD_CONNECTION, postgresClient());
    let changes = 0;
    let activeChanges = 0;
    manager.onChanged(() => {
      changes += 1;
    });
    manager.onConnectionChanged(() => {
      activeChanges += 1;
    });
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Remove" as never);

    await manager.commands.removeConnection(OLD_CONNECTION.id);

    expect(manager.store.get(OLD_CONNECTION.id)).toBeUndefined();
    expect(workspaceState.get("postgresql-workbench.openServers")).toEqual([]);
    expect(changes).toBe(1);
    expect(activeChanges).toBe(1);
    manager.dispose();
  });

  it("connects the replacement after editing a Connection identity", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_CONNECTION, "old-password");
    await manager.store.setConnectionOpen(OLD_CONNECTION.id, true);
    const oldClient = postgresClient();
    await connect(manager, OLD_CONNECTION, oldClient);
    const replacementClient = postgresClient();
    service.connect.mockResolvedValueOnce(replacementClient);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: "Host",
      description: OLD_CONNECTION.host,
      detail: "host",
    });
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(NEXT_CONNECTION.host);

    await manager.commands.editConnection(OLD_CONNECTION.id);

    const replacementId = ConnectionStore.makeId(
      NEXT_CONNECTION.host,
      OLD_CONNECTION.port,
      OLD_CONNECTION.database,
      OLD_CONNECTION.user,
    );
    expect(manager.store.get(OLD_CONNECTION.id)).toBeUndefined();
    expect(manager.store.get(replacementId)).toMatchObject({
      id: replacementId,
      host: NEXT_CONNECTION.host,
      port: OLD_CONNECTION.port,
      database: OLD_CONNECTION.database,
      user: OLD_CONNECTION.user,
    });
    expect(service.disconnect).toHaveBeenCalledWith(oldClient);
    expect(manager.isConnectionConnected(OLD_CONNECTION.id)).toBe(false);
    expect(manager.isConnectionConnected(replacementId)).toBe(true);
    expect(manager.getClient(replacementId)).toBe(replacementClient);
    manager.dispose();
  });

  it("keeps a disconnected Connection closed after editing its identity", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_CONNECTION, "old-password");
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: "Host",
      description: OLD_CONNECTION.host,
      detail: "host",
    });
    vi.mocked(vscode.window.showInputBox).mockResolvedValue(NEXT_CONNECTION.host);

    await manager.commands.editConnection(OLD_CONNECTION.id);

    const replacementId = ConnectionStore.makeId(
      NEXT_CONNECTION.host,
      OLD_CONNECTION.port,
      OLD_CONNECTION.database,
      OLD_CONNECTION.user,
    );
    expect(manager.store.get(replacementId)).toBeDefined();
    expect(manager.isConnectionConnected(replacementId)).toBe(false);
    expect(service.connect).not.toHaveBeenCalled();
    manager.dispose();
  });
});
