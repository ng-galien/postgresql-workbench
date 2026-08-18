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
import { getConnectionName, type ServerConfig } from "./serverStore.js";
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

export interface WorkbenchDdlSyncDiagnosticState {
  serverId: string;
  desired?: WorkbenchDdlSyncConfiguration;
  state: WorkbenchDdlSyncState;
  listener?: {
    processId?: number;
    supportSchema: string;
    databaseOid: number;
    queuedNotifications: number;
    flushScheduled: boolean;
    flushActive: boolean;
  };
  lifecycle: {
    epoch: number;
    active: boolean;
    starting: boolean;
    reconnectScheduled: boolean;
    queued: number;
  };
  refresh: {
    active: boolean;
    queued: number;
  };
  fullRefreshDebtEpoch?: number;
  pendingFullRefreshTransactionId?: string;
  lastReceivedTransactionId?: string;
  lastCompletedTransactionId?: string;
}

interface ListenerRuntime {
  client: Client;
  supportSchema: string;
  databaseOid: number;
  notifications: PostgresDdlNotification[];
  flushTimer?: ReturnType<typeof setTimeout>;
  flushActive: boolean;
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
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly fullRefreshDebtEpochs = new Map<string, number>();
  private readonly fullRefreshEpochSequences = new Map<string, number>();
  private readonly lifecycleTails = new Map<string, Promise<void>>();
  private readonly lifecycleEpochs = new Map<string, number>();
  private readonly lifecyclePending = new Map<string, number>();
  private readonly lifecycleActive = new Set<string>();
  private readonly startingServers = new Set<string>();
  private readonly refreshTails = new Map<string, Promise<void>>();
  private readonly refreshPending = new Map<string, number>();
  private readonly activeRefreshes = new Set<string>();
  private readonly lastReceivedTransactions = new Map<string, string>();
  private readonly lastCompletedTransactions = new Map<string, string>();
  private readonly pendingFullRefreshTransactions = new Map<string, string>();
  private readonly knownDatabases = new Map<string, string>();
  private readonly subscriptions: vscode.Disposable[];
  private disposed = false;

  constructor(
    private readonly connections: ConnectionManager,
    private readonly index: WorkbenchIndexController,
    private readonly output: vscode.OutputChannel,
  ) {
    this.subscriptions = [
      connections.onChanged((change) => {
        // Debug capability probes run after every DDL notification; they do
        // not alter connectivity and must not restart or refresh a listener.
        if (change.debugCapabilityOnly) return;
        this.reconcile(change.serverIds);
      }),
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

  diagnosticState(serverId: string): WorkbenchDdlSyncDiagnosticState {
    const server = this.connections.store.get(serverId);
    let desired: WorkbenchDdlSyncConfiguration | undefined;
    try {
      desired = server ? this.configuration(server) : undefined;
    } catch {
      desired = undefined;
    }
    const listener = this.listeners.get(serverId);
    const lifecyclePending = this.lifecyclePending.get(serverId) ?? 0;
    const refreshPending = this.refreshPending.get(serverId) ?? 0;
    const lifecycleActive = this.lifecycleActive.has(serverId);
    const refreshActive = this.activeRefreshes.has(serverId);
    const state =
      this.states.get(serverId) ??
      ({
        serverId,
        status: desired?.enabled ? "unavailable" : "disabled",
        supportSchema: desired?.supportSchema ?? server?.schemaSync?.supportSchema ?? "workbench",
      } satisfies WorkbenchDdlSyncState);
    return {
      serverId,
      desired,
      state,
      listener: listener
        ? {
            processId: clientProcessId(listener.client),
            supportSchema: listener.supportSchema,
            databaseOid: listener.databaseOid,
            queuedNotifications: listener.notifications.length,
            flushScheduled: listener.flushTimer !== undefined,
            flushActive: listener.flushActive,
          }
        : undefined,
      lifecycle: {
        epoch: this.lifecycleEpoch(serverId),
        active: lifecycleActive,
        starting: this.startingServers.has(serverId),
        reconnectScheduled: this.reconnectTimers.has(serverId),
        queued: Math.max(0, lifecyclePending - (lifecycleActive ? 1 : 0)),
      },
      refresh: {
        active: refreshActive,
        queued: Math.max(0, refreshPending - (refreshActive ? 1 : 0)),
      },
      fullRefreshDebtEpoch: this.fullRefreshDebtEpochs.get(serverId),
      pendingFullRefreshTransactionId: this.pendingFullRefreshTransactions.get(serverId),
      lastReceivedTransactionId: this.lastReceivedTransactions.get(serverId),
      lastCompletedTransactionId: this.lastCompletedTransactions.get(serverId),
    };
  }

  diagnosticStates(): readonly WorkbenchDdlSyncDiagnosticState[] {
    const serverIds = new Set([
      ...this.connections.servers.map((server) => server.id),
      ...this.states.keys(),
      ...this.listeners.keys(),
      ...this.lifecycleTails.keys(),
    ]);
    return [...serverIds].sort().map((serverId) => this.diagnosticState(serverId));
  }

  configuration(server: ServerConfig): WorkbenchDdlSyncConfiguration {
    const settings = vscode.workspace.getConfiguration("postgresql-workbench.workbench.schemaSync");
    return resolveWorkbenchDdlSyncConfiguration(server, {
      enabled: settings.get<boolean>("enabled", false),
      supportSchema: validateSupportSchema(settings.get<string>("supportSchema", "workbench")),
    });
  }

  async setConnectionEnabled(serverId: string, enabled: boolean | undefined): Promise<void> {
    const epoch = this.advanceLifecycleEpoch(serverId);
    this.output.appendLine(
      `Workbench schema synchronization configuration requested: epoch=${epoch} server=${serverId} enabled=${enabled}`,
    );
    await this.enqueueLifecycle(serverId, async () => {
      const server = this.requireServer(serverId);
      const schemaSync = {
        ...server.schemaSync,
        enabled,
      };
      const wasEnabled = this.configuration(server).enabled;
      const desired = this.configuration({ ...server, schemaSync });
      if (!desired.enabled) await this.stopListenerNow(serverId, true);
      else if (!wasEnabled) this.requireFullRefresh(serverId);
      await this.persistOverride(serverId, schemaSync);
      await this.reconcileServer(serverId, this.lifecycleEpoch(serverId));
    });
    await this.waitForLifecycleIdle(serverId);
  }

  async setConnectionSupportSchema(
    serverId: string,
    supportSchema: string | undefined,
  ): Promise<void> {
    this.advanceLifecycleEpoch(serverId);
    await this.enqueueLifecycle(serverId, async () => {
      const server = this.requireServer(serverId);
      const schemaSync = {
        ...server.schemaSync,
        supportSchema:
          supportSchema === undefined ? undefined : validateSupportSchema(supportSchema),
      };
      const desired = this.configuration({ ...server, schemaSync });
      const listener = this.listeners.get(serverId);
      if (listener && listener.supportSchema !== desired.supportSchema) {
        await this.stopListenerNow(serverId, true);
      }
      await this.persistOverride(serverId, schemaSync);
      await this.reconcileServer(serverId, this.lifecycleEpoch(serverId));
    });
    await this.waitForLifecycleIdle(serverId);
  }

  async provision(serverId: string): Promise<void> {
    this.advanceLifecycleEpoch(serverId);
    await this.enqueueLifecycle(serverId, async () => {
      const server = this.requireServer(serverId);
      const configuration = this.configuration(server);
      if (!configuration.enabled) {
        throw new Error("Enable schema synchronization for this Connexion first");
      }
      this.output.appendLine(
        `Workbench schema synchronization provisioning started: database=${server.database} schema=${configuration.supportSchema}`,
      );
      await this.stopListenerNow(serverId, true);
      const client = await this.connections.createDedicatedClient(serverId);
      try {
        await client.query(buildWorkbenchDdlProvisioningSql(configuration.supportSchema));
        this.output.appendLine(
          `Workbench schema synchronization provisioned on ${getConnectionName(server)} using schema ${configuration.supportSchema}`,
        );
      } catch (error) {
        this.output.appendLine(
          `Workbench schema synchronization provisioning failed: database=${server.database} schema=${configuration.supportSchema} error=${error instanceof Error ? error.message : String(error)}`,
        );
        this.setFailureState(server, configuration.supportSchema, error);
        throw error;
      } finally {
        await client.end().catch(() => undefined);
      }
      this.states.delete(serverId);
      await this.reconcileServer(serverId, this.lifecycleEpoch(serverId));
    });
    await this.waitForLifecycleIdle(serverId);
  }

  async removeProvisioning(serverId: string): Promise<void> {
    this.advanceLifecycleEpoch(serverId);
    await this.enqueueLifecycle(serverId, async () => {
      const server = this.requireServer(serverId);
      const configuration = this.configuration(server);
      this.output.appendLine(
        `Workbench schema synchronization removal started: database=${server.database} schema=${configuration.supportSchema}`,
      );
      await this.stopListenerNow(serverId, true);
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
        this.output.appendLine(
          `Workbench schema synchronization removal complete: database=${server.database} schema=${configuration.supportSchema}`,
        );
      } catch (error) {
        this.output.appendLine(
          `Workbench schema synchronization removal failed: database=${server.database} schema=${configuration.supportSchema} error=${error instanceof Error ? error.message : String(error)}`,
        );
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
    });
    await this.waitForLifecycleIdle(serverId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const serverId of [...this.listeners.keys()]) {
      this.advanceLifecycleEpoch(serverId);
      void this.enqueueLifecycle(serverId, () => this.stopListenerNow(serverId));
    }
    this.stateEmitter.dispose();
  }

  private reconcile(changedServerIds?: readonly string[]): void {
    if (this.disposed) return;
    const serverIds = changedServerIds
      ? new Set(changedServerIds)
      : new Set([
          ...this.connections.servers.map((server) => server.id),
          ...this.listeners.keys(),
          ...this.states.keys(),
          ...this.fullRefreshDebtEpochs.keys(),
          ...this.pendingFullRefreshTransactions.keys(),
        ]);
    for (const serverId of serverIds) void this.requestReconcile(serverId);
  }

  private async restartAll(): Promise<void> {
    const serverIds = new Set([
      ...this.connections.servers.map((server) => server.id),
      ...this.listeners.keys(),
    ]);
    await Promise.all([...serverIds].map((serverId) => this.requestReconcile(serverId, true)));
  }

  private requestReconcile(serverId: string, restart = false): Promise<void> {
    const epoch = this.advanceLifecycleEpoch(serverId);
    return this.enqueueLifecycle(serverId, async () => {
      if (!this.lifecycleIntentIsCurrent(serverId, epoch)) return;
      await this.reconcileServer(serverId, epoch, restart);
    }).catch((error) => this.handleReconcileFailure(serverId, error));
  }

  private async reconcileServer(serverId: string, epoch: number, restart = false): Promise<void> {
    if (!this.lifecycleIntentIsCurrent(serverId, epoch)) return;
    const server = this.connections.store.get(serverId);
    if (!server) {
      const knownDatabase = this.knownDatabases.get(serverId);
      if (knownDatabase) {
        this.index.markDatabaseStale(
          serverId,
          knownDatabase,
          "PostgreSQL connection removed; schema notifications may have been missed",
        );
      }
      await this.stopListenerNow(serverId);
      await this.waitForRefreshIdle(serverId);
      if (!this.lifecycleIntentIsCurrent(serverId, epoch) || this.connections.store.get(serverId)) {
        return;
      }
      this.clearRemovedServerState(serverId);
      return;
    }
    this.knownDatabases.set(serverId, server.database);

    let configuration: WorkbenchDdlSyncConfiguration;
    try {
      configuration = this.configuration(server);
    } catch (error) {
      await this.stopListenerNow(serverId, this.listeners.has(serverId));
      if (!this.lifecycleIntentIsCurrent(serverId, epoch)) return;
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
      return;
    }

    const listener = this.listeners.get(serverId);
    if (
      !configuration.enabled ||
      restart ||
      (listener !== undefined && listener.supportSchema !== configuration.supportSchema)
    ) {
      await this.stopListenerNow(serverId, restart || listener !== undefined);
      if (!this.lifecycleIntentIsCurrent(serverId, epoch)) return;
      const currentServer = this.connections.store.get(serverId);
      if (!currentServer) return;
      configuration = this.configuration(currentServer);
      if (!configuration.enabled) {
        this.setState({
          serverId,
          supportSchema: configuration.supportSchema,
          status: "disabled",
        });
        return;
      }
    }

    const currentListener = this.listeners.get(serverId);
    if (!currentListener && !this.reconnectTimers.has(serverId)) {
      const state = this.states.get(serverId);
      if (
        state?.status !== "provisioning-required" ||
        state.supportSchema !== configuration.supportSchema
      ) {
        const currentServer = this.connections.store.get(serverId);
        if (currentServer) await this.startServerOnce(currentServer, configuration, epoch);
      }
      return;
    }

    const currentServer = this.connections.store.get(serverId);
    if (
      currentListener &&
      currentServer &&
      this.index.isDatabaseStale(serverId, currentServer.database) &&
      !this.activeRefreshes.has(serverId) &&
      (this.refreshPending.get(serverId) ?? 0) === 0
    ) {
      try {
        await this.enqueueRefresh(serverId, () =>
          this.refreshActive(currentServer, [], "Restoring index freshness after schema changes"),
        );
      } catch (error) {
        this.output.appendLine(
          `Workbench schema synchronization reactivation refresh failed: database=${currentServer.database} error=${error instanceof Error ? error.message : String(error)}`,
        );
        this.onListenerClosed(currentServer, currentListener, asError(error));
      }
    }
  }

  private async startServerOnce(
    server: ServerConfig,
    configuration: WorkbenchDdlSyncConfiguration,
    epoch: number,
  ): Promise<void> {
    if (!this.startStillRequired(server.id, configuration.supportSchema, epoch)) return;
    this.startingServers.add(server.id);
    let client: Client | undefined;
    let runtime: ListenerRuntime | undefined;
    let startupPhase: "detached" | "starting" | "published" | "closed" = "detached";
    let startupFailure: Error | undefined;
    const startupNotifications: Notification[] = [];
    const closeStartupClient = async (): Promise<void> => {
      startupPhase = "closed";
      await client?.end().catch(() => undefined);
    };
    try {
      client = await this.connections.createDedicatedClient(server.id);
      startupPhase = "starting";
      client.on("notification", (notification) => {
        if (startupPhase === "closed") return;
        if (startupPhase === "starting") {
          startupNotifications.push(notification);
          return;
        }
        if (runtime) this.onNotification(server, runtime, notification);
      });
      client.on("error", (error) => {
        if (startupPhase === "closed") return;
        if (startupPhase === "starting") {
          startupFailure = asError(error);
          return;
        }
        if (runtime) this.onListenerClosed(server, runtime, asError(error));
      });
      client.on("end", () => {
        if (startupPhase === "closed") return;
        if (startupPhase === "starting") {
          startupFailure ??= new Error("PostgreSQL schema listener ended during startup");
          return;
        }
        if (runtime) this.onListenerClosed(server, runtime);
      });
      if (!this.startStillRequired(server.id, configuration.supportSchema, epoch)) {
        await closeStartupClient();
        return;
      }
      const result = await client.query(
        workbenchDdlProvisioningStatusSql(configuration.supportSchema),
      );
      if (startupFailure) throw startupFailure;
      const status = result.rows[0] as Record<string, unknown> | undefined;
      if (!this.startStillRequired(server.id, configuration.supportSchema, epoch)) {
        await closeStartupClient();
        return;
      }
      const provisioned =
        status?.schema_exists === true &&
        status.ddl_function_exists === true &&
        status.drop_function_exists === true &&
        status.ddl_trigger_exists === true &&
        status.drop_trigger_exists === true;
      this.output.appendLine(
        `Workbench schema synchronization status: database=${server.database} schema=${configuration.supportSchema} provisioned=${provisioned} pid=${clientProcessId(client) ?? "unknown"}`,
      );
      if (!provisioned) {
        await closeStartupClient();
        if (!this.startStillRequired(server.id, configuration.supportSchema, epoch)) return;
        this.requireFullRefresh(server.id);
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
      if (startupFailure) throw startupFailure;
      this.output.appendLine(
        `Workbench schema synchronization LISTEN complete: database=${server.database} schema=${configuration.supportSchema} pid=${clientProcessId(client) ?? "unknown"} epoch=${epoch}`,
      );
      if (!this.startStillRequired(server.id, configuration.supportSchema, epoch)) {
        await closeStartupClient();
        return;
      }
      runtime = {
        client,
        supportSchema: configuration.supportSchema,
        databaseOid,
        notifications: [],
        flushActive: false,
        closed: false,
      };
      this.listeners.set(server.id, runtime);
      this.output.appendLine(
        `Workbench schema synchronization listening: database=${server.database} schema=${configuration.supportSchema} databaseOid=${databaseOid}`,
      );
      const hasFullRefreshDebt = this.fullRefreshDebtEpochs.has(server.id);
      if (hasFullRefreshDebt || this.index.isDatabaseStale(server.id, server.database)) {
        this.index.markDatabaseStale(
          server.id,
          server.database,
          hasFullRefreshDebt
            ? "Schema synchronization resumed after a listener gap"
            : "Schema synchronization listener connected while index freshness was unknown",
        );
        this.setState({
          serverId: server.id,
          supportSchema: configuration.supportSchema,
          status: "desynchronized",
          message: `Restoring index freshness after a listener gap on ${server.database}`,
        });
        await this.enqueueRefresh(server.id, () =>
          this.refreshActive(
            server,
            [],
            hasFullRefreshDebt
              ? "listener reconnected after a notification gap"
              : "listener connected while index freshness was unknown",
          ),
        );
      } else {
        this.setState({
          serverId: server.id,
          supportSchema: configuration.supportSchema,
          status: "listening",
          message: `Listening for structural DDL on ${server.database}`,
        });
      }
      if (startupFailure) throw startupFailure;
      startupPhase = "published";
      for (const notification of startupNotifications.splice(0)) {
        this.onNotification(server, runtime, notification);
      }
    } catch (error) {
      const publishedRuntime = client ? this.listeners.get(server.id) : undefined;
      if (client && publishedRuntime?.client === client) {
        startupPhase = "published";
        this.onListenerClosed(server, publishedRuntime, asError(error));
        return;
      }
      if (client) await closeStartupClient();
      if (!this.startStillRequired(server.id, configuration.supportSchema, epoch)) return;
      this.requireFullRefresh(server.id);
      this.index.markDatabaseStale(
        server.id,
        server.database,
        "Schema synchronization listener is unavailable",
      );
      const status = this.setFailureState(server, configuration.supportSchema, error);
      this.output.appendLine(
        `Workbench schema synchronization listener failed: database=${server.database} schema=${configuration.supportSchema} status=${status} error=${error instanceof Error ? error.message : String(error)}`,
      );
      if (status === "unavailable") this.scheduleReconnect(server.id);
    } finally {
      this.startingServers.delete(server.id);
    }
  }

  private onNotification(
    server: ServerConfig,
    runtime: ListenerRuntime,
    notification: Notification,
  ): void {
    if (
      runtime.closed ||
      this.listeners.get(server.id) !== runtime ||
      notification.channel !== WORKBENCH_DDL_CHANNEL ||
      !notification.payload
    ) {
      return;
    }
    try {
      const parsed = parsePostgresDdlNotification(notification.payload);
      if (parsed.databaseOid !== runtime.databaseOid) {
        throw new Error("DDL notification belongs to another PostgreSQL database");
      }
      this.index.markDatabaseStale(
        server.id,
        server.database,
        `PostgreSQL schema changed in transaction ${parsed.transactionId}`,
      );
      runtime.notifications.push(parsed);
      this.lastReceivedTransactions.set(server.id, parsed.transactionId);
      this.output.appendLine(
        `Workbench DDL notification received: database=${server.database} event=${parsed.event} transaction=${parsed.transactionId} objects=${ddlObjectSummary(parsed.objects)} fallback=${parsed.fallback === true}`,
      );
      if (runtime.flushTimer) clearTimeout(runtime.flushTimer);
      runtime.flushTimer = setTimeout(() => void this.flushNotifications(server, runtime), 100);
    } catch (error) {
      this.output.appendLine(
        `Workbench DDL notification rejected: database=${server.database} error=${error instanceof Error ? error.message : String(error)}`,
      );
      this.requireFullRefresh(server.id);
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
    if (runtime.flushActive || runtime.closed) return;
    runtime.flushActive = true;
    try {
      while (!runtime.closed && runtime.notifications.length > 0) {
        const pending = runtime.notifications.splice(0);
        for (const group of coalescePostgresDdlNotifications(pending)) {
          void this.connections.refreshDebugCapability?.(server.id);
          const reason = group.fallback
            ? group.reasons.join(", ") || "DDL notification requested a full refresh"
            : undefined;
          this.output.appendLine(
            `Workbench DDL refresh scheduled: database=${server.database} transaction=${group.transactionId} mode=${reason ? "full-fallback" : "incremental"} objects=${ddlObjectSummary(group.objects)}${reason ? ` reason=${reason}` : ""}`,
          );
          try {
            await this.enqueueRefresh(server.id, () =>
              this.refreshActive(server, group.objects, reason),
            );
            this.lastCompletedTransactions.set(server.id, group.transactionId);
          } catch (error) {
            this.pendingFullRefreshTransactions.set(server.id, group.transactionId);
            this.output.appendLine(
              `Workbench schema synchronization failed for ${getConnectionName(server)}: ${error instanceof Error ? error.message : String(error)}`,
            );
            this.onListenerClosed(
              server,
              runtime,
              error instanceof Error ? error : new Error(String(error)),
            );
            return;
          }
          if (runtime.closed) return;
        }
      }
    } finally {
      runtime.flushActive = false;
      if (!runtime.closed && runtime.notifications.length > 0 && !runtime.flushTimer) {
        runtime.flushTimer = setTimeout(() => void this.flushNotifications(server, runtime), 100);
      }
    }
  }

  private async refreshActive(
    server: ServerConfig,
    objects: Parameters<WorkbenchIndexController["synchronizeDatabaseDdl"]>[2],
    fallbackReason?: string,
  ): Promise<void> {
    const fullRefreshDebtEpoch = this.fullRefreshDebtEpochs.get(server.id);
    const effectiveFallbackReason =
      fallbackReason ??
      (fullRefreshDebtEpoch !== undefined
        ? "schema listener missed or rejected a DDL notification"
        : undefined);
    const client = await this.connections.createDedicatedClient(server.id);
    try {
      const result = await this.index.synchronizeDatabaseDdl(
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
      this.output.appendLine(
        `Workbench DDL refresh complete: database=${server.database} mode=${effectiveFallbackReason ? "full-fallback" : "incremental"} generation=${result.generation ?? "unknown"}`,
      );
      if (
        fullRefreshDebtEpoch !== undefined &&
        this.fullRefreshDebtEpochs.get(server.id) === fullRefreshDebtEpoch
      ) {
        this.fullRefreshDebtEpochs.delete(server.id);
        const pendingTransactionId = this.pendingFullRefreshTransactions.get(server.id);
        if (pendingTransactionId !== undefined) {
          this.lastCompletedTransactions.set(server.id, pendingTransactionId);
          this.pendingFullRefreshTransactions.delete(server.id);
        }
      }
      if (this.fullRefreshDebtEpochs.has(server.id)) {
        this.index.markDatabaseStale(
          server.id,
          server.database,
          "Schema synchronization listener gap remains unresolved",
        );
        const runtime = this.listeners.get(server.id);
        if (runtime) {
          this.setState({
            serverId: server.id,
            supportSchema: runtime.supportSchema,
            status: "desynchronized",
            message: `Restoring index freshness after a listener gap on ${server.database}`,
          });
        }
        return;
      }
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
    if (this.listeners.get(server.id) === runtime) this.listeners.delete(server.id);
    this.requireFullRefresh(server.id);
    const epoch = this.advanceLifecycleEpoch(server.id);
    void this.enqueueLifecycle(server.id, async () => {
      await runtime.client.end().catch(() => undefined);
      if (!this.lifecycleIntentIsCurrent(server.id, epoch)) return;
      const currentServer = this.connections.store.get(server.id);
      if (!currentServer) return;
      let configuration: WorkbenchDdlSyncConfiguration;
      try {
        configuration = this.configuration(currentServer);
      } catch {
        return;
      }
      if (!configuration.enabled) {
        this.setState({
          serverId: server.id,
          supportSchema: configuration.supportSchema,
          status: "disabled",
        });
        return;
      }
      this.output.appendLine(
        `Workbench schema synchronization listener closed: database=${currentServer.database} schema=${runtime.supportSchema}${error ? ` error=${error.message}` : ""}`,
      );
      this.index.markDatabaseStale(
        server.id,
        currentServer.database,
        "PostgreSQL schema listener disconnected; freshness is unknown",
      );
      this.setState({
        serverId: server.id,
        supportSchema: runtime.supportSchema,
        status: "desynchronized",
        message: error?.message ?? "PostgreSQL schema listener disconnected",
      });
      this.scheduleReconnect(server.id);
    });
  }

  private scheduleReconnect(serverId: string): void {
    if (this.disposed || this.reconnectTimers.has(serverId)) return;
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(serverId);
      void this.requestReconcile(serverId);
    }, 2_000);
    this.reconnectTimers.set(serverId, timer);
  }

  private async stopListenerNow(serverId: string, recordRefreshDebt = false): Promise<void> {
    if (recordRefreshDebt) this.requireFullRefresh(serverId);
    const timer = this.reconnectTimers.get(serverId);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(serverId);
    const runtime = this.listeners.get(serverId);
    if (!runtime) return;
    runtime.closed = true;
    if (runtime.flushTimer) clearTimeout(runtime.flushTimer);
    this.listeners.delete(serverId);
    this.output.appendLine(
      `Workbench schema synchronization listener stopping: server=${serverId} pid=${clientProcessId(runtime.client) ?? "unknown"}`,
    );
    await runtime.client.end().catch(() => undefined);
    this.output.appendLine(
      `Workbench schema synchronization listener stopped: server=${serverId} pid=${clientProcessId(runtime.client) ?? "unknown"}`,
    );
  }

  private async persistOverride(
    serverId: string,
    schemaSync: ServerConfig["schemaSync"],
  ): Promise<void> {
    if (
      schemaSync === undefined ||
      (schemaSync.enabled === undefined && schemaSync.supportSchema === undefined)
    ) {
      await this.connections.setSchemaSyncOverride(serverId, undefined);
    } else {
      await this.connections.setSchemaSyncOverride(serverId, schemaSync);
    }
  }

  private enqueueLifecycle<T>(serverId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTails.get(serverId) ?? Promise.resolve();
    this.lifecyclePending.set(serverId, (this.lifecyclePending.get(serverId) ?? 0) + 1);
    const run = previous.then(
      () => this.runLifecycleOperation(serverId, operation),
      () => this.runLifecycleOperation(serverId, operation),
    );
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.lifecycleTails.set(serverId, tail);
    void tail.then(() => {
      if (this.lifecycleTails.get(serverId) === tail) this.lifecycleTails.delete(serverId);
    });
    return run;
  }

  private async runLifecycleOperation<T>(
    serverId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.lifecycleActive.add(serverId);
    try {
      return await operation();
    } finally {
      this.lifecycleActive.delete(serverId);
      const pending = (this.lifecyclePending.get(serverId) ?? 1) - 1;
      if (pending > 0) this.lifecyclePending.set(serverId, pending);
      else this.lifecyclePending.delete(serverId);
    }
  }

  private async waitForLifecycleIdle(serverId: string): Promise<void> {
    while (true) {
      const tail = this.lifecycleTails.get(serverId);
      if (!tail) return;
      await tail;
      if (this.lifecycleTails.get(serverId) === tail) return;
    }
  }

  private enqueueRefresh<T>(serverId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.refreshTails.get(serverId) ?? Promise.resolve();
    this.refreshPending.set(serverId, (this.refreshPending.get(serverId) ?? 0) + 1);
    const run = previous.then(
      () => this.runRefreshOperation(serverId, operation),
      () => this.runRefreshOperation(serverId, operation),
    );
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.refreshTails.set(serverId, tail);
    void tail.then(() => {
      if (this.refreshTails.get(serverId) === tail) this.refreshTails.delete(serverId);
    });
    return run;
  }

  private async runRefreshOperation<T>(serverId: string, operation: () => Promise<T>): Promise<T> {
    this.activeRefreshes.add(serverId);
    try {
      return await operation();
    } finally {
      this.activeRefreshes.delete(serverId);
      const pending = (this.refreshPending.get(serverId) ?? 1) - 1;
      if (pending > 0) this.refreshPending.set(serverId, pending);
      else this.refreshPending.delete(serverId);
    }
  }

  private async waitForRefreshIdle(serverId: string): Promise<void> {
    while (true) {
      const tail = this.refreshTails.get(serverId);
      if (!tail) return;
      await tail;
      if (this.refreshTails.get(serverId) === tail) return;
    }
  }

  private clearRemovedServerState(serverId: string): void {
    this.states.delete(serverId);
    this.fullRefreshDebtEpochs.delete(serverId);
    this.fullRefreshEpochSequences.delete(serverId);
    this.lastReceivedTransactions.delete(serverId);
    this.lastCompletedTransactions.delete(serverId);
    this.pendingFullRefreshTransactions.delete(serverId);
    this.knownDatabases.delete(serverId);
  }

  private advanceLifecycleEpoch(serverId: string): number {
    const epoch = this.lifecycleEpoch(serverId) + 1;
    this.lifecycleEpochs.set(serverId, epoch);
    return epoch;
  }

  private lifecycleEpoch(serverId: string): number {
    return this.lifecycleEpochs.get(serverId) ?? 0;
  }

  private lifecycleIntentIsCurrent(serverId: string, epoch: number): boolean {
    return !this.disposed && this.lifecycleEpoch(serverId) === epoch;
  }

  private requireFullRefresh(serverId: string): number {
    const epoch = (this.fullRefreshEpochSequences.get(serverId) ?? 0) + 1;
    this.fullRefreshEpochSequences.set(serverId, epoch);
    this.fullRefreshDebtEpochs.set(serverId, epoch);
    return epoch;
  }

  private handleReconcileFailure(serverId: string, error: unknown): void {
    if (this.disposed) return;
    const server = this.connections.store.get(serverId);
    if (!server) return;
    const failure = asError(error);
    const runtime = this.listeners.get(serverId);
    if (runtime) {
      this.onListenerClosed(server, runtime, failure);
      return;
    }
    this.requireFullRefresh(serverId);
    this.index.markDatabaseStale(
      serverId,
      server.database,
      "Schema synchronization reconciliation failed; freshness is unknown",
    );
    let supportSchema = server.schemaSync?.supportSchema ?? "workbench";
    try {
      supportSchema = this.configuration(server).supportSchema;
    } catch {
      // Preserve a failure state even when the desired configuration itself is invalid.
    }
    this.setState({
      serverId,
      supportSchema,
      status: "desynchronized",
      message: failure.message,
    });
    this.output.appendLine(
      `Workbench schema synchronization reconciliation failed: database=${server.database} error=${failure.message}`,
    );
    this.scheduleReconnect(serverId);
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
    if (!server) throw new Error("The PostgreSQL Connexion no longer exists");
    return server;
  }

  private startStillRequired(serverId: string, supportSchema: string, epoch: number): boolean {
    if (!this.lifecycleIntentIsCurrent(serverId, epoch) || this.listeners.has(serverId))
      return false;
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

function ddlObjectSummary(
  objects: Parameters<WorkbenchIndexController["synchronizeDatabaseDdl"]>[2],
): string {
  if (objects.length === 0) return "none";
  const counts = new Map<string, number>();
  for (const object of objects) {
    const key = object.resourceKind ?? object.objectType;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${kind}:${count}`)
    .join(",");
}

function clientProcessId(client: Client): number | undefined {
  const processId = (client as Client & { processID?: unknown }).processID;
  return typeof processId === "number" && Number.isSafeInteger(processId) ? processId : undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
