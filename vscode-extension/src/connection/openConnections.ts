import type { Client } from "pg";
import * as vscode from "vscode";
import {
  type ConnectionConfig,
  getConnectionName,
} from "../../../packages/catalog/src/savedConnection.js";
import { ConnectionCommands } from "./commands.js";
import { type ConnectionError, ConnectionService } from "./connectPostgres.js";
import { PostgresConnectionRegistry } from "./registry.js";
import { ConnectionStore } from "./savedConnections.js";

export type DebugCapabilityStatus = "unknown" | "checking" | "available" | "unavailable" | "error";

export interface DebugCapabilitySnapshot {
  readonly connectionId: string;
  readonly status: DebugCapabilityStatus;
  readonly message?: string;
  readonly checkedAt?: number;
}

export interface ConnectionChange {
  readonly connectionIds: readonly string[];
  readonly rootsChanged: boolean;
  /** Only the PL/pgSQL debug capability of `connectionIds` changed; connectivity is unchanged. */
  readonly debugCapabilityOnly?: boolean;
}

/**
 * Orchestrates connection management, connection lifecycle, status bar, and events.
 * Consumers (TreeView, ContentProvider) listen to `onChanged`.
 */
// This lifecycle facade deliberately combines tiny observable-state accessors with the atomic
// connection transition; interactive CRUD/import responsibilities live in ConnectionCommands.
// code-moniker: ignore[smell-method-size-disharmony]
export class ConnectionManager implements vscode.Disposable {
  private readonly _onChanged = new vscode.EventEmitter<ConnectionChange>();
  readonly onChanged = this._onChanged.event;
  private readonly _onConnectionChanged = new vscode.EventEmitter<ConnectionChange>();
  /** Compatibility event carrying the exact Connection identities that changed. */
  readonly onConnectionChanged = this._onConnectionChanged.event;

  readonly store: ConnectionStore;
  readonly commands: ConnectionCommands;
  private readonly service: ConnectionService;
  private readonly statusBar: vscode.StatusBarItem;
  private readonly out: vscode.OutputChannel;

  private readonly connectionRegistry = new PostgresConnectionRegistry();
  /** Unexpected losses belong to the exact Connection that lost its session. */
  private readonly connectionLosses = new Set<string>();
  private readonly debugCapabilities = new Map<string, DebugCapabilitySnapshot>();
  private readonly debugCapabilityEpochs = new Map<string, number>();
  private readonly connectionTransitionTails = new Map<string, Promise<void>>();
  private readonly pendingRecoveryNotifications = new Set<string>();
  private beforeConnectionChange?: (
    connectionId: string,
    action: string,
  ) => Promise<vscode.Disposable | undefined>;

  constructor(context: vscode.ExtensionContext, out: vscode.OutputChannel) {
    this.out = out;
    this.store = new ConnectionStore(context);
    this.commands = new ConnectionCommands(this);
    this.service = new ConnectionService(out);
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.command = "postgresql-workbench.pickConnection";
    this.statusBar.show();
    this.updateStatusBar();
  }

  // --- Read state ---

  get connections(): readonly ConnectionConfig[] {
    return this.store.getAll();
  }

  debugCapabilityFor(connectionId: string): DebugCapabilitySnapshot {
    return (
      this.debugCapabilities.get(connectionId) ?? {
        connectionId,
        status: "unknown",
      }
    );
  }

  isConnectionConnected(id: string): boolean {
    return this.connectionRegistry.isConnected(id);
  }

  getClient(id: string): Client | undefined {
    return this.connectionRegistry.client(id);
  }

  get connectedConnectionIds(): readonly string[] {
    return this.connectionRegistry.connectedIds;
  }

  async getPassword(id: string): Promise<string> {
    return (await this.store.getPassword(id)) ?? "";
  }

  async createDedicatedClient(id: string): Promise<Client> {
    const connection = this.store.get(id);
    if (!connection) throw new Error("The PostgreSQL connection no longer exists.");
    return this.service.connectClient({
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.user,
      password: await this.getPassword(id),
      ssl: connection.ssl,
    });
  }

  async setSchemaSyncOverride(id: string, override: ConnectionConfig["schemaSync"]): Promise<void> {
    this.out.appendLine(
      `Workbench schema synchronization store update requested: connection=${id} override=${JSON.stringify(override)}`,
    );
    const connection = this.store.get(id);
    if (!connection) throw new Error("The PostgreSQL connection no longer exists.");
    await this.store.update(id, { ...connection, schemaSync: override });
    this.out.appendLine(
      `Workbench schema synchronization store update complete: connection=${id} override=${JSON.stringify(this.store.get(id)?.schemaSync)}`,
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

  async connectConnection(id: string, options: { force?: boolean } = {}): Promise<boolean> {
    return this.runConnectionTransition(id, () => this.connectConnectionTransition(id, options));
  }

  private async connectConnectionTransition(
    id: string,
    options: { force?: boolean } = {},
  ): Promise<boolean> {
    const connection = this.store.get(id);
    if (!connection) return false;
    if (this.connectionRegistry.isConnected(id) && !options.force) return true;
    return this.withConnectionChange(
      options.force && this.connectionRegistry.isConnected(id) ? id : undefined,
      "reconnecting the Connection",
      async () => {
        let password = await this.store.getPassword(id);
        if (!password) {
          const input = await vscode.window.showInputBox({
            prompt: `Password for ${getConnectionName(connection)}`,
            password: true,
            ignoreFocusOut: true,
          });
          if (input === undefined) return false;
          password = input;
          await this.store.setPassword(id, password);
        }

        if (options.force && this.connectionRegistry.isConnected(id)) {
          await this.disconnectConnectionClient(id);
          this.forgetDebugCapability(id);
          this.connectionLosses.delete(id);
          this.fire([id]);
        }

        let failure: ConnectionError | undefined;
        const connected = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Connecting to ${getConnectionName(connection)}...`,
            cancellable: true,
          },
          async (_progress, token) => {
            let client: Client;
            const connectPromise = this.service.connectClient({
              host: connection.host,
              port: connection.port,
              database: connection.database,
              user: connection.user,
              password,
              ssl: connection.ssl,
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
                this.out.appendLine(`Connection to ${getConnectionName(connection)} cancelled.`);
                return false;
              }
              failure = this.service.classifyError(err);
              return false;
            } finally {
              cancellation?.dispose();
            }

            await this.connectionRegistry.connect(id, async () => client);
            this.connectionLosses.delete(id);

            client.on("error", (err) => {
              if (!this.connectionRegistry.forget(id, client)) return;
              this.out.appendLine(`Connection lost: ${err.message}`);
              this.connectionLosses.add(id);
              this.forgetDebugCapability(id);
              this.fire([id]);
              vscode.window
                .showWarningMessage(
                  `${getConnectionName(connection)}: connection lost.`,
                  "Reconnect",
                )
                .then((a) => {
                  if (a === "Reconnect") void this.connectConnection(id);
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

        const classifiedFailure = failure;
        if (classifiedFailure) {
          const actions =
            classifiedFailure.kind === "auth"
              ? ["Change Password", "Edit Connection"]
              : ["Retry", "Edit Connection"];
          this.pendingRecoveryNotifications.add(id);
          this.deferConnectionAction("Handling the Connection error", async () => {
            let action: string | undefined;
            try {
              action = await vscode.window.showErrorMessage(
                `${getConnectionName(connection)}: ${classifiedFailure.message}`,
                ...actions,
              );
            } finally {
              this.pendingRecoveryNotifications.delete(id);
            }
            if (action === "Retry") await this.connectConnection(id);
            if (action === "Edit Connection") {
              await this.commands.editConnection(id, { connect: true });
            }
            if (action === "Change Password") await this.commands.changePassword(id);
          });
        }

        return connected;
      },
    );
  }

  async disconnect(requestedId?: string): Promise<boolean> {
    const connectionId =
      requestedId ??
      (this.connectionRegistry.connectedIds.length === 1
        ? this.connectionRegistry.connectedIds[0]
        : undefined);
    if (!connectionId) return false;
    return this.runConnectionTransition(connectionId, () => {
      this.out.appendLine(`Disconnect requested: target=${connectionId}`);
      return this.withConnectionChange(connectionId, "disconnecting the Connection", async () => {
        const disconnected = await this.disconnectConnectionClient(connectionId);
        this.forgetDebugCapability(connectionId);
        this.connectionLosses.delete(connectionId);
        await this.store.setConnectionOpen(connectionId, false);
        this.fire([connectionId]);
        this.out.appendLine(`Disconnect complete: connection=${connectionId}`);
        return disconnected;
      });
    });
  }

  async tryReconnectSaved(): Promise<boolean> {
    const ids = this.store.getOpenConnectionIds().filter((id) => this.store.has(id));
    const results = await Promise.all(
      ids.map(async (id) => {
        const connection = this.store.get(id)!;
        if (!(await this.store.getPassword(id))) {
          this.out.appendLine(
            `Skipping auto-reconnect for ${getConnectionName(connection)} (no saved password). Click to connect.`,
          );
          this.fire([id]);
          return false;
        }
        this.out.appendLine(`Restoring connection to ${getConnectionName(connection)}...`);
        return this.connectConnection(id);
      }),
    );
    return results.some(Boolean);
  }

  /** Re-run the connection requirement checks for one exact Connection (F-EXT-11). */
  async checkRequirements(
    connectionId: string,
  ): Promise<{ available: boolean; error: string } | undefined> {
    return this.refreshDebugCapability(connectionId);
  }

  async refreshDebugCapability(
    requestedConnectionId?: string,
  ): Promise<{ available: boolean; error: string } | undefined> {
    const connectionId = requestedConnectionId;
    const connection = connectionId ? this.store.get(connectionId) : undefined;
    if (!connection) return undefined;
    const epoch = (this.debugCapabilityEpochs.get(connection.id) ?? 0) + 1;
    this.debugCapabilityEpochs.set(connection.id, epoch);
    this.setDebugCapability({ connectionId: connection.id, status: "checking" });
    const sharedClient = this.getClient(connection.id);
    let client: Client | undefined = sharedClient;
    try {
      client ??= await this.createDedicatedClient(connection.id);
      const check = await this.service.checkRequirements(client, connection.database);
      if (
        this.debugCapabilityEpochs.get(connection.id) !== epoch ||
        !this.store.has(connection.id)
      ) {
        return undefined;
      }
      this.setDebugCapability({
        connectionId: connection.id,
        status: check.available ? "available" : "unavailable",
        ...(check.error ? { message: check.error } : {}),
        checkedAt: Date.now(),
      });
      return check;
    } catch (error) {
      if (
        this.debugCapabilityEpochs.get(connection.id) !== epoch ||
        !this.store.has(connection.id)
      ) {
        return undefined;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.setDebugCapability({
        connectionId: connection.id,
        status: "error",
        message,
        checkedAt: Date.now(),
      });
      this.out.appendLine(
        `Debugger capability detection failed for ${getConnectionName(connection)}: ${message}`,
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
      this.withConnectionChange(id, "removing the Connection", async () => {
        await this.disconnectConnectionClient(id);
        await this.store.setConnectionOpen(id, false);
        this.connectionLosses.delete(id);
        this.forgetDebugCapability(id);
        await this.store.remove(id);
        this.fire([id], true);
        if (this.pendingRecoveryNotifications.delete(id)) {
          // VS Code does not expose a disposable for one showErrorMessage notification. Hiding
          // toasts closes its obsolete recovery actions without clearing notification history.
          await vscode.commands.executeCommand("notifications.hideToasts");
        }
        return true;
      }),
    );
  }

  async replaceConnectionConfiguration(
    id: string,
    replacement: ConnectionConfig,
    password: string,
  ): Promise<boolean> {
    return this.runConnectionTransition(id, () =>
      this.withConnectionChange(id, "replacing the Connection", async () => {
        await this.disconnectConnectionClient(id);
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
    this._onConnectionChanged.dispose();
    void this.connectionRegistry.dispose((client) => this.service.disconnect(client));
  }

  // --- Private ---

  private disconnectConnectionClient(id: string): Promise<boolean> {
    return this.connectionRegistry.disconnect(id, (client) => this.service.disconnect(client));
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
    connectionIds: readonly string[] = [],
    rootsChanged = false,
    debugCapabilityOnly = false,
  ): void {
    this.updateStatusBar();
    vscode.commands.executeCommand(
      "setContext",
      "postgresql-workbench.connected",
      this.connectionRegistry.connectedIds.length > 0,
    );
    const change: ConnectionChange = {
      connectionIds: [...new Set(connectionIds)],
      rootsChanged,
      ...(debugCapabilityOnly ? { debugCapabilityOnly } : {}),
    };
    this._onConnectionChanged.fire(change);
    this._onChanged.fire(change);
  }

  private updateStatusBar(): void {
    const connected = this.connectionRegistry.connectedIds
      .map((id) => this.store.get(id))
      .filter((connection): connection is ConnectionConfig => connection !== undefined);
    if (connected.length === 1) {
      const connection = connected[0];
      this.statusBar.text = `$(pass-filled) ${getConnectionName(connection)}`;
      this.statusBar.backgroundColor = undefined;
      const debug = this.debugCapabilityFor(connection.id);
      this.statusBar.tooltip =
        debug.status === "available"
          ? "PL/pgSQL — Connected · debugging available"
          : debug.status === "checking"
            ? "PL/pgSQL — Connected · checking debugger capability"
            : "PL/pgSQL — Connected · debugging unavailable";
    } else if (connected.length > 1) {
      this.statusBar.text = `$(pass-filled) ${connected.length} Connections`;
      this.statusBar.backgroundColor = undefined;
      this.statusBar.tooltip = connected.map(getConnectionName).join("\n");
    } else {
      this.statusBar.text = "$(database) No Connection";
      this.statusBar.backgroundColor = undefined;
      this.statusBar.tooltip = "Click to connect";
    }
  }

  private setDebugCapability(snapshot: DebugCapabilitySnapshot): void {
    this.debugCapabilities.set(snapshot.connectionId, snapshot);
    this.fire([snapshot.connectionId], false, true);
  }

  private forgetDebugCapability(connectionId: string): void {
    this.debugCapabilityEpochs.set(
      connectionId,
      (this.debugCapabilityEpochs.get(connectionId) ?? 0) + 1,
    );
    this.debugCapabilities.delete(connectionId);
  }
}
