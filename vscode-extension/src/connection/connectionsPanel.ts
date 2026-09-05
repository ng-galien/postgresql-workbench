import * as vscode from "vscode";
import type { WorkbenchDdlSyncController } from "../../../packages/catalog/src/ddlSync.js";
import type {
  WorkbenchIndexController,
  WorkbenchIndexResult,
} from "../../../packages/catalog/src/indexController.js";
import { getConnectionUrl } from "../../../packages/catalog/src/savedConnection.js";
import { readPostgresServerSnapshot } from "../../../packages/catalog/src/serverSnapshot.js";
import {
  APP_SETTINGS,
  type AppSettingValue,
  type ConnectionDraft,
  type ConnectionSummary,
  type ConnectionsPageRequest,
  type ConnectionsPageResponse,
} from "../../../packages/views/src/connections/protocol.js";
import viewBundles from "../../../packages/views/viewBundles.json" with { type: "json" };
import { webviewShell } from "../webviewShell.js";
import { loadPgsqlConnections, loadSqlToolsConnections } from "./commands.js";
import type { ConnectionManager } from "./index.js";
import { McpIntegration } from "./mcpIntegration.js";
import { ConnectionStore } from "./savedConnections.js";

/**
 * The Connections page: one webview where a Connection is added, edited, tested and removed. The
 * first thing a new user meets, so the host opens it by itself when nothing is configured yet —
 * managing Connections never requires knowing a command.
 */
/** The index result minus the identity the summary already carries. */
function omitIndexResultIdentity(
  result: WorkbenchIndexResult,
): Omit<WorkbenchIndexResult, "connectionId" | "database"> {
  const { connectionId: _connectionId, database: _database, ...rest } = result;
  return rest;
}

export class ConnectionsPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly passwordKnown = new Map<string, boolean>();
  private postStateQueued = false;
  private postStateSequence = 0;
  private readonly subscriptions: readonly { dispose(): void }[];
  private readonly mcp: McpIntegration;
  private mcpStateSequence = 0;

  constructor(
    private readonly connections: ConnectionManager,
    private readonly ddlSync: WorkbenchDdlSyncController,
    private readonly index: WorkbenchIndexController,
    private readonly extensionUri: vscode.Uri,
    private readonly startDockerDatabase: () => Promise<string | undefined>,
    context: vscode.ExtensionContext,
  ) {
    this.mcp = new McpIntegration(context, connections.store);
    this.subscriptions = [
      this.mcp,
      this.mcp.onChanged(() => {
        void this.postMcpState();
      }),
      connections.onChanged(() => this.queuedPostState()),
      ddlSync.onDidChangeState(() => this.queuedPostState()),
      index.onDidChangeState(() => this.queuedPostState()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("postgresql-workbench")) this.postAppSettings();
      }),
    ];
  }

  open(): void {
    if (this.panel) {
      this.panel.reveal(undefined, false);
      return;
    }
    const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
    const panel = vscode.window.createWebviewPanel(
      "postgresql-workbench.connections",
      "PostgreSQL Connections",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [dist] },
    );
    panel.webview.html = webviewShell({
      webview: panel.webview,
      extensionUri: this.extensionUri,
      title: "PostgreSQL Connections",
      script: viewBundles.connections.script,
    });
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
    });
    panel.webview.onDidReceiveMessage((message: ConnectionsPageRequest) => {
      void this.handle(message);
    });
    this.panel = panel;
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.panel?.dispose();
  }

  private async handle(message: ConnectionsPageRequest): Promise<void> {
    if (message.type === "ready") {
      await this.postState();
      this.postAppSettings();
      await this.postMcpState();
    } else if (message.type === "mcpAction") {
      await this.mcp.act(message.action, message.port, message.connectionId, message.client);
    } else if (message.type === "setAppSetting")
      await this.applyAppSetting(message.key, message.value);
    else if (message.type === "save")
      await this.save(message.draft, message.originalId, message.connect);
    else if (message.type === "delete") {
      this.passwordKnown.delete(message.id);
      if (await this.connections.removeConnectionConfiguration(message.id)) {
        await this.postState();
      }
    } else if (message.type === "connect" || message.type === "disconnect") {
      await this.changeConnection(message.type, message.id);
    } else if (message.type === "inspect") {
      await this.inspect(message.id, message.requestId);
    } else if (message.type === "refreshIndex") {
      await this.refreshIndex(message.id);
    } else if (message.type === "setSchemaSyncEnabled") {
      await this.changeSchemaSync(message.id, () =>
        this.ddlSync.setConnectionEnabled(message.id, message.enabled),
      );
    } else if (message.type === "provisionSchemaSync") {
      await this.changeSchemaSync(message.id, () => this.ddlSync.provision(message.id));
    } else if (message.type === "test") {
      const report = await this.connections.testConnection(
        await this.draftParams(message.draft, message.originalId),
      );
      this.post({ type: "tested", requestId: message.requestId, report });
    } else if (message.type === "installExtension") {
      const result = await this.connections.installServerExtension(
        await this.draftParams(message.draft, message.originalId),
        message.name,
      );
      this.post({
        type: "extensionInstalled",
        name: message.name,
        ok: result.ok,
        ...(result.message === undefined ? {} : { message: result.message }),
      });
      if (result.ok && message.originalId) {
        void this.connections.refreshDebugCapability(message.originalId);
      }
    } else if (message.type === "pickCertificate") {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: "Use this file",
        filters: { "PEM files": ["pem", "crt", "cer", "key"], "All files": ["*"] },
      });
      this.post({
        type: "certificatePicked",
        purpose: message.purpose,
        requestId: message.requestId,
        ...(picked?.[0] ? { path: picked[0].fsPath } : {}),
      });
    } else if (message.type === "startDockerDatabase") {
      const id = await this.startDockerDatabase();
      this.post({ type: "dockerDatabaseStarted", ...(id ? { id } : {}) });
    } else if (message.type === "import") {
      await this.importExternal();
    }
  }

  private async draftParams(draft: ConnectionDraft, originalId?: string) {
    const password =
      draft.password ??
      (originalId ? ((await this.connections.store.getPassword(originalId)) ?? "") : "");
    return {
      host: draft.host,
      port: draft.port,
      database: draft.database,
      user: draft.user,
      password,
      ssl: draft.ssl,
      ...(draft.tuning ? { tuning: draft.tuning } : {}),
    };
  }

  private async postMcpState() {
    const sequence = ++this.mcpStateSequence;
    const state = await this.mcp.state();
    if (sequence === this.mcpStateSequence) this.post({ type: "mcpState", state });
  }

  private async save(draft: ConnectionDraft, originalId?: string, connect = false): Promise<void> {
    const id = ConnectionStore.makeId(draft.host, draft.port, draft.database, draft.user);
    const name = draft.name?.trim();
    if (name && !this.connections.store.isConnectionNameAvailable(name, originalId)) {
      this.post({
        type: "saveFailed",
        message: `Another Connection is already named "${name}".`,
      });
      return;
    }
    if (id !== originalId && this.connections.store.has(id)) {
      this.post({
        type: "saveFailed",
        message: `The Connection ${getConnectionUrl(draft)} already exists.`,
      });
      return;
    }
    const config = {
      id,
      ...(name ? { name } : {}),
      host: draft.host,
      port: draft.port,
      database: draft.database,
      user: draft.user,
      ...(draft.ssl ? { ssl: draft.ssl } : {}),
      ...(draft.tuning && Object.keys(draft.tuning).length > 0 ? { tuning: draft.tuning } : {}),
    };
    if (originalId && originalId !== id) {
      const kept = this.connections.store.get(originalId);
      await this.connections.replaceConnectionConfiguration(
        originalId,
        { ...kept, ...config },
        draft.password ?? (await this.connections.store.getPassword(originalId)) ?? "",
      );
    } else if (originalId) {
      const kept = this.connections.store.get(originalId);
      await this.connections.store.update(originalId, { ...kept, ...config }, draft.password);
    } else {
      await this.connections.store.add(config, draft.password ?? "");
    }
    this.passwordKnown.delete(id);
    if (originalId) this.passwordKnown.delete(originalId);
    this.connections.notifyConfigurationChanged();
    this.post({ type: "saved", id });
    await this.postState();
    if (connect) await this.changeConnection("connect", id);
  }

  private async changeConnection(action: "connect" | "disconnect", id: string): Promise<void> {
    try {
      const ok =
        action === "connect"
          ? await this.connections.connectConnection(id)
          : await this.connections.disconnect(id);
      this.post({
        type: "connectionAction",
        id,
        action,
        ok,
        ...(ok ? {} : { message: `Could not ${action} this Connection.` }),
      });
      await this.postState();
    } catch (error) {
      this.post({
        type: "connectionAction",
        id,
        action,
        ok: false,
        message: this.connections.describeConnectionError(error),
      });
    }
  }

  private async inspect(id: string, requestId: number): Promise<void> {
    const client = this.connections.getClient(id);
    if (!client) {
      this.post({
        type: "inspectionFailed",
        id,
        requestId,
        message: "This Connection is not open.",
      });
      return;
    }
    try {
      this.post({
        type: "inspected",
        id,
        requestId,
        server: await readPostgresServerSnapshot(client),
      });
    } catch (error) {
      this.post({
        type: "inspectionFailed",
        id,
        requestId,
        message: this.connections.describeConnectionError(error),
      });
    }
  }

  private async changeSchemaSync(id: string, change: () => Promise<void>): Promise<void> {
    try {
      await change();
      this.post({ type: "schemaSyncAction", id, ok: true });
      await this.postState();
    } catch (error) {
      this.post({
        type: "schemaSyncAction",
        id,
        ok: false,
        message: this.connections.describeConnectionError(error),
      });
      await this.postState();
    }
  }

  private async refreshIndex(id: string): Promise<void> {
    await this.index.indexDatabase(id).catch(() => undefined);
    await this.postState();
  }

  /** Every PostgreSQL Connection SQLTools or the pgsql extension knows and this host does not. */
  private async importExternal(): Promise<void> {
    const candidates = [...loadSqlToolsConnections(), ...loadPgsqlConnections()].filter(
      (candidate) => !this.connections.store.has(candidate.id),
    );
    for (const candidate of candidates) {
      const { password, ...config } = candidate;
      await this.connections.store.add(config, password);
    }
    if (candidates.length > 0) this.connections.notifyConfigurationChanged();
    void vscode.window.showInformationMessage(
      candidates.length > 0
        ? `Imported ${candidates.length} Connection${candidates.length > 1 ? "s" : ""}.`
        : "No new PostgreSQL Connections found in SQLTools or pgsql settings.",
    );
    await this.postState();
  }

  private async postState(): Promise<void> {
    if (!this.panel) return;
    const sequence = ++this.postStateSequence;
    const configs = this.connections.store.getAll();
    const summaries: ConnectionSummary[] = await Promise.all(
      configs.map(async (config) => {
        const debuggerCapability = this.connections.debugCapabilityFor(config.id);
        const schemaSyncConfiguration = this.ddlSync.configuration(config);
        const schemaSyncState = this.ddlSync.state(config.id);
        const indexState = this.index.databaseState({
          connectionId: config.id,
          database: config.database,
        });
        return {
          id: config.id,
          ...(config.name === undefined ? {} : { name: config.name }),
          host: config.host,
          port: config.port,
          database: config.database,
          user: config.user,
          ...(config.ssl === undefined ? {} : { ssl: config.ssl }),
          ...(config.tuning === undefined ? {} : { tuning: config.tuning }),
          hasPassword: await this.hasPassword(config.id),
          connected: this.connections.isConnectionConnected(config.id),
          debugger: {
            status: debuggerCapability.status,
            ...(debuggerCapability.message === undefined
              ? {}
              : { message: debuggerCapability.message }),
          },
          schemaSync: {
            enabled: schemaSyncConfiguration.enabled,
            status: schemaSyncState.status,
            supportSchema: schemaSyncState.supportSchema,
            ...(schemaSyncState.message === undefined ? {} : { message: schemaSyncState.message }),
          },
          index: {
            status: indexState.status,
            ...(indexState.message === undefined ? {} : { message: indexState.message }),
            ...(indexState.progress === undefined ? {} : { progress: indexState.progress }),
            ...(indexState.change === undefined
              ? {}
              : {
                  change: {
                    kind: indexState.change.kind,
                    sources: indexState.change.sourceUris.length,
                  },
                }),
            ...(indexState.result === undefined
              ? {}
              : { result: omitIndexResultIdentity(indexState.result) }),
          },
        };
      }),
    );
    if (sequence === this.postStateSequence) {
      this.post({ type: "state", connections: summaries });
    }
  }

  /** Bursts of host events collapse into one summary build per tick. */
  private queuedPostState(): void {
    if (this.postStateQueued || !this.panel) return;
    this.postStateQueued = true;
    setTimeout(() => {
      this.postStateQueued = false;
      void this.postState();
    }, 100);
  }

  /** Whether a password is saved changes only through this panel's own writes; cache it. */
  private async hasPassword(id: string): Promise<boolean> {
    const known = this.passwordKnown.get(id);
    if (known !== undefined) return known;
    const present = (await this.connections.store.getPassword(id)) !== undefined;
    this.passwordKnown.set(id, present);
    return present;
  }

  /** The application settings the page presents, straight from the host configuration. */
  private postAppSettings(): void {
    const configuration = vscode.workspace.getConfiguration("postgresql-workbench");
    const values: Record<string, AppSettingValue> = {};
    for (const descriptor of APP_SETTINGS) {
      values[descriptor.key] = configuration.get<AppSettingValue>(
        descriptor.key,
        descriptor.default,
      );
    }
    this.post({ type: "appSettings", values });
  }

  /** Writes one declared setting; a key outside the declared set is refused, not forwarded. */
  private async applyAppSetting(key: string, value: AppSettingValue | undefined): Promise<void> {
    if (!APP_SETTINGS.some((descriptor) => descriptor.key === key)) return;
    await vscode.workspace
      .getConfiguration("postgresql-workbench")
      .update(key, value, vscode.ConfigurationTarget.Global);
  }

  private post(message: ConnectionsPageResponse): void {
    void this.panel?.webview.postMessage(message);
  }
}
