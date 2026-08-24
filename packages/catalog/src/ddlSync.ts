import type { Client, Notification } from "pg";
import {
  classifyWorkbenchDdlSyncFailure,
  resolveWorkbenchDdlSyncConfiguration,
  type WorkbenchDdlSyncConfiguration,
} from "./ddlSyncSettings.js";
import type { CatalogQueryClient } from "./postgresCatalog.js";
import {
  buildWorkbenchDdlProvisioningSql,
  buildWorkbenchDdlRemovalSql,
  coalescePostgresDdlNotifications,
  type PostgresDdlNotification,
  type PostgresDdlObject,
  parsePostgresDdlNotification,
  validateSupportSchema,
  WORKBENCH_DDL_CHANNEL,
  workbenchDdlProvisioningStatusSql,
} from "./postgresDdlSync.js";
import { type ConnectionConfig, getConnectionName } from "./savedConnection.js";

/** What the DDL listener needs from the open Connections; `ConnectionManager` satisfies it. */
export interface DdlSyncConnections {
  readonly connections: readonly ConnectionConfig[];
  readonly store: { get(connectionId: string): ConnectionConfig | undefined };
  createDedicatedClient(connectionId: string): Promise<Client>;
  setSchemaSyncOverride(
    connectionId: string,
    override: ConnectionConfig["schemaSync"],
  ): Promise<void>;
  refreshDebugCapability(connectionId: string): Promise<unknown>;
  onChanged(
    listener: (change: { connectionIds: readonly string[]; debugCapabilityOnly?: boolean }) => void,
  ): {
    dispose(): void;
  };
}

/** What it needs from the Workbench Index to keep it honest after a DDL change. */
export interface DdlSyncIndex {
  markDatabaseStale(connectionId: string, database: string, reason: string): void;
  isDatabaseStale(connectionId: string, database: string): boolean;
  synchronizeDatabaseDdl(
    client: CatalogQueryClient,
    identity: { connectionId: string; database: string },
    objects: readonly PostgresDdlObject[],
    fallbackReason?: string,
  ): Promise<{ generation: number | null }>;
}

/** Where the listener reports what it did, and how it reads the Schema Sync settings. */
export interface DdlSyncHost {
  log(message: string): void;
  settings(): { enabled: boolean; supportSchema: string };
  onSettingsChanged(listener: () => void): { dispose(): void };
}

/** One listener registration, released when the controller is disposed. */
interface Subscription {
  dispose(): void;
}

export type WorkbenchDdlSyncStatus =
  | "disabled"
  | "provisioning-required"
  | "listening"
  | "insufficient-privilege"
  | "unavailable"
  | "desynchronized";

export interface WorkbenchDdlSyncState {
  connectionId: string;
  status: WorkbenchDdlSyncStatus;
  supportSchema: string;
  message?: string;
}

export interface WorkbenchDdlSyncDiagnosticState {
  connectionId: string;
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
// code-moniker: ignore[code-single-responsibility-flags-large-classes]
export class WorkbenchDdlSyncController {
  private readonly stateListeners = new Set<(state: WorkbenchDdlSyncState) => void>();
  private readonly states = new Map<string, WorkbenchDdlSyncState>();
  private readonly listeners = new Map<string, ListenerRuntime>();
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly fullRefreshDebtEpochs = new Map<string, number>();
  private readonly fullRefreshEpochSequences = new Map<string, number>();
  private readonly lifecycleTails = new Map<string, Promise<void>>();
  private readonly lifecycleEpochs = new Map<string, number>();
  private readonly lifecyclePending = new Map<string, number>();
  private readonly lifecycleActive = new Set<string>();
  private readonly startingConnections = new Set<string>();
  private readonly refreshTails = new Map<string, Promise<void>>();
  private readonly refreshPending = new Map<string, number>();
  private readonly activeRefreshes = new Set<string>();
  private readonly lastReceivedTransactions = new Map<string, string>();
  private readonly lastCompletedTransactions = new Map<string, string>();
  private readonly pendingFullRefreshTransactions = new Map<string, string>();
  private readonly knownDatabases = new Map<string, string>();
  private readonly subscriptions: Subscription[];
  private disposed = false;

  constructor(
    private readonly connections: DdlSyncConnections,
    private readonly index: DdlSyncIndex,
    private readonly host: DdlSyncHost,
  ) {
    this.subscriptions = [
      connections.onChanged((change) => {
        // Debug capability probes run after every DDL notification; they do
        // not alter connectivity and must not restart or refresh a listener.
        if (change.debugCapabilityOnly) return;
        this.reconcile(change.connectionIds);
      }),
      host.onSettingsChanged(() => {
        void this.restartAll();
      }),
    ];
    this.reconcile();
  }

  /** Notifies a listener whenever one Connection's Schema Sync state changes. */
  onDidChangeState(listener: (state: WorkbenchDdlSyncState) => void): Subscription {
    this.stateListeners.add(listener);
    return { dispose: () => this.stateListeners.delete(listener) };
  }

  state(connectionId: string): WorkbenchDdlSyncState {
    const connection = this.connections.store.get(connectionId);
    const supportSchema = connection ? this.configuration(connection).supportSchema : "workbench";
    return (
      this.states.get(connectionId) ?? {
        connectionId,
        status: connection && this.configuration(connection).enabled ? "unavailable" : "disabled",
        supportSchema,
      }
    );
  }

  diagnosticState(connectionId: string): WorkbenchDdlSyncDiagnosticState {
    const connection = this.connections.store.get(connectionId);
    let desired: WorkbenchDdlSyncConfiguration | undefined;
    try {
      desired = connection ? this.configuration(connection) : undefined;
    } catch {
      desired = undefined;
    }
    const listener = this.listeners.get(connectionId);
    const lifecyclePending = this.lifecyclePending.get(connectionId) ?? 0;
    const refreshPending = this.refreshPending.get(connectionId) ?? 0;
    const lifecycleActive = this.lifecycleActive.has(connectionId);
    const refreshActive = this.activeRefreshes.has(connectionId);
    const state =
      this.states.get(connectionId) ??
      ({
        connectionId,
        status: desired?.enabled ? "unavailable" : "disabled",
        supportSchema:
          desired?.supportSchema ?? connection?.schemaSync?.supportSchema ?? "workbench",
      } satisfies WorkbenchDdlSyncState);
    return {
      connectionId,
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
        epoch: this.lifecycleEpoch(connectionId),
        active: lifecycleActive,
        starting: this.startingConnections.has(connectionId),
        reconnectScheduled: this.reconnectTimers.has(connectionId),
        queued: Math.max(0, lifecyclePending - (lifecycleActive ? 1 : 0)),
      },
      refresh: {
        active: refreshActive,
        queued: Math.max(0, refreshPending - (refreshActive ? 1 : 0)),
      },
      fullRefreshDebtEpoch: this.fullRefreshDebtEpochs.get(connectionId),
      pendingFullRefreshTransactionId: this.pendingFullRefreshTransactions.get(connectionId),
      lastReceivedTransactionId: this.lastReceivedTransactions.get(connectionId),
      lastCompletedTransactionId: this.lastCompletedTransactions.get(connectionId),
    };
  }

  diagnosticStates(): readonly WorkbenchDdlSyncDiagnosticState[] {
    const connectionIds = new Set([
      ...this.connections.connections.map((connection) => connection.id),
      ...this.states.keys(),
      ...this.listeners.keys(),
      ...this.lifecycleTails.keys(),
    ]);
    return [...connectionIds].sort().map((connectionId) => this.diagnosticState(connectionId));
  }

  configuration(connection: ConnectionConfig): WorkbenchDdlSyncConfiguration {
    const settings = this.host.settings();
    return resolveWorkbenchDdlSyncConfiguration(connection, {
      enabled: settings.enabled,
      supportSchema: validateSupportSchema(settings.supportSchema),
    });
  }

  async setConnectionEnabled(connectionId: string, enabled: boolean | undefined): Promise<void> {
    const epoch = this.advanceLifecycleEpoch(connectionId);
    this.host.log(
      `Workbench schema synchronization configuration requested: epoch=${epoch} connection=${connectionId} enabled=${enabled}`,
    );
    await this.enqueueLifecycle(connectionId, async () => {
      const connection = this.requireConnection(connectionId);
      const schemaSync = {
        ...connection.schemaSync,
        enabled,
      };
      const wasEnabled = this.configuration(connection).enabled;
      const desired = this.configuration({ ...connection, schemaSync });
      if (!desired.enabled) await this.stopListenerNow(connectionId, true);
      else if (!wasEnabled) this.requireFullRefresh(connectionId);
      await this.persistOverride(connectionId, schemaSync);
      await this.reconcileConnection(connectionId, this.lifecycleEpoch(connectionId));
    });
    await this.waitForLifecycleIdle(connectionId);
  }

  async setConnectionSupportSchema(
    connectionId: string,
    supportSchema: string | undefined,
  ): Promise<void> {
    this.advanceLifecycleEpoch(connectionId);
    await this.enqueueLifecycle(connectionId, async () => {
      const connection = this.requireConnection(connectionId);
      const schemaSync = {
        ...connection.schemaSync,
        supportSchema:
          supportSchema === undefined ? undefined : validateSupportSchema(supportSchema),
      };
      const desired = this.configuration({ ...connection, schemaSync });
      const listener = this.listeners.get(connectionId);
      if (listener && listener.supportSchema !== desired.supportSchema) {
        await this.stopListenerNow(connectionId, true);
      }
      await this.persistOverride(connectionId, schemaSync);
      await this.reconcileConnection(connectionId, this.lifecycleEpoch(connectionId));
    });
    await this.waitForLifecycleIdle(connectionId);
  }

  async provision(connectionId: string): Promise<void> {
    this.advanceLifecycleEpoch(connectionId);
    await this.enqueueLifecycle(connectionId, async () => {
      const connection = this.requireConnection(connectionId);
      const configuration = this.configuration(connection);
      if (!configuration.enabled) {
        throw new Error("Enable schema synchronization for this Connection first");
      }
      this.host.log(
        `Workbench schema synchronization provisioning started: database=${connection.database} schema=${configuration.supportSchema}`,
      );
      await this.stopListenerNow(connectionId, true);
      const client = await this.connections.createDedicatedClient(connectionId);
      try {
        await client.query(buildWorkbenchDdlProvisioningSql(configuration.supportSchema));
        this.host.log(
          `Workbench schema synchronization provisioned on ${getConnectionName(connection)} using schema ${configuration.supportSchema}`,
        );
      } catch (error) {
        this.host.log(
          `Workbench schema synchronization provisioning failed: database=${connection.database} schema=${configuration.supportSchema} error=${error instanceof Error ? error.message : String(error)}`,
        );
        this.setFailureState(connection, configuration.supportSchema, error);
        throw error;
      } finally {
        await client.end().catch(() => undefined);
      }
      this.states.delete(connectionId);
      await this.reconcileConnection(connectionId, this.lifecycleEpoch(connectionId));
    });
    await this.waitForLifecycleIdle(connectionId);
  }

  async removeProvisioning(connectionId: string): Promise<void> {
    this.advanceLifecycleEpoch(connectionId);
    await this.enqueueLifecycle(connectionId, async () => {
      const connection = this.requireConnection(connectionId);
      const configuration = this.configuration(connection);
      this.host.log(
        `Workbench schema synchronization removal started: database=${connection.database} schema=${configuration.supportSchema}`,
      );
      await this.stopListenerNow(connectionId, true);
      const client = await this.connections.createDedicatedClient(connectionId);
      try {
        await client.query(buildWorkbenchDdlRemovalSql(configuration.supportSchema));
        this.index.markDatabaseStale(
          connection.id,
          connection.database,
          "Schema synchronization provisioning was removed",
        );
        this.setState({
          connectionId,
          supportSchema: configuration.supportSchema,
          status: configuration.enabled ? "provisioning-required" : "disabled",
          message: "Database-level event triggers and Workbench notification functions removed",
        });
        this.host.log(
          `Workbench schema synchronization removal complete: database=${connection.database} schema=${configuration.supportSchema}`,
        );
      } catch (error) {
        this.host.log(
          `Workbench schema synchronization removal failed: database=${connection.database} schema=${configuration.supportSchema} error=${error instanceof Error ? error.message : String(error)}`,
        );
        this.index.markDatabaseStale(
          connection.id,
          connection.database,
          "Schema synchronization removal failed after the listener stopped",
        );
        this.setFailureState(connection, configuration.supportSchema, error);
        throw error;
      } finally {
        await client.end().catch(() => undefined);
      }
    });
    await this.waitForLifecycleIdle(connectionId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const connectionId of [...this.listeners.keys()]) {
      this.advanceLifecycleEpoch(connectionId);
      void this.enqueueLifecycle(connectionId, () => this.stopListenerNow(connectionId));
    }
    this.stateListeners.clear();
  }

  private reconcile(changedConnectionIds?: readonly string[]): void {
    if (this.disposed) return;
    const connectionIds = changedConnectionIds
      ? new Set(changedConnectionIds)
      : new Set([
          ...this.connections.connections.map((connection) => connection.id),
          ...this.listeners.keys(),
          ...this.states.keys(),
          ...this.fullRefreshDebtEpochs.keys(),
          ...this.pendingFullRefreshTransactions.keys(),
        ]);
    for (const connectionId of connectionIds) void this.requestReconcile(connectionId);
  }

  private async restartAll(): Promise<void> {
    const connectionIds = new Set([
      ...this.connections.connections.map((connection) => connection.id),
      ...this.listeners.keys(),
    ]);
    await Promise.all(
      [...connectionIds].map((connectionId) => this.requestReconcile(connectionId, true)),
    );
  }

  private requestReconcile(connectionId: string, restart = false): Promise<void> {
    const epoch = this.advanceLifecycleEpoch(connectionId);
    return this.enqueueLifecycle(connectionId, async () => {
      if (!this.lifecycleIntentIsCurrent(connectionId, epoch)) return;
      await this.reconcileConnection(connectionId, epoch, restart);
    }).catch((error) => this.handleReconcileFailure(connectionId, error));
  }

  private async reconcileConnection(
    connectionId: string,
    epoch: number,
    restart = false,
  ): Promise<void> {
    if (!this.lifecycleIntentIsCurrent(connectionId, epoch)) return;
    const connection = this.connections.store.get(connectionId);
    if (!connection) {
      const knownDatabase = this.knownDatabases.get(connectionId);
      if (knownDatabase) {
        this.index.markDatabaseStale(
          connectionId,
          knownDatabase,
          "PostgreSQL connection removed; schema notifications may have been missed",
        );
      }
      await this.stopListenerNow(connectionId);
      await this.waitForRefreshIdle(connectionId);
      if (
        !this.lifecycleIntentIsCurrent(connectionId, epoch) ||
        this.connections.store.get(connectionId)
      ) {
        return;
      }
      this.clearRemovedConnectionState(connectionId);
      return;
    }
    this.knownDatabases.set(connectionId, connection.database);

    let configuration: WorkbenchDdlSyncConfiguration;
    try {
      configuration = this.configuration(connection);
    } catch (error) {
      await this.stopListenerNow(connectionId, this.listeners.has(connectionId));
      if (!this.lifecycleIntentIsCurrent(connectionId, epoch)) return;
      this.index.markDatabaseStale(
        connection.id,
        connection.database,
        "Schema synchronization configuration is invalid",
      );
      this.setState({
        connectionId: connection.id,
        supportSchema: connection.schemaSync?.supportSchema ?? "workbench",
        status: "unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const listener = this.listeners.get(connectionId);
    if (
      !configuration.enabled ||
      restart ||
      (listener !== undefined && listener.supportSchema !== configuration.supportSchema)
    ) {
      await this.stopListenerNow(connectionId, restart || listener !== undefined);
      if (!this.lifecycleIntentIsCurrent(connectionId, epoch)) return;
      const currentConnection = this.connections.store.get(connectionId);
      if (!currentConnection) return;
      configuration = this.configuration(currentConnection);
      if (!configuration.enabled) {
        this.setState({
          connectionId,
          supportSchema: configuration.supportSchema,
          status: "disabled",
        });
        return;
      }
    }

    const currentListener = this.listeners.get(connectionId);
    if (!currentListener && !this.reconnectTimers.has(connectionId)) {
      const state = this.states.get(connectionId);
      if (
        state?.status !== "provisioning-required" ||
        state.supportSchema !== configuration.supportSchema
      ) {
        const currentConnection = this.connections.store.get(connectionId);
        if (currentConnection)
          await this.startConnectionOnce(currentConnection, configuration, epoch);
      }
      return;
    }

    const currentConnection = this.connections.store.get(connectionId);
    if (
      currentListener &&
      currentConnection &&
      this.index.isDatabaseStale(connectionId, currentConnection.database) &&
      !this.activeRefreshes.has(connectionId) &&
      (this.refreshPending.get(connectionId) ?? 0) === 0
    ) {
      try {
        await this.enqueueRefresh(connectionId, () =>
          this.refreshActive(
            currentConnection,
            [],
            "Restoring index freshness after schema changes",
          ),
        );
      } catch (error) {
        this.host.log(
          `Workbench schema synchronization reactivation refresh failed: database=${currentConnection.database} error=${error instanceof Error ? error.message : String(error)}`,
        );
        this.onListenerClosed(currentConnection, currentListener, asError(error));
      }
    }
  }

  private async startConnectionOnce(
    connection: ConnectionConfig,
    configuration: WorkbenchDdlSyncConfiguration,
    epoch: number,
  ): Promise<void> {
    if (!this.startStillRequired(connection.id, configuration.supportSchema, epoch)) return;
    this.startingConnections.add(connection.id);
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
      client = await this.connections.createDedicatedClient(connection.id);
      startupPhase = "starting";
      client.on("notification", (notification) => {
        if (startupPhase === "closed") return;
        if (startupPhase === "starting") {
          startupNotifications.push(notification);
          return;
        }
        if (runtime) this.onNotification(connection, runtime, notification);
      });
      client.on("error", (error) => {
        if (startupPhase === "closed") return;
        if (startupPhase === "starting") {
          startupFailure = asError(error);
          return;
        }
        if (runtime) this.onListenerClosed(connection, runtime, asError(error));
      });
      client.on("end", () => {
        if (startupPhase === "closed") return;
        if (startupPhase === "starting") {
          startupFailure ??= new Error("PostgreSQL schema listener ended during startup");
          return;
        }
        if (runtime) this.onListenerClosed(connection, runtime);
      });
      if (!this.startStillRequired(connection.id, configuration.supportSchema, epoch)) {
        await closeStartupClient();
        return;
      }
      const result = await client.query(
        workbenchDdlProvisioningStatusSql(configuration.supportSchema),
      );
      if (startupFailure) throw startupFailure;
      const status = result.rows[0] as Record<string, unknown> | undefined;
      if (!this.startStillRequired(connection.id, configuration.supportSchema, epoch)) {
        await closeStartupClient();
        return;
      }
      const provisioned =
        status?.schema_exists === true &&
        status.ddl_function_exists === true &&
        status.drop_function_exists === true &&
        status.ddl_trigger_exists === true &&
        status.drop_trigger_exists === true;
      this.host.log(
        `Workbench schema synchronization status: database=${connection.database} schema=${configuration.supportSchema} provisioned=${provisioned} pid=${clientProcessId(client) ?? "unknown"}`,
      );
      if (!provisioned) {
        await closeStartupClient();
        if (!this.startStillRequired(connection.id, configuration.supportSchema, epoch)) return;
        this.requireFullRefresh(connection.id);
        this.index.markDatabaseStale(
          connection.id,
          connection.database,
          "Schema synchronization requires explicit database provisioning",
        );
        this.setState({
          connectionId: connection.id,
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
      this.host.log(
        `Workbench schema synchronization LISTEN complete: database=${connection.database} schema=${configuration.supportSchema} pid=${clientProcessId(client) ?? "unknown"} epoch=${epoch}`,
      );
      if (!this.startStillRequired(connection.id, configuration.supportSchema, epoch)) {
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
      this.listeners.set(connection.id, runtime);
      this.host.log(
        `Workbench schema synchronization listening: database=${connection.database} schema=${configuration.supportSchema} databaseOid=${databaseOid}`,
      );
      const hasFullRefreshDebt = this.fullRefreshDebtEpochs.has(connection.id);
      if (hasFullRefreshDebt || this.index.isDatabaseStale(connection.id, connection.database)) {
        this.index.markDatabaseStale(
          connection.id,
          connection.database,
          hasFullRefreshDebt
            ? "Schema synchronization resumed after a listener gap"
            : "Schema synchronization listener connected while index freshness was unknown",
        );
        this.setState({
          connectionId: connection.id,
          supportSchema: configuration.supportSchema,
          status: "desynchronized",
          message: `Restoring index freshness after a listener gap on ${connection.database}`,
        });
        await this.enqueueRefresh(connection.id, () =>
          this.refreshActive(
            connection,
            [],
            hasFullRefreshDebt
              ? "listener reconnected after a notification gap"
              : "listener connected while index freshness was unknown",
          ),
        );
      } else {
        this.setState({
          connectionId: connection.id,
          supportSchema: configuration.supportSchema,
          status: "listening",
          message: `Listening for structural DDL on ${connection.database}`,
        });
      }
      if (startupFailure) throw startupFailure;
      startupPhase = "published";
      for (const notification of startupNotifications.splice(0)) {
        this.onNotification(connection, runtime, notification);
      }
    } catch (error) {
      const publishedRuntime = client ? this.listeners.get(connection.id) : undefined;
      if (client && publishedRuntime?.client === client) {
        startupPhase = "published";
        this.onListenerClosed(connection, publishedRuntime, asError(error));
        return;
      }
      if (client) await closeStartupClient();
      if (!this.startStillRequired(connection.id, configuration.supportSchema, epoch)) return;
      this.requireFullRefresh(connection.id);
      this.index.markDatabaseStale(
        connection.id,
        connection.database,
        "Schema synchronization listener is unavailable",
      );
      const status = this.setFailureState(connection, configuration.supportSchema, error);
      this.host.log(
        `Workbench schema synchronization listener failed: database=${connection.database} schema=${configuration.supportSchema} status=${status} error=${error instanceof Error ? error.message : String(error)}`,
      );
      if (status === "unavailable") this.scheduleReconnect(connection.id);
    } finally {
      this.startingConnections.delete(connection.id);
    }
  }

  private onNotification(
    connection: ConnectionConfig,
    runtime: ListenerRuntime,
    notification: Notification,
  ): void {
    if (
      runtime.closed ||
      this.listeners.get(connection.id) !== runtime ||
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
        connection.id,
        connection.database,
        `PostgreSQL schema changed in transaction ${parsed.transactionId}`,
      );
      runtime.notifications.push(parsed);
      this.lastReceivedTransactions.set(connection.id, parsed.transactionId);
      this.host.log(
        `Workbench DDL notification received: database=${connection.database} event=${parsed.event} transaction=${parsed.transactionId} objects=${ddlObjectSummary(parsed.objects)} fallback=${parsed.fallback === true}`,
      );
      if (runtime.flushTimer) clearTimeout(runtime.flushTimer);
      runtime.flushTimer = setTimeout(() => void this.flushNotifications(connection, runtime), 100);
    } catch (error) {
      this.host.log(
        `Workbench DDL notification rejected: database=${connection.database} error=${error instanceof Error ? error.message : String(error)}`,
      );
      this.requireFullRefresh(connection.id);
      this.index.markDatabaseStale(
        connection.id,
        connection.database,
        `Unusable DDL notification: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.setState({
        connectionId: connection.id,
        supportSchema: runtime.supportSchema,
        status: "desynchronized",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async flushNotifications(
    connection: ConnectionConfig,
    runtime: ListenerRuntime,
  ): Promise<void> {
    runtime.flushTimer = undefined;
    if (runtime.flushActive || runtime.closed) return;
    runtime.flushActive = true;
    try {
      while (!runtime.closed && runtime.notifications.length > 0) {
        const pending = runtime.notifications.splice(0);
        for (const group of coalescePostgresDdlNotifications(pending)) {
          void this.connections.refreshDebugCapability?.(connection.id);
          const reason = group.fallback
            ? group.reasons.join(", ") || "DDL notification requested a full refresh"
            : undefined;
          this.host.log(
            `Workbench DDL refresh scheduled: database=${connection.database} transaction=${group.transactionId} mode=${reason ? "full-fallback" : "incremental"} objects=${ddlObjectSummary(group.objects)}${reason ? ` reason=${reason}` : ""}`,
          );
          try {
            await this.enqueueRefresh(connection.id, () =>
              this.refreshActive(connection, group.objects, reason),
            );
            this.lastCompletedTransactions.set(connection.id, group.transactionId);
          } catch (error) {
            this.pendingFullRefreshTransactions.set(connection.id, group.transactionId);
            this.host.log(
              `Workbench schema synchronization failed for ${getConnectionName(connection)}: ${error instanceof Error ? error.message : String(error)}`,
            );
            this.onListenerClosed(
              connection,
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
        runtime.flushTimer = setTimeout(
          () => void this.flushNotifications(connection, runtime),
          100,
        );
      }
    }
  }

  private async refreshActive(
    connection: ConnectionConfig,
    objects: readonly PostgresDdlObject[],
    fallbackReason?: string,
  ): Promise<void> {
    const fullRefreshDebtEpoch = this.fullRefreshDebtEpochs.get(connection.id);
    const effectiveFallbackReason =
      fallbackReason ??
      (fullRefreshDebtEpoch !== undefined
        ? "schema listener missed or rejected a DDL notification"
        : undefined);
    const client = await this.connections.createDedicatedClient(connection.id);
    try {
      const result = await this.index.synchronizeDatabaseDdl(
        {
          async query(sql: string) {
            const result = await client.query(sql);
            return { rows: result.rows as Record<string, unknown>[] };
          },
        },
        { connectionId: connection.id, database: connection.database },
        objects,
        effectiveFallbackReason,
      );
      this.host.log(
        `Workbench DDL refresh complete: database=${connection.database} mode=${effectiveFallbackReason ? "full-fallback" : "incremental"} generation=${result.generation ?? "unknown"}`,
      );
      if (
        fullRefreshDebtEpoch !== undefined &&
        this.fullRefreshDebtEpochs.get(connection.id) === fullRefreshDebtEpoch
      ) {
        this.fullRefreshDebtEpochs.delete(connection.id);
        const pendingTransactionId = this.pendingFullRefreshTransactions.get(connection.id);
        if (pendingTransactionId !== undefined) {
          this.lastCompletedTransactions.set(connection.id, pendingTransactionId);
          this.pendingFullRefreshTransactions.delete(connection.id);
        }
      }
      if (this.fullRefreshDebtEpochs.has(connection.id)) {
        this.index.markDatabaseStale(
          connection.id,
          connection.database,
          "Schema synchronization listener gap remains unresolved",
        );
        const runtime = this.listeners.get(connection.id);
        if (runtime) {
          this.setState({
            connectionId: connection.id,
            supportSchema: runtime.supportSchema,
            status: "desynchronized",
            message: `Restoring index freshness after a listener gap on ${connection.database}`,
          });
        }
        return;
      }
      const runtime = this.listeners.get(connection.id);
      if (runtime) {
        this.setState({
          connectionId: connection.id,
          supportSchema: runtime.supportSchema,
          status: "listening",
          message: `Listening for structural DDL on ${connection.database}`,
        });
      }
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  private onListenerClosed(
    connection: ConnectionConfig,
    runtime: ListenerRuntime,
    error?: Error,
  ): void {
    if (runtime.closed || this.disposed) return;
    runtime.closed = true;
    if (runtime.flushTimer) clearTimeout(runtime.flushTimer);
    if (this.listeners.get(connection.id) === runtime) this.listeners.delete(connection.id);
    this.requireFullRefresh(connection.id);
    const epoch = this.advanceLifecycleEpoch(connection.id);
    void this.enqueueLifecycle(connection.id, async () => {
      await runtime.client.end().catch(() => undefined);
      if (!this.lifecycleIntentIsCurrent(connection.id, epoch)) return;
      const currentConnection = this.connections.store.get(connection.id);
      if (!currentConnection) return;
      let configuration: WorkbenchDdlSyncConfiguration;
      try {
        configuration = this.configuration(currentConnection);
      } catch {
        return;
      }
      if (!configuration.enabled) {
        this.setState({
          connectionId: connection.id,
          supportSchema: configuration.supportSchema,
          status: "disabled",
        });
        return;
      }
      this.host.log(
        `Workbench schema synchronization listener closed: database=${currentConnection.database} schema=${runtime.supportSchema}${error ? ` error=${error.message}` : ""}`,
      );
      this.index.markDatabaseStale(
        connection.id,
        currentConnection.database,
        "PostgreSQL schema listener disconnected; freshness is unknown",
      );
      this.setState({
        connectionId: connection.id,
        supportSchema: runtime.supportSchema,
        status: "desynchronized",
        message: error?.message ?? "PostgreSQL schema listener disconnected",
      });
      this.scheduleReconnect(connection.id);
    });
  }

  private scheduleReconnect(connectionId: string): void {
    if (this.disposed || this.reconnectTimers.has(connectionId)) return;
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(connectionId);
      void this.requestReconcile(connectionId);
    }, 2_000);
    this.reconnectTimers.set(connectionId, timer);
  }

  private async stopListenerNow(connectionId: string, recordRefreshDebt = false): Promise<void> {
    if (recordRefreshDebt) this.requireFullRefresh(connectionId);
    const timer = this.reconnectTimers.get(connectionId);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(connectionId);
    const runtime = this.listeners.get(connectionId);
    if (!runtime) return;
    runtime.closed = true;
    if (runtime.flushTimer) clearTimeout(runtime.flushTimer);
    this.listeners.delete(connectionId);
    this.host.log(
      `Workbench schema synchronization listener stopping: connection=${connectionId} pid=${clientProcessId(runtime.client) ?? "unknown"}`,
    );
    await runtime.client.end().catch(() => undefined);
    this.host.log(
      `Workbench schema synchronization listener stopped: connection=${connectionId} pid=${clientProcessId(runtime.client) ?? "unknown"}`,
    );
  }

  private async persistOverride(
    connectionId: string,
    schemaSync: ConnectionConfig["schemaSync"],
  ): Promise<void> {
    if (
      schemaSync === undefined ||
      (schemaSync.enabled === undefined && schemaSync.supportSchema === undefined)
    ) {
      await this.connections.setSchemaSyncOverride(connectionId, undefined);
    } else {
      await this.connections.setSchemaSyncOverride(connectionId, schemaSync);
    }
  }

  private enqueueLifecycle<T>(connectionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTails.get(connectionId) ?? Promise.resolve();
    this.lifecyclePending.set(connectionId, (this.lifecyclePending.get(connectionId) ?? 0) + 1);
    const run = previous.then(
      () => this.runLifecycleOperation(connectionId, operation),
      () => this.runLifecycleOperation(connectionId, operation),
    );
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.lifecycleTails.set(connectionId, tail);
    void tail.then(() => {
      if (this.lifecycleTails.get(connectionId) === tail) this.lifecycleTails.delete(connectionId);
    });
    return run;
  }

  private async runLifecycleOperation<T>(
    connectionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.lifecycleActive.add(connectionId);
    try {
      return await operation();
    } finally {
      this.lifecycleActive.delete(connectionId);
      const pending = (this.lifecyclePending.get(connectionId) ?? 1) - 1;
      if (pending > 0) this.lifecyclePending.set(connectionId, pending);
      else this.lifecyclePending.delete(connectionId);
    }
  }

  private async waitForLifecycleIdle(connectionId: string): Promise<void> {
    while (true) {
      const tail = this.lifecycleTails.get(connectionId);
      if (!tail) return;
      await tail;
      if (this.lifecycleTails.get(connectionId) === tail) return;
    }
  }

  private enqueueRefresh<T>(connectionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.refreshTails.get(connectionId) ?? Promise.resolve();
    this.refreshPending.set(connectionId, (this.refreshPending.get(connectionId) ?? 0) + 1);
    const run = previous.then(
      () => this.runRefreshOperation(connectionId, operation),
      () => this.runRefreshOperation(connectionId, operation),
    );
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.refreshTails.set(connectionId, tail);
    void tail.then(() => {
      if (this.refreshTails.get(connectionId) === tail) this.refreshTails.delete(connectionId);
    });
    return run;
  }

  private async runRefreshOperation<T>(
    connectionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.activeRefreshes.add(connectionId);
    try {
      return await operation();
    } finally {
      this.activeRefreshes.delete(connectionId);
      const pending = (this.refreshPending.get(connectionId) ?? 1) - 1;
      if (pending > 0) this.refreshPending.set(connectionId, pending);
      else this.refreshPending.delete(connectionId);
    }
  }

  private async waitForRefreshIdle(connectionId: string): Promise<void> {
    while (true) {
      const tail = this.refreshTails.get(connectionId);
      if (!tail) return;
      await tail;
      if (this.refreshTails.get(connectionId) === tail) return;
    }
  }

  private clearRemovedConnectionState(connectionId: string): void {
    this.states.delete(connectionId);
    this.fullRefreshDebtEpochs.delete(connectionId);
    this.fullRefreshEpochSequences.delete(connectionId);
    this.lastReceivedTransactions.delete(connectionId);
    this.lastCompletedTransactions.delete(connectionId);
    this.pendingFullRefreshTransactions.delete(connectionId);
    this.knownDatabases.delete(connectionId);
  }

  private advanceLifecycleEpoch(connectionId: string): number {
    const epoch = this.lifecycleEpoch(connectionId) + 1;
    this.lifecycleEpochs.set(connectionId, epoch);
    return epoch;
  }

  private lifecycleEpoch(connectionId: string): number {
    return this.lifecycleEpochs.get(connectionId) ?? 0;
  }

  private lifecycleIntentIsCurrent(connectionId: string, epoch: number): boolean {
    return !this.disposed && this.lifecycleEpoch(connectionId) === epoch;
  }

  private requireFullRefresh(connectionId: string): number {
    const epoch = (this.fullRefreshEpochSequences.get(connectionId) ?? 0) + 1;
    this.fullRefreshEpochSequences.set(connectionId, epoch);
    this.fullRefreshDebtEpochs.set(connectionId, epoch);
    return epoch;
  }

  private handleReconcileFailure(connectionId: string, error: unknown): void {
    if (this.disposed) return;
    const connection = this.connections.store.get(connectionId);
    if (!connection) return;
    const failure = asError(error);
    const runtime = this.listeners.get(connectionId);
    if (runtime) {
      this.onListenerClosed(connection, runtime, failure);
      return;
    }
    this.requireFullRefresh(connectionId);
    this.index.markDatabaseStale(
      connectionId,
      connection.database,
      "Schema synchronization reconciliation failed; freshness is unknown",
    );
    let supportSchema = connection.schemaSync?.supportSchema ?? "workbench";
    try {
      supportSchema = this.configuration(connection).supportSchema;
    } catch {
      // Preserve a failure state even when the desired configuration itself is invalid.
    }
    this.setState({
      connectionId,
      supportSchema,
      status: "desynchronized",
      message: failure.message,
    });
    this.host.log(
      `Workbench schema synchronization reconciliation failed: database=${connection.database} error=${failure.message}`,
    );
    this.scheduleReconnect(connectionId);
  }

  private setFailureState(
    connection: ConnectionConfig,
    supportSchema: string,
    error: unknown,
  ): "insufficient-privilege" | "unavailable" {
    const status = classifyWorkbenchDdlSyncFailure(error);
    this.setState({
      connectionId: connection.id,
      supportSchema,
      status,
      message: error instanceof Error ? error.message : String(error),
    });
    return status;
  }

  private setState(state: WorkbenchDdlSyncState): void {
    const previous = this.states.get(state.connectionId);
    if (
      previous?.status === state.status &&
      previous.supportSchema === state.supportSchema &&
      previous.message === state.message
    ) {
      return;
    }
    this.states.set(state.connectionId, state);
    for (const listener of this.stateListeners) listener(state);
  }

  private requireConnection(connectionId: string): ConnectionConfig {
    const connection = this.connections.store.get(connectionId);
    if (!connection) throw new Error("The PostgreSQL Connection no longer exists");
    return connection;
  }

  private startStillRequired(connectionId: string, supportSchema: string, epoch: number): boolean {
    if (!this.lifecycleIntentIsCurrent(connectionId, epoch) || this.listeners.has(connectionId))
      return false;
    const connection = this.connections.store.get(connectionId);
    if (!connection) return false;
    try {
      const configuration = this.configuration(connection);
      return configuration.enabled && configuration.supportSchema === supportSchema;
    } catch {
      return false;
    }
  }
}

function ddlObjectSummary(objects: readonly PostgresDdlObject[]): string {
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
