import type { Client } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

const service = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("./connectionService.js", () => ({
  ConnectionService: class {
    connect = service.connect;
    disconnect = service.disconnect;
    connectClient = vi.fn();
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

import { ConnectionManager } from "./connectionManager.js";
import { type ServerConfig, ServerStore } from "./serverStore.js";

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
  service.disconnect.mockReset().mockResolvedValue(undefined);
  service.connect.mockReturnValue(new Promise(() => undefined));
});

describe("ConnectionManager active database transitions", () => {
  it("keeps the active Connexion open when a Scratchpad Transaction guard cancels disconnect", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_SERVER, "old-password");
    const oldClient = {} as Client;
    const mutable = manager as unknown as {
      client: Client;
      _activeServerId: string;
      _connected: boolean;
    };
    mutable.client = oldClient;
    mutable._activeServerId = OLD_SERVER.id;
    mutable._connected = true;
    const guard = vi.fn().mockResolvedValue(undefined);
    manager.registerBeforeConnectionChange(guard);

    await expect(manager.disconnect()).resolves.toBe(false);

    expect(guard).toHaveBeenCalledWith(OLD_SERVER.id, "disconnecting the Connexion");
    expect(service.disconnect).not.toHaveBeenCalled();
    expect(manager.activeServer).toEqual(OLD_SERVER);
    expect(manager.isConnected).toBe(true);
    manager.dispose();
  });

  it("holds the Connexion guard lease until the disconnect mutation finishes", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_SERVER, "old-password");
    const oldClient = {} as Client;
    const mutable = manager as unknown as {
      client: Client;
      _activeServerId: string;
      _connected: boolean;
    };
    mutable.client = oldClient;
    mutable._activeServerId = OLD_SERVER.id;
    mutable._connected = true;
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
    const oldClient = {} as Client;
    const mutable = manager as unknown as {
      client: Client;
      _activeServerId: string;
      _connected: boolean;
    };
    mutable.client = oldClient;
    mutable._activeServerId = OLD_SERVER.id;
    mutable._connected = true;
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
    expect(manager.isConnected).toBe(true);

    finishFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(service.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.isConnected).toBe(false);
    manager.dispose();
  });

  it("does not create a replacement Connexion when the Transaction guard cancels", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_SERVER, "old-password");
    const guard = vi.fn().mockResolvedValue(undefined);
    manager.registerBeforeConnectionChange(guard);

    await expect(
      manager.replaceDatabaseContextConfiguration(OLD_SERVER.id, NEXT_SERVER, "old-password"),
    ).resolves.toBe(false);

    expect(guard).toHaveBeenCalledWith(OLD_SERVER.id, "replacing the Connexion");
    expect(manager.store.get(OLD_SERVER.id)).toEqual(OLD_SERVER);
    expect(manager.store.get(NEXT_SERVER.id)).toBeUndefined();
    manager.dispose();
  });

  it("forces a real reconnect after a saved password changes", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_SERVER, "new-password");
    const oldClient = {} as Client;
    const mutable = manager as unknown as {
      client: Client;
      _activeServerId: string;
      _connected: boolean;
    };
    mutable.client = oldClient;
    mutable._activeServerId = OLD_SERVER.id;
    mutable._connected = true;
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

  it("publishes a disconnected context when a promoted connection is cancelled", async () => {
    const { manager, workspaceState } = fixture();
    await manager.store.add(OLD_SERVER, "old-password");
    await manager.store.add(NEXT_SERVER, "next-password");
    await manager.store.setActiveServerId(OLD_SERVER.id);
    const oldClient = {} as Client;
    const mutable = manager as unknown as {
      client: Client;
      _activeServerId: string;
      _connected: boolean;
      fire(): void;
    };
    mutable.client = oldClient;
    mutable._activeServerId = OLD_SERVER.id;
    mutable._connected = true;
    mutable.fire();
    let activeChanges = 0;
    manager.onServerChanged(() => {
      activeChanges += 1;
    });

    await expect(manager.connectServer(NEXT_SERVER.id)).resolves.toBe(false);

    expect(service.disconnect).toHaveBeenCalledWith(oldClient);
    expect(manager.activeServer).toBeUndefined();
    expect(manager.isConnected).toBe(false);
    expect(manager.getClient()).toBeUndefined();
    expect(workspaceState.get("postgresql-workbench.activeServer")).toBeUndefined();
    expect(activeChanges).toBe(1);
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

  it("publishes one change when removing the active database context", async () => {
    const { manager, workspaceState } = fixture();
    await manager.store.add(OLD_SERVER, "old-password");
    await manager.store.setActiveServerId(OLD_SERVER.id);
    const mutable = manager as unknown as {
      _activeServerId: string;
      _connected: boolean;
      fire(): void;
    };
    mutable._activeServerId = OLD_SERVER.id;
    mutable._connected = true;
    mutable.fire();
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
    expect(workspaceState.get("postgresql-workbench.activeServer")).toBeUndefined();
    expect(changes).toBe(1);
    expect(activeChanges).toBe(1);
    manager.dispose();
  });

  it("publishes one change when replacing the active database context", async () => {
    const { manager } = fixture();
    await manager.store.add(OLD_SERVER, "old-password");
    await manager.store.setActiveServerId(OLD_SERVER.id);
    const mutable = manager as unknown as {
      _activeServerId: string;
      _connected: boolean;
      fire(): void;
    };
    mutable._activeServerId = OLD_SERVER.id;
    mutable._connected = true;
    mutable.fire();
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
