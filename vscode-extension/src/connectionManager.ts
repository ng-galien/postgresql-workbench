import type { Client } from "pg";
import * as vscode from "vscode";
import { ConnectionCommands } from "./connectionCommands.js";
import { ConnectionService, type ConnectResult } from "./connectionService.js";
import { showRequirementsGuide } from "./requirementsGuide.js";
import { type ServerConfig, ServerStore } from "./serverStore.js";

/**
 * Orchestrates server management, connection lifecycle, status bar, and events.
 * Consumers (TreeView, ContentProvider) listen to `onChanged`.
 */
// This lifecycle facade deliberately combines tiny observable-state accessors with the atomic
// connection transition; interactive CRUD/import responsibilities live in ConnectionCommands.
// code-moniker: ignore[smell-method-size-disharmony]
export class ConnectionManager implements vscode.Disposable {
  private readonly _onChanged = new vscode.EventEmitter<void>();
  readonly onChanged = this._onChanged.event;
  private readonly _onServerChanged = new vscode.EventEmitter<void>();
  /** Fires only when the active server identity changes (not on status toggles). */
  readonly onServerChanged = this._onServerChanged.event;

  readonly store: ServerStore;
  readonly commands: ConnectionCommands;
  private readonly service: ConnectionService;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly out: vscode.OutputChannel;

  private client: Client | undefined;
  private _activeServerId: string | undefined;
  private _lastFiredServerId: string | undefined;
  private _connected = false;
  /** True after an unexpected connection loss — distinct from "never connected". */
  private _connectionLost = false;
  private _pldbgapiAvailable = false;

  constructor(context: vscode.ExtensionContext, out: vscode.OutputChannel) {
    this.out = out;
    this.store = new ServerStore(context);
    this.commands = new ConnectionCommands(this);
    this.service = new ConnectionService(out);
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.command = "postgresql-workbench.pickConnection";
    this.statusBar.show();
    this.updateStatusBar();
  }

  /** @deprecated Use `commands.addServer()` in new Extension Host code. */
  readonly addServer = (): Promise<ServerConfig | undefined> => this.commands.addServer();

  /** @deprecated Use `commands.removeServer()` in new Extension Host code. */
  readonly removeServer = (id: string): Promise<void> => this.commands.removeServer(id);

  /** @deprecated Use `commands.pickConnection()` in new Extension Host code. */
  readonly pickConnection = (): Promise<boolean> => this.commands.pickConnection();

  /** @deprecated Use `commands.editServer()` in new Extension Host code. */
  readonly editServer = (id: string): Promise<void> => this.commands.editServer(id);

  /** @deprecated Use `commands.changePassword()` in new Extension Host code. */
  readonly changePassword = (id: string): Promise<void> => this.commands.changePassword(id);

  // --- Read state ---

  get servers(): readonly ServerConfig[] {
    return this.store.getAll();
  }

  get activeServer(): ServerConfig | undefined {
    return this._activeServerId ? this.store.get(this._activeServerId) : undefined;
  }

  get isConnected(): boolean {
    return this._connected;
  }

  get pldbgapiAvailable(): boolean {
    return this._pldbgapiAvailable;
  }

  isActiveServer(id: string): boolean {
    return this._activeServerId === id && this._connected;
  }

  getClient(): Client | undefined {
    return this._connected ? this.client : undefined;
  }

  async getPassword(id: string): Promise<string> {
    return (await this.store.getPassword(id)) ?? "";
  }

  async createDedicatedClient(id: string): Promise<Client> {
    const server = this.store.get(id);
    if (!server) throw new Error("The PostgreSQL server no longer exists.");
    return this.service.connectClient({
      host: server.host,
      port: server.port,
      database: server.database,
      user: server.user,
      password: await this.getPassword(id),
      ssl: server.ssl,
    });
  }

  async setSchemaSyncOverride(id: string, override: ServerConfig["schemaSync"]): Promise<void> {
    const server = this.store.get(id);
    if (!server) throw new Error("The PostgreSQL server no longer exists.");
    await this.store.update(id, { ...server, schemaSync: override });
    this.fire();
  }

  // --- Connection ---

  async connectServer(id: string): Promise<boolean> {
    const server = this.store.get(id);
    if (!server) return false;

    let password = await this.store.getPassword(id);
    if (!password) {
      const input = await vscode.window.showInputBox({
        prompt: `Password for ${server.name}`,
        password: true,
        ignoreFocusOut: true,
      });
      if (input === undefined) return false;
      password = input;
      await this.store.setPassword(id, password);
    }

    await this.disconnectQuietly();
    this._activeServerId = undefined;
    this._connected = false;
    this._connectionLost = false;
    this._pldbgapiAvailable = false;
    await this.store.setActiveServerId(undefined);
    this.fire();

    const connected = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Connecting to ${server.name}...`,
        cancellable: true,
      },
      async (_progress, token) => {
        let result: ConnectResult;
        const connectPromise = this.service.connect({
          host: server.host,
          port: server.port,
          database: server.database,
          user: server.user,
          password,
          ssl: server.ssl,
        });
        let cancellation: vscode.Disposable | undefined;
        try {
          result = await Promise.race([
            connectPromise,
            new Promise<never>((_, reject) => {
              cancellation = token.onCancellationRequested(() => reject(new Error("cancelled")));
            }),
          ]);
        } catch (err) {
          if (token.isCancellationRequested) {
            connectPromise.then((r) => this.service.disconnect(r.client)).catch(() => {});
            this.out.appendLine(`Connection to ${server.name} cancelled.`);
            return false;
          }
          const classified = this.service.classifyError(err);
          this._connected = false;
          this._activeServerId = undefined;
          this.fire();

          const actions =
            classified.kind === "auth"
              ? ["Change Password", "Edit Server"]
              : classified.kind === "network"
                ? ["Retry", "Edit Server"]
                : ["Retry", "Edit Server"];
          const action = await vscode.window.showErrorMessage(
            `${server.name}: ${classified.message}`,
            ...actions,
          );
          if (action === "Retry") return this.connectServer(id);
          if (action === "Edit Server") {
            await this.commands.editServer(id);
          }
          if (action === "Change Password") {
            await this.commands.changePassword(id);
          }
          return false;
        } finally {
          cancellation?.dispose();
        }

        this.client = result.client;
        this._activeServerId = id;
        this._connected = true;
        this._connectionLost = false;
        this._pldbgapiAvailable = result.pldbgapiAvailable;

        result.client.on("error", (err) => {
          this.out.appendLine(`Connection lost: ${err.message}`);
          this._connected = false;
          this._connectionLost = true;
          this.fire();
          vscode.window
            .showWarningMessage(`${server.name}: connection lost.`, "Reconnect")
            .then((a) => {
              if (a === "Reconnect") void this.connectServer(id);
            });
        });

        await this.store.setActiveServerId(id);

        if (!result.pldbgapiAvailable && result.pldbgapiError.includes("not installed")) {
          const action = await vscode.window.showWarningMessage(
            `${result.pldbgapiError} Install now?`,
            "Install pldbgapi",
            "Skip",
          );
          if (action === "Install pldbgapi") {
            try {
              await this.service.installPldbgapi(result.client);
              this._pldbgapiAvailable = true;
              vscode.window.showInformationMessage("pldbgapi installed. Debugging ready.");
            } catch (err) {
              vscode.window.showErrorMessage(
                `Failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        } else if (!result.pldbgapiAvailable) {
          vscode.window
            .showWarningMessage(result.pldbgapiError, "Setup Guide", "Show Logs")
            .then((a) => {
              if (a === "Setup Guide") void showRequirementsGuide();
              if (a === "Show Logs") this.out.show();
            });
        }

        this.fire();
        return true;
      },
    );

    return connected;
  }

  async disconnect(): Promise<void> {
    await this.disconnectQuietly();
    this._activeServerId = undefined;
    this._connected = false;
    this._connectionLost = false;
    this._pldbgapiAvailable = false;
    await this.store.setActiveServerId(undefined);
    this.fire();
  }

  async tryReconnectSaved(): Promise<boolean> {
    const id = this.store.getActiveServerId();
    if (!id || !this.store.has(id)) return false;

    const server = this.store.get(id)!;
    const hasPassword = Boolean(await this.store.getPassword(id));
    if (!hasPassword) {
      this._activeServerId = id;
      this.out.appendLine(
        `Skipping auto-reconnect for ${server.name} (no saved password). Click to connect.`,
      );
      this.fire();
      return false;
    }

    this.out.appendLine(`Restoring connection to ${server.name}...`);
    return this.connectServer(id);
  }

  /** Re-run the server requirement checks on the active connection (F-EXT-11). */
  async checkRequirements(): Promise<{ available: boolean; error: string } | undefined> {
    const server = this.activeServer;
    const client = this.getClient();
    if (!server || !client) return undefined;
    const check = await this.service.checkRequirements(client, server.database);
    this._pldbgapiAvailable = check.available;
    this.fire();
    return check;
  }

  notifyConfigurationChanged(): void {
    this.fire();
  }

  async removeDatabaseContextConfiguration(id: string): Promise<void> {
    if (this._activeServerId === id) {
      await this.disconnectQuietly();
      this._activeServerId = undefined;
      this._connected = false;
      this._connectionLost = false;
      this._pldbgapiAvailable = false;
    }
    await this.store.remove(id);
    this.fire();
  }

  dispose(): void {
    this.statusBar.dispose();
    this._onChanged.dispose();
    this._onServerChanged.dispose();
    this.disconnectQuietly().catch(() => {});
  }

  // --- Private ---

  private async disconnectQuietly(): Promise<void> {
    if (this.client) {
      await this.service.disconnect(this.client);
      this.client = undefined;
    }
  }

  private fire(): void {
    this.updateStatusBar();
    vscode.commands.executeCommand("setContext", "postgresql-workbench.connected", this._connected);
    if (this._activeServerId !== this._lastFiredServerId) {
      this._lastFiredServerId = this._activeServerId;
      this._onServerChanged.fire();
    }
    this._onChanged.fire();
  }

  private updateStatusBar(): void {
    const server = this.activeServer;
    if (this._connected && server) {
      this.statusBar.text = `$(database) ${server.name}`;
      this.statusBar.backgroundColor = undefined;
      this.statusBar.tooltip = this._pldbgapiAvailable
        ? "PL/pgSQL — Connected"
        : "PL/pgSQL — No pldbgapi";
    } else if (this._connectionLost && server) {
      this.statusBar.text = `$(warning) ${server.name}: connection lost`;
      this.statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      this.statusBar.tooltip = "Connection lost — click to reconnect";
    } else {
      this.statusBar.text = "$(database) No connection";
      this.statusBar.backgroundColor = undefined;
      this.statusBar.tooltip = "Click to connect";
    }
  }
}
