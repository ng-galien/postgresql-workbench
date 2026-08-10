import type { Client, Notification } from "pg";
import * as vscode from "vscode";
import {
  buildWorkbenchDdlProvisioningSql,
  buildWorkbenchDdlRemovalSql,
  coalescePostgresDdlNotifications,
  type PostgresDdlNotification,
  parsePostgresDdlNotification,
  validateSupportSchema,
  WORKBENCH_DDL_CHANNEL,
  workbenchDdlProvisioningStatusSql,
} from "../../src/workbench/postgresDdlSync.js";
import type { ConnectionManager } from "./connectionManager.js";
import type { ServerConfig } from "./serverStore.js";
import {
  classifyWorkbenchDdlSyncFailure,
  resolveWorkbenchDdlSyncConfiguration,
  type WorkbenchDdlSyncConfiguration,
} from "./workbenchDdlSyncConfiguration.js";
import type { WorkbenchIndexController } from "./workbenchIndexController.js";

export type WorkbenchDdlSyncStatus =
  | "disabled"
  | "provisioning-required"
  | "listening"
  | "insufficient-privilege"
  | "unavailable"
  | "desynchronized";

export interface WorkbenchDdlSyncState {
  serverId: string;
  status: WorkbenchDdlSyncStatus;
  supportSchema: string;
  message?: string;
}

interface ListenerRuntime {
  client: Client;
  supportSchema: string;
  databaseOid: number;
  notifications: PostgresDdlNotification[];
  flushTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
}

// DDL sync is one per-context listener state machine; its private transitions intentionally share
// lifecycle state so splitting the type would fragment ownership of reconnect and stale state.
// code-moniker: ignore[smell-large-class]
export class WorkbenchDdlSyncController implements vscode.Disposable {
  private readonly stateEmitter = new vscode.EventEmitter<WorkbenchDdlSyncState>();
  readonly onDidChangeState = this.stateEmitter.event;
  private readonly states = new Map<string, WorkbenchDdlSyncState>();
  private readonly listeners = new Map<string, ListenerRuntime>();
  private readonly starts = new Map<string, Promise<void>>();
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly needsFullRefresh = new Set<string>();
  private readonly activeRefreshes = new Set<string>();
  private readonly subscriptions: vscode.Disposable[];
  private disposed = false;

  constructor(
    private readonly connections: ConnectionManager,
    private readonly index: WorkbenchIndexController,
    private readonly output: vscode.OutputChannel,
  ) {
    this.subscriptions = [
      connections.onChanged(() => this.reconcile()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("postgresql-workbench.workbench.schemaSync")) {
          void this.restartAll();
        }
      }),
    ];
    this.reconcile();
  }

  state(serverId: string): WorkbenchDdlSyncState {
    const server = this.connections.store.get(serverId);
    const supportSchema = server ? this.configuration(server).supportSchema : "workbench";
    return (
      this.states.get(serverId) ?? {
        serverId,
        status: server && this.configuration(server).enabled ? "unavailable" : "disabled",
        supportSchema,
      }
    );
  }

  configuration(server: ServerConfig): WorkbenchDdlSyncConfiguration {
    const settings = vscode.workspace.getConfiguration("postgresql-workbench.workbench.schemaSync");
    return resolveWorkbenchDdlSyncConfiguration(server, {
      enabled: settings.get<boolean>("enabled", false),
      supportSchema: validateSupportSchema(settings.get<string>("supportSchema", "workbench")),
    });
  }

  async setConnectionEnabled(serverId: string, enabled: boolean | undefined): Promise<void> {
    const server = this.requireServer(serverId);
    const schemaSync = {
      ...server.schemaSync,
      enabled,
    };
    if (schemaSync.enabled === undefined && schemaSync.supportSchema === undefined) {
      await this.connections.setSchemaSyncOverride(serverId, undefined);
    } else {
      await this.connections.setSchemaSyncOverride(serverId, schemaSync);
    }
  }

  async setConnectionSupportSchema(
    serverId: string,
    supportSchema: string | undefined,
  ): Promise<void> {
    const server = this.requireServer(serverId);
    const schemaSync = {
      ...server.schemaSync,
      supportSchema: supportSchema === undefined ? undefined : validateSupportSchema(supportSchema),
    };
    if (schemaSync.enabled === undefined && schemaSync.supportSchema === undefined) {
      await this.connections.setSchemaSyncOverride(serverId, undefined);
    } else {
      await this.connections.setSchemaSyncOverride(serverId, schemaSync);
    }
  }

  async provision(serverId: string): Promise<void> {
    const server = this.requireServer(serverId);
    const configuration = this.configuration(server);
    if (!configuration.enabled) {
      throw new Error("Enable schema synchronization for this DatabaseContext first");
    }
    await this.stopListener(serverId);
    const client = await this.connections.createDedicatedClient(serverId);
    try {
      await client.query(buildWorkbenchDdlProvisioningSql(configuration.supportSchema));
      this.output.appendLine(
        `Workbench schema synchronization provisioned on ${server.name} using schema ${configuration.supportSchema}`,
      );
    } catch (error) {
      this.setFailureState(server, configuration.supportSchema, error);
      throw error;
    } finally {
      await client.end().catch(() => undefined);
    }
    await this.startServer(server);
  }

  async removeProvisioning(serverId: string): Promise<void> {
    const server = this.requireServer(serverId);
    const configuration = this.configuration(server);
    await this.stopListener(serverId);
    const client = await this.connections.createDedicatedClient(serverId);
    try {
      await client.query(buildWorkbenchDdlRemovalSql(configuration.supportSchema));
      this.index.markDatabaseStale(
        server.id,
        server.database,
        "Schema synchronization provisioning was removed",
      );
      this.setState({
        serverId,
        supportSchema: configuration.supportSchema,
        status: configuration.enabled ? "provisioning-required" : "disabled",
        message: "Database-level event triggers and Workbench notification functions removed",
      });
    } catch (error) {
      this.index.markDatabaseStale(
        server.id,
        server.database,
        "Schema synchronization removal failed after the listener stopped",
      );
      this.setFailureState(server, configuration.supportSchema, error);
      throw error;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const serverId of [...this.listeners.keys()]) void this.stopListener(serverId);
    this.stateEmitter.dispose();
  }

  private reconcile(): void {
    if (this.disposed) return;
    const serverIds = new Set(this.connections.servers.map((server) => server.id));
    for (const serverId of [...this.listeners.keys()]) {
      if (!serverIds.has(serverId)) void this.stopListener(serverId);
    }
    for (const server of this.connections.servers) {
      let configuration: WorkbenchDdlSyncConfiguration;
      try {
        configuration = this.configuration(server);
      } catch (error) {
        this.index.markDatabaseStale(
          server.id,
          server.database,
          "Schema synchronization configuration is invalid",
        );
        this.setState({
          serverId: server.id,
          supportSchema: server.schemaSync?.supportSchema ?? "workbench",
          status: "unavailable",
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (!configuration.enabled) {
        void this.stopListener(server.id);
        this.setState({
          serverId: server.id,
          supportSchema: configuration.supportSchema,
          status: "disabled",
        });
        continue;
      }
      const listener = this.listeners.get(server.id);
      if (listener && listener.supportSchema !== configuration.supportSchema) {
        void this.restartServer(server.id);
      } else if (!listener && !this.reconnectTimers.has(server.id)) {
        const state = this.states.get(server.id);
        if (
          state?.status !== "provisioning-required" ||
          state.supportSchema !== configuration.supportSchema
        ) {
          void this.startServer(server);
        }
      } else if (
        listener &&
        this.connections.isActiveServer(server.id) &&
        this.index.isDatabaseStale(server.id, server.database) &&
        !this.activeRefreshes.has(server.id)
      ) {
        this.activeRefreshes.add(server.id);
        void this.refreshActive(
          server,
          [],
          "DatabaseContext became active after schema changes while inactive",
        ).finally(() => this.activeRefreshes.delete(server.id));
      }
    }
  }

  private async restartAll(): Promise<void> {
    for (const server of this.connections.servers) await this.stopListener(server.id);
    this.reconcile();
  }

  private async restartServer(serverId: string): Promise<void> {
    await this.stopListener(serverId);
    const server = this.connections.store.get(serverId);
    if (server) await this.startServer(server);
  }

  private startServer(server: ServerConfig): Promise<void> {
    if (this.disposed || this.listeners.has(server.id)) return Promise.resolve();
    const existing = this.starts.get(server.id);
    if (existing) return existing;
    const start = this.startServerOnce(server).finally(() => {
      if (this.starts.get(server.id) === start) {
        this.starts.delete(server.id);
        queueMicrotask(() => this.reconcile());
      }
    });
    this.starts.set(server.id, start);
    return start;
  }

  private async startServerOnce(server: ServerConfig): Promise<void> {
    const configuration = this.configuration(server);
    if (!configuration.enabled) return;
    let client: Client | undefined;
    try {
      client = await this.connections.createDedicatedClient(server.id);
      if (!this.startStillRequired(server.id, configuration.supportSchema)) {
        await client.end().catch(() => undefined);
        return;
      }
      const result = await client.query(
        workbenchDdlProvisioningStatusSql(configuration.supportSchema),
      );
      const status = result.rows[0] as Record<string, unknown> | undefined;
      const provisioned =
        status?.schema_exists === true &&
        status.ddl_function_exists === true &&
        status.drop_function_exists === true &&
        status.ddl_trigger_exists === true &&
        status.drop_trigger_exists === true;
      if (!provisioned) {
        await client.end();
        this.index.markDatabaseStale(
          server.id,
          server.database,
          "Schema synchronization requires explicit database provisioning",
        );
        this.setState({
          serverId: server.id,
          supportSchema: configuration.supportSchema,
          status: "provisioning-required",
          message: `Confirm provisioning to create database-level event triggers and functions in ${configuration.supportSchema}`,
        });
        return;
      }
      const databaseOid = Number(status?.database_oid);
      if (!Number.isSafeInteger(databaseOid) || databaseOid < 1) {
        throw new Error("PostgreSQL did not return a valid database OID");
      }
      await client.query(`LISTEN ${WORKBENCH_DDL_CHANNEL}`);
      if (!this.startStillRequired(server.id, configuration.supportSchema)) {
        await client.end().catch(() => undefined);
        return;
      }
      const runtime: ListenerRuntime = {
        client,
        supportSchema: configuration.supportSchema,
        databaseOid,
        notifications: [],
        closed: false,
      };
      this.listeners.set(server.id, runtime);
      client.on("notification", (notification) =>
        this.onNotification(server, runtime, notification),
      );
      client.on("error", (error) => this.onListenerClosed(server, runtime, error));
      client.on("end", () => this.onListenerClosed(server, runtime));
      this.setState({
        serverId: server.id,
        supportSchema: configuration.supportSchema,
        status: "listening",
        message: `Listening for structural DDL on ${server.database}`,
      });
      if (this.needsFullRefresh.has(server.id)) {
        this.index.markDatabaseStale(
          server.id,
          server.database,
          "Schema synchronization resumed after a listener gap",
        );
        if (this.connections.isActiveServer(server.id)) {
          await this.refreshActive(server, [], "listener reconnected after a notification gap");
        }
      }
    } catch (error) {
      if (client) await client.end().catch(() => undefined);
      if (!this.startStillRequired(server.id, configuration.supportSchema)) return;
      this.index.markDatabaseStale(
        server.id,
        server.database,
        "Schema synchronization listener is unavailable",
      );
      const status = this.setFailureState(server, configuration.supportSchema, error);
      if (status === "unavailable") this.scheduleReconnect(server.id);
    }
  }

  private onNotification(
    server: ServerConfig,
    runtime: ListenerRuntime,
    notification: Notification,
  ): void {
    if (notification.channel !== WORKBENCH_DDL_CHANNEL || !notification.payload) return;
    try {
      const parsed = parsePostgresDdlNotification(notification.payload);
      if (parsed.databaseOid !== runtime.databaseOid) {
        throw new Error("DDL notification belongs to another PostgreSQL database");
      }
      runtime.notifications.push(parsed);
      if (runtime.flushTimer) clearTimeout(runtime.flushTimer);
      runtime.flushTimer = setTimeout(() => void this.flushNotifications(server, runtime), 100);
    } catch (error) {
      this.needsFullRefresh.add(server.id);
      this.index.markDatabaseStale(
        server.id,
        server.database,
        `Unusable DDL notification: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.setState({
        serverId: server.id,
        supportSchema: runtime.supportSchema,
        status: "desynchronized",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async flushNotifications(server: ServerConfig, runtime: ListenerRuntime): Promise<void> {
    runtime.flushTimer = undefined;
    const pending = runtime.notifications.splice(0);
    for (const group of coalescePostgresDdlNotifications(pending)) {
      this.index.markDatabaseStale(
        server.id,
        server.database,
        `PostgreSQL schema changed in transaction ${group.transactionId}`,
      );
      if (!this.connections.isActiveServer(server.id)) continue;
      const reason = group.fallback
        ? group.reasons.join(", ") || "DDL notification requested a full refresh"
        : undefined;
      try {
        await this.refreshActive(server, group.objects, reason);
      } catch (error) {
        this.output.appendLine(
          `Workbench schema synchronization failed for ${server.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.onListenerClosed(
          server,
          runtime,
          error instanceof Error ? error : new Error(String(error)),
        );
        break;
      }
    }
  }

  private async refreshActive(
    server: ServerConfig,
    objects: Parameters<WorkbenchIndexController["synchronizeActiveDatabaseDdl"]>[2],
    fallbackReason?: string,
  ): Promise<void> {
    const requiresFullRefresh = this.needsFullRefresh.has(server.id);
    const effectiveFallbackReason =
      fallbackReason ??
      (requiresFullRefresh ? "schema listener missed or rejected a DDL notification" : undefined);
    const client = await this.connections.createDedicatedClient(server.id);
    try {
      await this.index.synchronizeActiveDatabaseDdl(
        {
          async query(sql: string) {
            const result = await client.query(sql);
            return { rows: result.rows as Record<string, unknown>[] };
          },
        },
        { serverId: server.id, database: server.database },
        objects,
        effectiveFallbackReason,
      );
      if (requiresFullRefresh) this.needsFullRefresh.delete(server.id);
      const runtime = this.listeners.get(server.id);
      if (runtime) {
        this.setState({
          serverId: server.id,
          supportSchema: runtime.supportSchema,
          status: "listening",
          message: `Listening for structural DDL on ${server.database}`,
        });
      }
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private onListenerClosed(server: ServerConfig, runtime: ListenerRuntime, error?: Error): void {
    if (runtime.closed || this.disposed) return;
    runtime.closed = true;
    if (runtime.flushTimer) clearTimeout(runtime.flushTimer);
    this.listeners.delete(server.id);
    void runtime.client.end().catch(() => undefined);
    this.needsFullRefresh.add(server.id);
    this.index.markDatabaseStale(
      server.id,
      server.database,
      "PostgreSQL schema listener disconnected; freshness is unknown",
    );
    this.setState({
      serverId: server.id,
      supportSchema: runtime.supportSchema,
      status: "desynchronized",
      message: error?.message ?? "PostgreSQL schema listener disconnected",
    });
    this.scheduleReconnect(server.id);
  }

  private scheduleReconnect(serverId: string): void {
    if (this.disposed || this.reconnectTimers.has(serverId)) return;
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(serverId);
      const server = this.connections.store.get(serverId);
      if (server) void this.startServer(server);
    }, 2_000);
    this.reconnectTimers.set(serverId, timer);
  }

  private async stopListener(serverId: string): Promise<void> {
    const timer = this.reconnectTimers.get(serverId);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(serverId);
    const runtime = this.listeners.get(serverId);
    if (!runtime) return;
    runtime.closed = true;
    if (runtime.flushTimer) clearTimeout(runtime.flushTimer);
    this.listeners.delete(serverId);
    await runtime.client.end().catch(() => undefined);
  }

  private setFailureState(
    server: ServerConfig,
    supportSchema: string,
    error: unknown,
  ): "insufficient-privilege" | "unavailable" {
    const status = classifyWorkbenchDdlSyncFailure(error);
    this.setState({
      serverId: server.id,
      supportSchema,
      status,
      message: error instanceof Error ? error.message : String(error),
    });
    return status;
  }

  private setState(state: WorkbenchDdlSyncState): void {
    const previous = this.states.get(state.serverId);
    if (
      previous?.status === state.status &&
      previous.supportSchema === state.supportSchema &&
      previous.message === state.message
    ) {
      return;
    }
    this.states.set(state.serverId, state);
    this.stateEmitter.fire(state);
  }

  private requireServer(serverId: string): ServerConfig {
    const server = this.connections.store.get(serverId);
    if (!server) throw new Error("The PostgreSQL DatabaseContext no longer exists");
    return server;
  }

  private startStillRequired(serverId: string, supportSchema: string): boolean {
    if (this.disposed || this.listeners.has(serverId)) return false;
    const server = this.connections.store.get(serverId);
    if (!server) return false;
    try {
      const configuration = this.configuration(server);
      return configuration.enabled && configuration.supportSchema === supportSchema;
    } catch {
      return false;
    }
  }
}
