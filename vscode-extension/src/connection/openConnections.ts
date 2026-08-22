import type { Client } from "pg";
import * as vscode from "vscode";
import {
  getConnectionName,
  type ServerConfig,
} from "../../../packages/catalog/src/savedConnection.js";
import { ConnectionCommands } from "./commands.js";
import { ConnectionService } from "./connectPostgres.js";
import { PostgresConnectionRegistry } from "./registry.js";
import { ServerStore } from "./savedConnections.js";

export type DebugCapabilityStatus = "unknown" | "checking" | "available" | "unavailable" | "error";

export interface DebugCapabilitySnapshot {
  readonly serverId: string;
  readonly status: DebugCapabilityStatus;
  readonly message?: string;
  readonly checkedAt?: number;
}

export interface ConnectionChange {
  readonly serverIds: readonly string[];
  readonly rootsChanged: boolean;
  /** Only the PL/pgSQL debug capability of `serverIds` changed; connectivity is unchanged. */
  readonly debugCapabilityOnly?: boolean;
}

/**
 * Orchestrates server management, connection lifecycle, status bar, and events.
 * Consumers (TreeView, ContentProvider) listen to `onChanged`.
 */
// This lifecycle facade deliberately combines tiny observable-state accessors with the atomic
// connection transition; interactive CRUD/import responsibilities live in ConnectionCommands.
// code-moniker: ignore[smell-method-size-disharmony]
export class ConnectionManager implements vscode.Disposable {
  private readonly _onChanged = new vscode.EventEmitter<ConnectionChange>();
  readonly onChanged = this._onChanged.event;
  private readonly _onServerChanged = new vscode.EventEmitter<ConnectionChange>();
  /** Compatibility event carrying the exact Connexion identities that changed. */
  readonly onServerChanged = this._onServerChanged.event;

  readonly store: ServerStore;
  readonly commands: ConnectionCommands;
  private readonly service: ConnectionService;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly out: vscode.OutputChannel;

  private readonly connections = new PostgresConnectionRegistry();
  /** Unexpected losses belong to the exact Connexion that lost its session. */
  private readonly connectionLosses = new Set<string>();
  private readonly debugCapabilities = new Map<string, DebugCapabilitySnapshot>();
  private readonly debugCapabilityEpochs = new Map<string, number>();
  private readonly connectionTransitionTails = new Map<string, Promise<void>>();
  private beforeConnectionChange?: (
    connectionId: string,
    action: string,
  ) => Promise<vscode.Disposable | undefined>;

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
  readonly pickConnection = async (): Promise<boolean> =>
    (await this.commands.pickConnection()) !== undefined;

  /** @deprecated Use `commands.editServer()` in new Extension Host code. */
  readonly editServer = (id: string): Promise<void> => this.commands.editServer(id);

  /** @deprecated Use `commands.changePassword()` in new Extension Host code. */
  readonly changePassword = (id: string): Promise<void> => this.commands.changePassword(id);

  // --- Read state ---

  get servers(): readonly ServerConfig[] {
    return this.store.getAll();
  }

  debugCapabilityFor(serverId: string): DebugCapabilitySnapshot {
    return (
      this.debugCapabilities.get(serverId) ?? {
        serverId,
        status: "unknown",
      }
    );
  }

  isServerConnected(id: string): boolean {
    return this.connections.isConnected(id);
  }

  getClient(id: string): Client | undefined {
    return this.connections.client(id);
  }

  get connectedServerIds(): readonly string[] {
    return this.connections.connectedIds;
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
    this.out.appendLine(
      `Workbench schema synchronization store update requested: server=${id} override=${JSON.stringify(override)}`,
    );
    const server = this.store.get(id);
    if (!server) throw new Error("The PostgreSQL server no longer exists.");
    await this.store.update(id, { ...server, schemaSync: override });
    this.out.appendLine(
      `Workbench schema synchronization store update complete: server=${id} override=${JSON.stringify(this.store.get(id)?.schemaSync)}`,
    );
    this.fire([id]);
  }

  // --- Connection ---

  registerBeforeConnectionChange(
    guard: (connectionId: string, action: string) => Promise<vscode.Disposable | undefined>,
  ): vscode.Disposable {
    this.beforeConnectionChange = guard;
    return new vscode.Disposable(() => {
      if (this.beforeConnectionChange === guard) this.beforeConnectionChange = undefined;
    });
  }

  async connectServer(id: string, options: { force?: boolean } = {}): Promise<boolean> {
    return this.runConnectionTransition(id, () => this.connectServerTransition(id, options));
  }

  private async connectServerTransition(
    id: string,
    options: { force?: boolean } = {},
  ): Promise<boolean> {
    const server = this.store.get(id);
    if (!server) return false;
    if (this.connections.isConnected(id) && !options.force) return true;
    return this.withConnectionChange(
      options.force && this.connections.isConnected(id) ? id : undefined,
      "reconnecting the Connexion",
      async () => {
        let password = await this.store.getPassword(id);
        if (!password) {
          const input = await vscode.window.showInputBox({
            prompt: `Password for ${getConnectionName(server)}`,
            password: true,
            ignoreFocusOut: true,
          });
          if (input === undefined) return false;
          password = input;
          await this.store.setPassword(id, password);
        }

        if (options.force && this.connections.isConnected(id)) {
          await this.disconnectServerClient(id);
          this.forgetDebugCapability(id);
          this.connectionLosses.delete(id);
          this.fire([id]);
        }

        const connected = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Connecting to ${getConnectionName(server)}...`,
            cancellable: true,
          },
          async (_progress, token) => {
            let client: Client;
            const connectPromise = this.service.connectClient({
              host: server.host,
              port: server.port,
              database: server.database,
              user: server.user,
              password,
              ssl: server.ssl,
            });
            let cancellation: vscode.Disposable | undefined;
            try {
              client = await Promise.race([
                connectPromise,
                new Promise<never>((_, reject) => {
                  cancellation = token.onCancellationRequested(() =>
                    reject(new Error("cancelled")),
                  );
                }),
              ]);
            } catch (err) {
              if (token.isCancellationRequested) {
                connectPromise
                  .then((connectedClient) => this.service.disconnect(connectedClient))
                  .catch(() => {});
                this.out.appendLine(`Connection to ${getConnectionName(server)} cancelled.`);
                return false;
              }
              const classified = this.service.classifyError(err);
              const actions =
                classified.kind === "auth"
                  ? ["Change Password", "Edit Server"]
                  : classified.kind === "network"
                    ? ["Retry", "Edit Server"]
                    : ["Retry", "Edit Server"];
              const action = await vscode.window.showErrorMessage(
                `${getConnectionName(server)}: ${classified.message}`,
                ...actions,
              );
              if (action === "Retry") return this.connectServerTransition(id);
              if (action === "Edit Server") {
                this.deferConnectionAction("Editing the Connexion", () =>
                  this.commands.editServer(id),
                );
              }
              if (action === "Change Password") {
                this.deferConnectionAction("Changing the Connexion password", () =>
                  this.commands.changePassword(id),
                );
              }
              return false;
            } finally {
              cancellation?.dispose();
            }

            await this.connections.connect(id, async () => client);
            this.connectionLosses.delete(id);

            client.on("error", (err) => {
              if (!this.connections.forget(id, client)) return;
              this.out.appendLine(`Connection lost: ${err.message}`);
              this.connectionLosses.add(id);
              this.forgetDebugCapability(id);
              this.fire([id]);
              vscode.window
                .showWarningMessage(`${getConnectionName(server)}: connection lost.`, "Reconnect")
                .then((a) => {
                  if (a === "Reconnect") void this.connectServer(id);
                });
            });

            await this.store.setConnectionOpen(id, true);
            // PostgreSQL connectivity is authoritative. Indexing and debugger capability
            // detection start independently after the connection has been published.
            this.fire([id]);
            void this.refreshDebugCapability(id);

            return true;
          },
        );

        return connected;
      },
    );
  }

  async disconnect(requestedId?: string): Promise<boolean> {
    const connectionId =
      requestedId ??
      (this.connections.connectedIds.length === 1 ? this.connections.connectedIds[0] : undefined);
    if (!connectionId) return false;
    return this.runConnectionTransition(connectionId, () => {
      this.out.appendLine(`Disconnect requested: target=${connectionId}`);
      return this.withConnectionChange(connectionId, "disconnecting the Connexion", async () => {
        const disconnected = await this.disconnectServerClient(connectionId);
        this.forgetDebugCapability(connectionId);
        this.connectionLosses.delete(connectionId);
        await this.store.setConnectionOpen(connectionId, false);
        this.fire([connectionId]);
        this.out.appendLine(`Disconnect complete: server=${connectionId}`);
        return disconnected;
      });
    });
  }

  async tryReconnectSaved(): Promise<boolean> {
    const ids = this.store.getOpenServerIds().filter((id) => this.store.has(id));
    const results = await Promise.all(
      ids.map(async (id) => {
        const server = this.store.get(id)!;
        if (!(await this.store.getPassword(id))) {
          this.out.appendLine(
            `Skipping auto-reconnect for ${getConnectionName(server)} (no saved password). Click to connect.`,
          );
          this.fire([id]);
          return false;
        }
        this.out.appendLine(`Restoring connection to ${getConnectionName(server)}...`);
        return this.connectServer(id);
      }),
    );
    return results.some(Boolean);
  }

  /** Re-run the server requirement checks for one exact Connexion (F-EXT-11). */
  async checkRequirements(
    serverId: string,
  ): Promise<{ available: boolean; error: string } | undefined> {
    return this.refreshDebugCapability(serverId);
  }

  async refreshDebugCapability(
    requestedServerId?: string,
  ): Promise<{ available: boolean; error: string } | undefined> {
    const serverId = requestedServerId;
    const server = serverId ? this.store.get(serverId) : undefined;
    if (!server) return undefined;
    const epoch = (this.debugCapabilityEpochs.get(server.id) ?? 0) + 1;
    this.debugCapabilityEpochs.set(server.id, epoch);
    this.setDebugCapability({ serverId: server.id, status: "checking" });
    const sharedClient = this.getClient(server.id);
    let client: Client | undefined = sharedClient;
    try {
      client ??= await this.createDedicatedClient(server.id);
      const check = await this.service.checkRequirements(client, server.database);
      if (this.debugCapabilityEpochs.get(server.id) !== epoch || !this.store.has(server.id)) {
        return undefined;
      }
      this.setDebugCapability({
        serverId: server.id,
        status: check.available ? "available" : "unavailable",
        ...(check.error ? { message: check.error } : {}),
        checkedAt: Date.now(),
      });
      return check;
    } catch (error) {
      if (this.debugCapabilityEpochs.get(server.id) !== epoch || !this.store.has(server.id)) {
        return undefined;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.setDebugCapability({
        serverId: server.id,
        status: "error",
        message,
        checkedAt: Date.now(),
      });
      this.out.appendLine(
        `Debugger capability detection failed for ${getConnectionName(server)}: ${message}`,
      );
      return {
        available: false,
        error: message,
      };
    } finally {
      if (client && client !== sharedClient) await this.service.disconnect(client);
    }
  }

  notifyConfigurationChanged(id?: string): void {
    this.fire(id ? [id] : [], id === undefined);
  }

  async removeConnectionConfiguration(id: string): Promise<boolean> {
    return this.runConnectionTransition(id, () =>
      this.withConnectionChange(id, "removing the Connexion", async () => {
        await this.disconnectServerClient(id);
        await this.store.setConnectionOpen(id, false);
        this.connectionLosses.delete(id);
        this.forgetDebugCapability(id);
        await this.store.remove(id);
        this.fire([id], true);
        return true;
      }),
    );
  }

  async replaceConnectionConfiguration(
    id: string,
    replacement: ServerConfig,
    password: string,
  ): Promise<boolean> {
    return this.runConnectionTransition(id, () =>
      this.withConnectionChange(id, "replacing the Connexion", async () => {
        await this.disconnectServerClient(id);
        await this.store.setConnectionOpen(id, false);
        this.connectionLosses.delete(id);
        this.forgetDebugCapability(id);
        await this.store.update(id, replacement, password);
        this.fire([id, replacement.id], true);
        return true;
      }),
    );
  }

  dispose(): void {
    this.statusBar.dispose();
    this._onChanged.dispose();
    this._onServerChanged.dispose();
    void this.connections.dispose((client) => this.service.disconnect(client));
  }

  // --- Private ---

  private disconnectServerClient(id: string): Promise<boolean> {
    return this.connections.disconnect(id, (client) => this.service.disconnect(client));
  }

  private runConnectionTransition<T>(id: string, transition: () => Promise<T>): Promise<T> {
    const tail = this.connectionTransitionTails.get(id) ?? Promise.resolve();
    const result = tail.catch(() => {}).then(transition);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.connectionTransitionTails.set(id, settled);
    void settled.finally(() => {
      if (this.connectionTransitionTails.get(id) === settled) {
        this.connectionTransitionTails.delete(id);
      }
    });
    return result;
  }

  private deferConnectionAction(description: string, action: () => Promise<void>): void {
    void action().catch((error) => {
      const message = `${description} failed: ${error instanceof Error ? error.message : String(error)}`;
      this.out.appendLine(message);
      void vscode.window.showErrorMessage(message);
    });
  }

  private async withConnectionChange<T>(
    connectionId: string | undefined,
    action: string,
    change: () => Promise<T>,
  ): Promise<T | false> {
    if (!connectionId) return change();
    const lease = this.beforeConnectionChange
      ? await this.beforeConnectionChange(connectionId, action)
      : new vscode.Disposable(() => {});
    if (!lease) return false;
    try {
      return await change();
    } finally {
      lease.dispose();
    }
  }

  private fire(
    serverIds: readonly string[] = [],
    rootsChanged = false,
    debugCapabilityOnly = false,
  ): void {
    this.updateStatusBar();
    vscode.commands.executeCommand(
      "setContext",
      "postgresql-workbench.connected",
      this.connections.connectedIds.length > 0,
    );
    vscode.commands.executeCommand(
      "setContext",
      "postgresql-workbench.debugAvailable",
      this.connections.connectedIds.some(
        (id) => this.debugCapabilityFor(id).status === "available",
      ),
    );
    const change: ConnectionChange = {
      serverIds: [...new Set(serverIds)],
      rootsChanged,
      ...(debugCapabilityOnly ? { debugCapabilityOnly } : {}),
    };
    this._onServerChanged.fire(change);
    this._onChanged.fire(change);
  }

  private updateStatusBar(): void {
    const connected = this.connections.connectedIds
      .map((id) => this.store.get(id))
      .filter((server): server is ServerConfig => server !== undefined);
    if (connected.length === 1) {
      const server = connected[0];
      this.statusBar.text = `$(pass-filled) ${getConnectionName(server)}`;
      this.statusBar.backgroundColor = undefined;
      const debug = this.debugCapabilityFor(server.id);
      this.statusBar.tooltip =
        debug.status === "available"
          ? "PL/pgSQL — Connected · debugging available"
          : debug.status === "checking"
            ? "PL/pgSQL — Connected · checking debugger capability"
            : "PL/pgSQL — Connected · debugging unavailable";
    } else if (connected.length > 1) {
      this.statusBar.text = `$(pass-filled) ${connected.length} Connexions`;
      this.statusBar.backgroundColor = undefined;
      this.statusBar.tooltip = connected.map(getConnectionName).join("\n");
    } else {
      this.statusBar.text = "$(database) No Connexion";
      this.statusBar.backgroundColor = undefined;
      this.statusBar.tooltip = "Click to connect";
    }
  }

  private setDebugCapability(snapshot: DebugCapabilitySnapshot): void {
    this.debugCapabilities.set(snapshot.serverId, snapshot);
    this.fire([snapshot.serverId], false, true);
  }

  private forgetDebugCapability(serverId: string): void {
    this.debugCapabilityEpochs.set(serverId, (this.debugCapabilityEpochs.get(serverId) ?? 0) + 1);
    this.debugCapabilities.delete(serverId);
  }
}
