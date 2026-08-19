import * as vscode from "vscode";
import type {
  WorkbenchDdlSyncController,
  WorkbenchDdlSyncState,
} from "../../../packages/catalog/src/ddlSync.js";
import {
  buildWorkbenchObjects,
  buildWorkbenchTableMembers,
  listWorkbenchSchemas,
  searchWorkbenchObjects,
  type WorkbenchObjectKind,
  type WorkbenchObjectModel,
  type WorkbenchRoutineParam,
  type WorkbenchTableMemberModel,
} from "../../../packages/catalog/src/objectModel.js";
import type {
  WorkbenchRelationDirection,
  WorkbenchRelationGroup,
  WorkbenchRelationKind,
  WorkbenchRelationTarget,
} from "../../../packages/catalog/src/relations.js";
import type { DebugSessionStatus } from "../../../packages/dap/src/debugger/launch/debugSessionStatus.js";
import type {
  ConnectionChange,
  ConnectionManager,
  DebugCapabilitySnapshot,
} from "../connection/index.js";
import { getConnectionName, type ServerConfig } from "../connection/index.js";
import { type DebugSessionInfo, enrichDebugSessions, listDebugSessions } from "../debug/index.js";
import type { ScratchpadTransaction, ScratchpadTransactionManager } from "../scratchpad/index.js";
import {
  OPEN_SQL_NOTEBOOK_COMMAND,
  resolveScratchpadAssociation,
  type ScratchpadAssociation,
  type SqlNotebookEntry,
  type SqlNotebookWorkspace,
  scratchpadExecutionMode,
  sqlNotebookDisplayName,
} from "../scratchpad/index.js";
import { postgresVisual } from "../sources/index.js";
import type {
  WorkbenchIndexController,
  WorkbenchIndexResult,
  WorkbenchIndexState,
} from "./indexController.js";

export class ServerItem extends vscode.TreeItem {
  readonly kind = "server" as const;
  constructor(
    public readonly server: ServerConfig,
    public readonly connected: boolean,
    public readonly debugCapability: DebugCapabilitySnapshot,
  ) {
    // Always collapsible: a disconnected Connexion keeps a closed chevron so
    // sibling rows stay aligned and its branch offers the connect hint.
    super(getConnectionName(server), vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `postgres-server:${server.id}`;
    if (!connected) {
      this.iconPath = new vscode.ThemeIcon("debug-disconnect");
      this.description = "disconnected";
    } else {
      this.iconPath = new vscode.ThemeIcon("plug", new vscode.ThemeColor("testing.iconPassed"));
      this.description = "connected";
    }
    this.contextValue = connected
      ? "postgresql-workbench-server-connected"
      : "postgresql-workbench-server";
    this.tooltip = connected
      ? `${getConnectionName(server)} · connected\n${debugCapability.status === "available" ? "PL/pgSQL debugging available" : debugCapability.status === "checking" ? "Checking PL/pgSQL debugger capability" : `PL/pgSQL debugging unavailable${debugCapability.message ? `: ${debugCapability.message}` : ""}`}`
      : `${getConnectionName(server)} · disconnected`;
  }
}

export class AddServerItem extends vscode.TreeItem {
  readonly kind = "add" as const;
  constructor() {
    super("Add Server...", vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("add");
    this.command = {
      command: "postgresql-workbench.pickConnection",
      title: "Add Server",
    };
  }
}

export class DatabaseSourceItem extends vscode.TreeItem {
  readonly kind = "databaseSource" as const;

  constructor(
    public readonly server: ServerConfig,
    state: WorkbenchIndexState,
  ) {
    super(server.database, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `postgres-database:${server.id}:${server.database}`;
    this.iconPath = postgresThemeIcon("database");
    this.description = databaseDescription(state);
    this.contextValue = "postgresql-workbench-database";
    this.tooltip = `PostgreSQL source ${server.database} on ${server.host}:${server.port}`;
  }
}

export class SourcesSnapshotItem extends vscode.TreeItem {
  readonly kind = "sourcesSnapshot" as const;

  constructor(
    public readonly server: ServerConfig,
    state: WorkbenchIndexState,
  ) {
    super("Schemas", vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `postgres-sources:${server.id}`;
    this.iconPath = new vscode.ThemeIcon(state.status === "indexing" ? "loading~spin" : "files");
    this.contextValue =
      state.status === "indexing"
        ? "postgresql-workbench-sources-indexing"
        : "postgresql-workbench-sources";
    this.description = sourcesDescription(state);
    this.tooltip = sourcesTooltip(server.database, state);
    this.accessibilityInformation = {
      label: sourcesAccessibilityLabel(server.database, state),
    };
    if (
      state.status === "not-indexed" ||
      state.status === "stale" ||
      state.status === "cancelled" ||
      state.status === "error"
    ) {
      this.command = {
        command: "postgresql-workbench.indexDatabase",
        title: state.status === "not-indexed" ? "Index Database" : "Reindex Database",
        arguments: [server.id],
      };
    }
  }
}

function sourcesDescription(state: WorkbenchIndexState): string {
  switch (state.status) {
    case "not-indexed":
      return "not indexed";
    case "indexing":
      return `${state.result ? "refreshing" : "indexing"} · ${indexProgressLabel(state)}`;
    case "available":
      return state.result
        ? `available · ${countLabel(state.result.documents, "source")} · ${countLabel(state.result.symbols, "symbol")}`
        : "available";
    case "stale":
      return state.result ? "stale · previous snapshot available" : "stale";
    case "cancelled":
      return state.result ? "cancelled · previous snapshot available" : "cancelled · retry";
    case "error":
      return state.result ? "failed · previous snapshot available · retry" : "failed · retry";
  }
}

function databaseDescription(state: WorkbenchIndexState): string {
  switch (state.status) {
    case "not-indexed":
      return "preparing index";
    case "indexing":
      return state.result ? "refreshing" : "indexing";
    case "available":
      return "ready";
    case "stale":
      return "degraded";
    case "cancelled":
      return "indexing paused";
    case "error":
      return state.result ? "degraded" : "indexing failed";
  }
}

function indexProgressLabel(state: WorkbenchIndexState): string {
  const progress = state.progress;
  if (!progress) return "starting";
  switch (progress.phase) {
    case "reading-catalog":
      return "reading catalog";
    case "connecting-index":
      return "connecting index";
    case "publishing-sources":
      return progress.completed === undefined
        ? "publishing sources"
        : `publishing ${progress.completed} sources`;
    case "reading-symbols":
      return progress.completed ? `reading ${progress.completed} symbols` : "reading symbols";
    case "checking-relations":
      return "checking relations";
    case "cancelling":
      return "cancelling";
  }
}

function resultSummary(result: WorkbenchIndexResult): string {
  const milliseconds = Math.round(result.indexingMs);
  return `${countLabel(result.documents, "source")}, ${countLabel(result.symbols, "symbol")}, ${milliseconds} ${milliseconds === 1 ? "millisecond" : "milliseconds"}`;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function sourcesTooltip(database: string, state: WorkbenchIndexState): string {
  switch (state.status) {
    case "not-indexed":
      return `PostgreSQL sources for ${database} are not indexed`;
    case "indexing":
      return [
        `${state.result ? "Refreshing" : "Indexing"} PostgreSQL sources for ${database}: ${indexProgressLabel(state)}`,
        state.result ? `Previous snapshot available: ${resultSummary(state.result)}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");
    case "available":
      return state.result
        ? `Indexed sources for ${database}: ${resultSummary(state.result)}`
        : `Indexed sources for ${database}`;
    case "stale":
      return [
        `PostgreSQL sources for ${database} are stale and require reindexing`,
        state.message,
        state.result ? `Previous snapshot available: ${resultSummary(state.result)}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");
    case "cancelled":
      return [
        `PostgreSQL source indexing for ${database} was cancelled`,
        state.result
          ? `Previous snapshot available: ${resultSummary(state.result)}`
          : "Select to retry",
      ].join("\n");
    case "error":
      return [
        state.message
          ? `PostgreSQL source indexing failed for ${database}: ${state.message}`
          : `PostgreSQL source indexing failed for ${database}`,
        state.result ? `Previous snapshot available: ${resultSummary(state.result)}` : undefined,
        "Select to retry",
      ]
        .filter(Boolean)
        .join("\n");
  }
}

function sourcesAccessibilityLabel(database: string, state: WorkbenchIndexState): string {
  switch (state.status) {
    case "not-indexed":
      return `Schemas, ${database}, not indexed, select to index`;
    case "indexing":
      return [
        `Schemas, ${database}, ${state.result ? "refreshing" : "indexing"}, ${indexProgressLabel(state)}`,
        state.result ? "previous snapshot available" : undefined,
      ]
        .filter(Boolean)
        .join(", ");
    case "available":
      return `Schemas, ${database}, available${state.result ? `, ${resultSummary(state.result)}` : ""}`;
    case "stale":
      return `Schemas, ${database}, stale${state.result ? ", previous snapshot available" : ""}, select to reindex`;
    case "cancelled":
      return `Schemas, ${database}, indexing cancelled${state.result ? ", previous snapshot available" : ""}, select to retry`;
    case "error":
      return `Schemas, ${database}, indexing failed${state.message ? `, ${state.message}` : ""}${state.result ? ", previous snapshot available" : ""}, select to retry`;
  }
}

export class WorkbenchDdlSyncItem extends vscode.TreeItem {
  readonly kind = "ddlSync" as const;

  constructor(
    public readonly server: ServerConfig,
    public readonly state: WorkbenchDdlSyncState,
  ) {
    super("Schema synchronization", vscode.TreeItemCollapsibleState.None);
    this.id = `postgres-schema-sync:${server.id}`;
    this.contextValue = `postgresql-workbench-schema-sync-${state.status}`;
    this.description = ddlSyncDescription(state);
    this.tooltip = [
      `Database: ${server.database}`,
      `Support schema: ${state.supportSchema}`,
      `Status: ${state.status}`,
      state.message,
    ]
      .filter(Boolean)
      .join("\n");
    this.iconPath = ddlSyncIcon(state.status);
    this.command = {
      command: "postgresql-workbench.configureWorkbenchSchemaSync",
      title: "Configure Schema Synchronization",
      arguments: [this],
    };
  }
}

export class SqlNotebookItem extends vscode.TreeItem {
  readonly kind = "sqlNotebook" as const;

  constructor(
    public readonly entry: SqlNotebookEntry,
    public readonly association: ScratchpadAssociation,
    public readonly mode: "auto" | "manual",
    public readonly transaction?: ScratchpadTransaction,
    public readonly connected = false,
  ) {
    const label = sqlNotebookDisplayName(entry.name);
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = entry.uri.toString();
    this.resourceUri = entry.uri;
    this.iconPath = entry.error
      ? new vscode.ThemeIcon("warning")
      : connected
        ? new vscode.ThemeIcon("note", new vscode.ThemeColor("testing.iconPassed"))
        : new vscode.ThemeIcon("note");
    this.contextValue = `postgresql-workbench-scratchpad-${mode}`;
    this.description =
      association.status === "associated"
        ? `${association.snapshot.serverName}${connected ? "" : " · disconnected"} · ${mode.toUpperCase()}`
        : association.status === "unavailable"
          ? `${association.snapshot.serverName} unavailable · ${mode.toUpperCase()}`
          : `No connection · ${mode.toUpperCase()}`;
    this.tooltip = entry.error ? `${label}\n${entry.error}` : label;
    this.accessibilityInformation = {
      label: entry.error
        ? `Invalid SQL scratchpad ${label}`
        : association.status === "unassociated"
          ? `Scratchpad ${label}, no Connexion Association, ${mode}`
          : `Scratchpad ${label}, ${association.snapshot.serverName}, ${connected ? "connected" : "disconnected"}, ${mode}`,
    };
    this.command = {
      command: OPEN_SQL_NOTEBOOK_COMMAND,
      title: `Open SQL scratchpad ${label}`,
      arguments: [entry],
    };
  }
}

export class ScratchpadAssociationItem extends vscode.TreeItem {
  readonly kind = "scratchpadAssociation" as const;

  constructor(
    public readonly scratchpad: SqlNotebookItem,
    public readonly association: ScratchpadAssociation,
    public readonly connected = false,
  ) {
    const label =
      association.status === "unassociated" ? "No connection" : association.snapshot.serverName;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = `${scratchpad.id}:association`;
    this.iconPath =
      association.status === "associated" && connected
        ? new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("testing.iconPassed"))
        : new vscode.ThemeIcon(association.status === "unavailable" ? "warning" : "circle-outline");
    this.contextValue = `postgresql-workbench-scratchpad-association-${association.status}`;
    this.description =
      association.status === "associated"
        ? connected
          ? "connected"
          : "disconnected"
        : association.status === "unavailable"
          ? "unavailable"
          : "not configured";
    this.tooltip =
      association.status === "associated"
        ? "This persistent Association identifies the exact Connexion used by this Scratchpad"
        : "Execution requires a saved Connexion Association";
  }
}

export class ScratchpadTransactionItem extends vscode.TreeItem {
  readonly kind = "scratchpadTransaction" as const;

  constructor(public readonly transaction: ScratchpadTransaction) {
    super(
      transaction.status === "failed" ? "Transaction failed" : "Transaction in progress",
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.id = `${transaction.scratchpadUri}:transaction`;
    this.resourceUri = vscode.Uri.parse(transaction.scratchpadUri);
    const count = transaction.statements.length;
    this.description = `${count} Statement${count === 1 ? "" : "s"}`;
    this.iconPath = new vscode.ThemeIcon(transaction.status === "failed" ? "error" : "sync");
    this.contextValue = `postgresql-workbench-scratchpad-transaction-${transaction.status}`;
  }
}

export class ScratchpadStatementItem extends vscode.TreeItem {
  readonly kind = "scratchpadStatement" as const;

  constructor(
    transaction: ScratchpadTransaction,
    statement: ScratchpadTransaction["statements"][number],
    index: number,
  ) {
    const summary = statement.sql.trim().replace(/\s+/gu, " ").slice(0, 80);
    super(`${index + 1}. ${summary}`, vscode.TreeItemCollapsibleState.None);
    this.id = `${transaction.scratchpadUri}:statement:${index}`;
    this.iconPath = new vscode.ThemeIcon(statement.succeeded ? "pass" : "error");
    this.contextValue = "postgresql-workbench-scratchpad-statement";
  }
}

export class SchemaItem extends vscode.TreeItem {
  readonly kind = "schema" as const;
  constructor(
    public readonly server: ServerConfig,
    public readonly schema: string,
  ) {
    super(schema, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `postgres-schema:${server.id}:${server.database}:${schema}`;
    this.iconPath = postgresThemeIcon("schema");
    this.contextValue = "postgresql-workbench-schema";
  }
}

export class ExtensionGroupItem extends vscode.TreeItem {
  readonly kind = "extensionGroup" as const;

  constructor(
    public readonly schema: string,
    public readonly extension: string,
    public readonly objects: WorkbenchObjectModel[],
    public readonly snapshot: Pick<WorkbenchIndexResult, "revision" | "generation">,
  ) {
    super(extension, vscode.TreeItemCollapsibleState.Collapsed);
    const owner = objects[0];
    this.id = `postgres-extension:${owner?.serverId ?? "unknown"}:${owner?.database ?? "unknown"}:${schema}:${extension}`;
    this.iconPath = postgresThemeIcon("extension");
    this.description = `${objects.length} object${objects.length === 1 ? "" : "s"}`;
    this.contextValue = "postgresql-workbench-extension-objects";
    this.tooltip = `Objects owned by PostgreSQL extension ${extension}`;
  }
}

export class DebugSessionsItem extends vscode.TreeItem {
  readonly kind = "debugSessions" as const;
  constructor(
    public readonly server: ServerConfig,
    public readonly count: number | undefined,
    sessions: readonly DebugSessionInfo[] = [],
  ) {
    super("Debug sessions", vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(
      count === undefined ? "warning" : count > 0 ? "debug-alt" : "debug-alt-small",
    );
    const active = sessions.length === 1 ? sessions[0] : undefined;
    const routine = active?.routine
      ? `${active.routine.schema ? `${active.routine.schema}.` : ""}${active.routine.name}`
      : undefined;
    const routineIdentity =
      routine ?? (active?.routineOid ? `OID ${active.routineOid}` : undefined);
    this.description =
      count === undefined
        ? "unavailable"
        : count === 0
          ? "none"
          : active
            ? `${routineIdentity ? `${routineIdentity} · ` : ""}${active.state}`
            : `${count} found`;
    this.contextValue = "postgresql-workbench-debug-sessions";
    this.tooltip =
      count === undefined
        ? "Debug sessions could not be read — select to retry"
        : count === 0
          ? "No PL/pgSQL debug sessions found"
          : active
            ? `${routineIdentity ?? `Session ${active.id}`} · ${active.routine ? `OID ${active.routine.oid} · ` : ""}${active.state} · ${active.backends.map((backend) => `${backend.role} PID ${backend.pid}`).join(" · ")}`
            : `${count} PL/pgSQL debug session${count === 1 ? "" : "s"} — select sessions to inspect or terminate`;
    this.command = {
      command: "postgresql-workbench.manageDebugSessions",
      title: "Manage Debug Sessions",
    };
  }
}

export class FunctionItem extends vscode.TreeItem {
  readonly kind = "function" as const;
  readonly serverId: string;
  readonly schema: string;
  readonly funcName: string;
  readonly oid: number;
  readonly params: FunctionParam[];
  readonly isProc: boolean;
  readonly symbolUri: string;
  readonly sourceUri: string;

  constructor(
    public readonly object: WorkbenchObjectModel,
    public readonly snapshot: Pick<WorkbenchIndexResult, "revision" | "generation">,
  ) {
    const signature = object.params.map((param) => `${param.name}: ${param.type}`).join(", ");
    super(`${object.name}(${signature})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `postgres-object:${object.symbolUri}`;
    this.serverId = object.serverId;
    this.schema = object.schema;
    this.funcName = object.name;
    this.oid = object.oid;
    this.params = object.params;
    this.isProc = object.kind === "procedure";
    this.symbolUri = object.symbolUri;
    this.sourceUri = object.sourceUri;
    this.iconPath = objectThemeIcon(this.isProc ? "procedure" : "function");
    this.contextValue = "postgresql-workbench-function-debuggable";
    applyDragHint(this, `${object.schema}.${object.name}(${signature})`);
  }
}

export class WorkbenchObjectItem extends vscode.TreeItem {
  readonly kind = "object" as const;

  constructor(
    public readonly object: WorkbenchObjectModel,
    public readonly snapshot: Pick<WorkbenchIndexResult, "revision" | "generation">,
  ) {
    super(objectLabel(object), vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `postgres-object:${object.symbolUri}`;
    this.iconPath = objectThemeIcon(object.kind);
    this.contextValue = `postgresql-workbench-${object.kind}`;
    applyDragHint(this, `${object.schema}.${objectLabel(object)}`);
  }
}

export class WorkbenchTableMemberItem extends vscode.TreeItem {
  readonly kind = "tableMember" as const;

  constructor(
    public readonly member: WorkbenchTableMemberModel,
    public readonly object: WorkbenchObjectModel,
  ) {
    super(member.name, vscode.TreeItemCollapsibleState.None);
    this.iconPath = postgresThemeIcon(member.kind);
    this.description = member.type || "constraint";
    const tooltip = member.type
      ? `${member.name} · ${member.type}`
      : `${member.kind} ${member.name}`;
    if (member.kind === "column") applyDragHint(this, tooltip);
    else this.tooltip = tooltip;
    this.contextValue = `postgresql-workbench-${member.kind}`;
  }
}

export class WorkbenchRelationGroupItem extends vscode.TreeItem {
  readonly kind = "relationGroup" as const;

  constructor(
    public readonly group: WorkbenchRelationGroup,
    public readonly snapshot: Pick<WorkbenchIndexResult, "revision" | "generation">,
    public readonly object: WorkbenchObjectModel,
  ) {
    super(
      relationLabel(group.relation, group.direction),
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.iconPath = new vscode.ThemeIcon(
      group.direction === "outgoing" ? "arrow-right" : "arrow-left",
    );
    this.description = String(group.targets.length);
    this.contextValue = "postgresql-workbench-relation";
  }
}

export class WorkbenchRelationTargetItem extends vscode.TreeItem {
  readonly kind = "relationTarget" as const;

  constructor(
    public readonly target: WorkbenchRelationTarget,
    public readonly snapshot: Pick<WorkbenchIndexResult, "revision" | "generation">,
  ) {
    const object = target.object;
    super(
      object ? `${object.schema}.${objectLabel(object)}` : target.symbol.name,
      vscode.TreeItemCollapsibleState.None,
    );
    this.iconPath = object
      ? objectThemeIcon(object.kind)
      : themedIcon("symbol-field", "charts.blue");
    this.description =
      target.members.length > 0
        ? target.members.map((member) => member.name).join(", ")
        : target.count > 1
          ? `${target.count} references`
          : (object?.kind ?? target.symbol.kind);
    if (object) applyDragHint(this, `${object.schema}.${objectLabel(object)}`);
    else this.tooltip = `${target.symbol.kind} ${target.symbol.name}`;
    this.contextValue = object
      ? "postgresql-workbench-relation-target"
      : "postgresql-workbench-relation-target-unresolved";
  }
}

class MessageItem extends vscode.TreeItem {
  readonly kind = "message" as const;
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
  }
}

class ConnectServerMessageItem extends MessageItem {
  constructor(server: ServerConfig) {
    super("Not connected");
    this.id = `postgres-server-connect:${server.id}`;
    this.iconPath = new vscode.ThemeIcon("plug");
    this.description = "select to connect";
    this.tooltip = `${getConnectionName(server)} is disconnected. Select to connect.`;
    this.command = {
      command: "postgresql-workbench.connectServer",
      title: "Connect",
      arguments: [server.id],
    };
  }
}

class ReindexDatabaseMessageItem extends MessageItem {
  constructor(message: string) {
    super(message);
    this.iconPath = new vscode.ThemeIcon("refresh");
    this.tooltip = `${message}. Select to reindex this database.`;
    this.command = {
      command: "postgresql-workbench.indexDatabase",
      title: "Reindex Database",
    };
  }
}

export type FunctionParam = WorkbenchRoutineParam;

export type PlpgsqlTreeItem =
  | ServerItem
  | AddServerItem
  | DatabaseSourceItem
  | SourcesSnapshotItem
  | WorkbenchDdlSyncItem
  | SqlNotebookItem
  | ScratchpadAssociationItem
  | ScratchpadTransactionItem
  | ScratchpadStatementItem
  | DebugSessionsItem
  | SchemaItem
  | ExtensionGroupItem
  | FunctionItem
  | WorkbenchObjectItem
  | WorkbenchTableMemberItem
  | WorkbenchRelationGroupItem
  | WorkbenchRelationTargetItem
  | MessageItem;

export type PlpgsqlConnectionTreeItem = ServerItem | AddServerItem | DebugSessionsItem;

export type WorkbenchTreeScope = "database" | "scratchpads";

class WorkbenchTreeChildren {
  private scratchpadFilter = "";

  constructor(
    private readonly connections: ConnectionManager,
    private readonly index: WorkbenchIndexController,
    private readonly notebooks: SqlNotebookWorkspace,
    private readonly transactions: ScratchpadTransactionManager,
    private readonly ddlSync: WorkbenchDdlSyncController,
    private readonly debugSessionStatuses: () => readonly DebugSessionStatus[],
    private readonly scope: WorkbenchTreeScope,
  ) {}

  refresh(): void {
    // Children are resolved from the exact Connexion snapshot on every request.
  }

  setScratchpadFilter(filter: string): void {
    this.scratchpadFilter = filter.trim().toLocaleLowerCase();
  }

  async getChildren(element?: PlpgsqlTreeItem): Promise<PlpgsqlTreeItem[]> {
    if (!element) return this.rootChildren();
    if (element.kind === "server") {
      if (!this.connections.isServerConnected(element.server.id)) {
        return [new ConnectServerMessageItem(element.server)];
      }
      return [
        new DatabaseSourceItem(
          element.server,
          this.index.databaseState({
            serverId: element.server.id,
            database: element.server.database,
          }),
        ),
      ];
    }
    if (element.kind === "databaseSource") return this.databaseChildren(element);
    if (element.kind === "sourcesSnapshot") return this.sourceChildren(element);
    if (element.kind === "sqlNotebook") {
      return [
        new ScratchpadAssociationItem(element, element.association, element.connected),
        ...(element.transaction ? [new ScratchpadTransactionItem(element.transaction)] : []),
      ];
    }
    if (element.kind === "scratchpadTransaction") {
      return element.transaction.statements.map(
        (statement, index) => new ScratchpadStatementItem(element.transaction, statement, index),
      );
    }
    if (element.kind === "schema") return this.schemaChildren(element.server, element.schema);
    if (element.kind === "extensionGroup") {
      return element.objects.map((object) => objectTreeItem(object, element.snapshot));
    }
    if (element.kind === "function" || element.kind === "object") {
      return this.objectChildren(element);
    }
    if (element.kind === "relationGroup") {
      return element.group.targets.map(
        (target) => new WorkbenchRelationTargetItem(target, element.snapshot),
      );
    }
    return [];
  }

  private async rootChildren(): Promise<PlpgsqlTreeItem[]> {
    if (this.scope === "scratchpads") return this.scratchpads();
    return [
      ...this.connections.servers.map((server) => {
        const connected = this.connections.isServerConnected(server.id);
        return new ServerItem(server, connected, this.connections.debugCapabilityFor(server.id));
      }),
      new AddServerItem(),
    ];
  }

  private async databaseChildren(element: DatabaseSourceItem): Promise<PlpgsqlTreeItem[]> {
    const state = this.index.databaseState({
      serverId: element.server.id,
      database: element.server.database,
    });
    const children: PlpgsqlTreeItem[] = [
      new WorkbenchDdlSyncItem(element.server, this.ddlSync.state(element.server.id)),
      new SourcesSnapshotItem(element.server, state),
    ];
    children.push(await this.debugSessionsItem(element.server.id));
    return children;
  }

  private sourceChildren(element: SourcesSnapshotItem): PlpgsqlTreeItem[] {
    const identity = { serverId: element.server.id, database: element.server.database };
    const state = this.index.databaseState(identity);
    const schemaNames = listWorkbenchSchemas(this.index.databaseSymbols(identity), identity);
    const children: PlpgsqlTreeItem[] = [];
    if (!state.result) return children;
    if (schemaNames.length === 0) {
      children.push(new MessageItem("No PostgreSQL objects in the index"));
      return children;
    }
    children.push(...schemaNames.map((schema) => new SchemaItem(element.server, schema)));
    return children;
  }

  private async scratchpads(): Promise<PlpgsqlTreeItem[]> {
    const entries = await this.notebooks.list();
    const items = entries.map((entry) => {
      const association = resolveScratchpadAssociation(entry.metadata, this.connections.servers);
      const connected =
        association.status === "associated" &&
        this.connections.isServerConnected(association.connection.id);
      return new SqlNotebookItem(
        entry,
        association,
        scratchpadExecutionMode(entry.metadata),
        this.transactions.transaction(entry.uri.toString()),
        connected,
      );
    });
    if (!this.scratchpadFilter) return items;
    return items.filter((item) =>
      `${String(item.label)} ${String(item.description ?? "")}`
        .toLocaleLowerCase()
        .includes(this.scratchpadFilter),
    );
  }

  private schemaChildren(server: ServerConfig, schema: string): PlpgsqlTreeItem[] {
    const identity = { serverId: server.id, database: server.database };
    const result = this.index.databaseState(identity).result;
    if (!result) return [];
    const objects = buildWorkbenchObjects(this.index.databaseSymbols(identity), identity, schema);
    const userObjects: WorkbenchObjectModel[] = [];
    const extensionObjects = new Map<string, WorkbenchObjectModel[]>();
    for (const object of objects) {
      const origin = this.index.databaseObjectOrigin(identity, object.sourceUri);
      if (origin?.kind !== "extension") {
        userObjects.push(object);
        continue;
      }
      const group = extensionObjects.get(origin.extension) ?? [];
      group.push(object);
      extensionObjects.set(origin.extension, group);
    }
    return [
      ...userObjects.map((object) => objectTreeItem(object, result)),
      ...[...extensionObjects.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([extension, owned]) => new ExtensionGroupItem(schema, extension, owned, result)),
    ];
  }

  private async objectChildren(
    element: FunctionItem | WorkbenchObjectItem,
  ): Promise<PlpgsqlTreeItem[]> {
    const members =
      element.kind === "object"
        ? buildWorkbenchTableMembers(
            this.index.databaseSymbols({
              serverId: element.object.serverId,
              database: element.object.database,
            }),
            element.object,
          ).map((member) => new WorkbenchTableMemberItem(member, element.object))
        : [];
    const relations = await this.index.relations(element.object, element.snapshot);
    switch (relations.status) {
      case "available":
        return [
          ...members,
          ...relations.groups.map(
            (group) => new WorkbenchRelationGroupItem(group, element.snapshot, element.object),
          ),
        ];
      case "empty":
        return members.length > 0 ? members : [new MessageItem("No direct indexed relations")];
      case "stale":
        return [
          ...members,
          new ReindexDatabaseMessageItem("Relations are stale — reindex the database"),
        ];
      case "missing":
        return [...members, new MessageItem("The indexed object no longer exists")];
      case "ambiguous":
        return [...members, new MessageItem("The selected object is ambiguous in the index")];
      case "error":
        return [...members, new MessageItem(`Relations unavailable: ${relations.message}`)];
    }
  }

  private async debugSessionsItem(serverId: string): Promise<DebugSessionsItem> {
    let sessions: DebugSessionInfo[] | undefined;
    const client = this.connections.getClient(serverId);
    try {
      if (client) {
        sessions = enrichDebugSessions(
          await listDebugSessions(client),
          this.debugSessionStatuses(),
        );
      }
    } catch {}
    const server = this.connections.store.get(serverId);
    if (!server) throw new Error(`Unknown Connexion: ${serverId}`);
    return new DebugSessionsItem(server, sessions?.length, sessions);
  }
}

export class WorkbenchTreeProvider
  implements vscode.TreeDataProvider<PlpgsqlTreeItem>, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<PlpgsqlTreeItem | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private readonly subscriptions: vscode.Disposable[];
  private readonly children: WorkbenchTreeChildren;
  private readonly expandedSources = new Set<string>();
  private readonly materializedSchemas = new Set<string>();
  private readonly visibleObjects = new Map<string, FunctionItem | WorkbenchObjectItem>();
  private readonly visibleItems = new Map<string, PlpgsqlTreeItem>();

  constructor(
    private readonly connections: ConnectionManager,
    private readonly index: WorkbenchIndexController,
    notebooks: SqlNotebookWorkspace,
    transactions: ScratchpadTransactionManager,
    ddlSync: WorkbenchDdlSyncController,
    debugSessionStatuses: () => readonly DebugSessionStatus[] = () => [],
    private readonly scope: WorkbenchTreeScope = "database",
  ) {
    this.children = new WorkbenchTreeChildren(
      connections,
      index,
      notebooks,
      transactions,
      ddlSync,
      debugSessionStatuses,
      scope,
    );
    this.subscriptions = [connections.onChanged((change) => this.refreshConnections(change))];
    if (scope === "database") {
      this.subscriptions.push(
        index.onDidChangeState((state) => this.refreshIndex(state)),
        ddlSync.onDidChangeState((state) => this.refreshDdlSync(state)),
      );
    } else {
      this.subscriptions.push(
        notebooks.onDidChangeEntries(() => this.refresh()),
        transactions.onDidChange(() => this.refresh()),
      );
    }
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.changeEmitter.dispose();
  }

  refresh(resetMaterialized = false): void {
    this.children.refresh();
    if (resetMaterialized) {
      this.visibleItems.clear();
      this.expandedSources.clear();
      this.materializedSchemas.clear();
      this.visibleObjects.clear();
    }
    this.changeEmitter.fire(undefined);
  }

  setScratchpadFilter(filter: string): void {
    if (this.scope !== "scratchpads") return;
    this.children.setScratchpadFilter(filter);
    this.refresh();
  }

  refreshServer(serverId: string | undefined): void {
    if (!serverId) return;
    this.refreshConnections({
      serverIds: [serverId],
      rootsChanged: false,
    });
  }

  private refreshConnections(change: ConnectionChange): void {
    if (change.rootsChanged) {
      this.refresh(true);
      return;
    }
    if (this.scope === "scratchpads") {
      this.refreshScratchpadConnections(change.serverIds);
      return;
    }
    for (const serverId of change.serverIds) {
      const server = this.connections.store.get(serverId);
      if (!server) continue;
      const connected = this.connections.isServerConnected(serverId);
      this.emitUpdated(
        new ServerItem(server, connected, this.connections.debugCapabilityFor(serverId)),
      );
      const state = this.index.databaseState({ serverId, database: server.database });
      this.emitUpdated(new DatabaseSourceItem(server, state));
      this.emitUpdated(new SourcesSnapshotItem(server, state));
    }
  }

  private refreshScratchpadConnections(serverIds: readonly string[]): void {
    const changed = new Set(serverIds);
    for (const visible of [...this.visibleItems.values()]) {
      if (visible.kind !== "sqlNotebook") continue;
      const association = resolveScratchpadAssociation(
        visible.entry.metadata,
        this.connections.servers,
      );
      const previousId =
        visible.association.status === "unassociated"
          ? undefined
          : visible.association.snapshot.serverId;
      const nextId =
        association.status === "unassociated" ? undefined : association.snapshot.serverId;
      if (!changed.has(previousId ?? "") && !changed.has(nextId ?? "")) continue;
      const connected =
        association.status === "associated" &&
        this.connections.isServerConnected(association.connection.id);
      const replacement = new SqlNotebookItem(
        visible.entry,
        association,
        visible.mode,
        visible.transaction,
        connected,
      );
      this.emitUpdated(replacement);
      this.emitUpdated(new ScratchpadAssociationItem(replacement, association, connected));
    }
  }

  searchObjects(query: string, limit = 100): WorkbenchObjectModel[] {
    return this.connections.connectedServerIds
      .flatMap((serverId) => {
        const server = this.connections.store.get(serverId);
        if (!server) return [];
        const identity = { serverId, database: server.database };
        return searchWorkbenchObjects(
          this.index.databaseSymbols(identity),
          identity,
          query,
          Number.MAX_SAFE_INTEGER,
        ).filter(
          (object) =>
            this.index.databaseObjectOrigin(identity, object.sourceUri)?.kind !== "extension",
        );
      })
      .slice(0, Math.max(0, limit));
  }

  getTreeItem(element: PlpgsqlTreeItem): vscode.TreeItem {
    if (element.id && !this.visibleItems.has(element.id)) {
      this.visibleItems.set(element.id, element);
    }
    if (element.kind === "function" || element.kind === "object") {
      this.visibleObjects.set(element.object.sourceUri, element);
    }
    if (element.kind === "function") {
      const state = this.index.databaseState({
        serverId: element.object.serverId,
        database: element.object.database,
      });
      const result = state.result;
      element.contextValue =
        state.status !== "indexing" &&
        result?.serverId === element.object.serverId &&
        result.database === element.object.database
          ? "postgresql-workbench-function-debuggable"
          : "postgresql-workbench-function";
    }
    return element;
  }

  sourcesItem(serverId: string): SourcesSnapshotItem | undefined {
    const server = this.connections.store.get(serverId);
    if (!server || !this.connections.isServerConnected(server.id)) return undefined;
    const id = `postgres-sources:${server.id}`;
    const visible = this.visibleItems.get(id);
    const state = this.index.databaseState({ serverId: server.id, database: server.database });
    return visible?.kind === "sourcesSnapshot" ? visible : new SourcesSnapshotItem(server, state);
  }

  getParent(element: PlpgsqlTreeItem): PlpgsqlTreeItem | undefined {
    if (element.kind === "schema") {
      const state = this.index.databaseState({
        serverId: element.server.id,
        database: element.server.database,
      });
      return this.canonicalItem(new SourcesSnapshotItem(element.server, state));
    }
    if (element.kind === "databaseSource") {
      return this.canonicalItem(
        new ServerItem(
          element.server,
          this.connections.isServerConnected(element.server.id),
          this.connections.debugCapabilityFor(element.server.id),
        ),
      );
    }
    if (
      element.kind === "sourcesSnapshot" ||
      element.kind === "ddlSync" ||
      element.kind === "debugSessions"
    ) {
      const server = element.server;
      return server
        ? this.canonicalItem(
            new DatabaseSourceItem(
              server,
              this.index.databaseState({ serverId: server.id, database: server.database }),
            ),
          )
        : undefined;
    }
    if (element.kind === "sqlNotebook") return undefined;
    if (element.kind === "scratchpadAssociation") {
      return element.scratchpad;
    }
    if (element.kind === "scratchpadTransaction") {
      const visible = this.visibleItems.get(element.transaction.scratchpadUri);
      return visible?.kind === "sqlNotebook" ? visible : undefined;
    }
    if (element.kind === "scratchpadStatement") {
      const transactionId = element.id?.replace(/:statement:\d+$/u, ":transaction");
      const visible = transactionId ? this.visibleItems.get(transactionId) : undefined;
      return visible?.kind === "scratchpadTransaction" ? visible : undefined;
    }
    if (
      element.kind === "function" ||
      element.kind === "object" ||
      element.kind === "extensionGroup"
    ) {
      return this.canonicalItem(
        new SchemaItem(
          this.connections.store.get(
            element.kind === "extensionGroup"
              ? (element.objects[0]?.serverId ?? "")
              : element.object.serverId,
          ) ?? {
            id:
              element.kind === "extensionGroup"
                ? (element.objects[0]?.serverId ?? "")
                : element.object.serverId,
            host: "",
            port: 0,
            database:
              element.kind === "extensionGroup"
                ? (element.objects[0]?.database ?? "")
                : element.object.database,
            user: "",
          },
          element.kind === "extensionGroup" ? element.schema : element.object.schema,
        ),
      );
    }
    return undefined;
  }

  itemForObject(object: WorkbenchObjectModel): FunctionItem | WorkbenchObjectItem | undefined {
    const identity = { serverId: object.serverId, database: object.database };
    const state = this.index.databaseState(identity);
    const result = state.result;
    if (
      state.status === "indexing" ||
      !result ||
      result.serverId !== object.serverId ||
      result.database !== object.database
    ) {
      return undefined;
    }
    const item = this.canonicalItem(objectTreeItem(object, result));
    return item.kind === "function" || item.kind === "object" ? item : undefined;
  }

  async getChildren(element?: PlpgsqlTreeItem): Promise<PlpgsqlTreeItem[]> {
    return (await this.children.getChildren(element)).map((child) => this.canonicalItem(child));
  }

  private canonicalItem<T extends PlpgsqlTreeItem>(candidate: T): T {
    if (!candidate.id) return candidate;
    const current = this.visibleItems.get(candidate.id);
    if (!current) {
      this.visibleItems.set(candidate.id, candidate);
      return candidate;
    }
    if (current !== candidate) synchronizeTreeItem(current, candidate);
    return current as T;
  }

  setExpanded(element: PlpgsqlTreeItem, expanded: boolean): void {
    if (element.kind === "sourcesSnapshot") {
      const scope = treeDatabaseScope(element.server.id, element.server.database);
      if (expanded) this.expandedSources.add(scope);
      else this.expandedSources.delete(scope);
      if (!expanded) {
        for (const key of this.materializedSchemas) {
          if (key.startsWith(`${scope}\0`)) this.materializedSchemas.delete(key);
        }
        this.forgetVisibleObjects(undefined, element.server);
      }
      return;
    }
    if (element.kind === "schema") {
      const key = treeSchemaScope(element.server.id, element.server.database, element.schema);
      if (expanded) this.materializedSchemas.add(key);
      else {
        this.materializedSchemas.delete(key);
        this.forgetVisibleObjects(element.schema, element.server);
      }
      return;
    }
  }

  private refreshIndex(changedState: WorkbenchIndexState): void {
    this.children.refresh();
    const serverId = changedState.serverId;
    if (!serverId) return;
    const server = this.connections.store.get(serverId);
    if (!server || !this.connections.isServerConnected(serverId)) return;
    const state = this.index.databaseState({ serverId, database: server.database });
    this.emitUpdated(new ServerItem(server, true, this.connections.debugCapabilityFor(server.id)));
    this.emitUpdated(new DatabaseSourceItem(server, state));
    this.emitUpdated(new SourcesSnapshotItem(server, state));
    if (state.status === "available" && state.result) {
      const identity = { serverId, database: server.database };
      const scope = treeDatabaseScope(serverId, server.database);
      if (this.expandedSources.has(scope)) {
        const changedSchemas =
          state.change?.kind === "incremental" ? new Set(state.change.schemas) : undefined;
        for (const key of this.materializedSchemas) {
          const schema = schemaFromTreeScope(key, scope);
          if (schema && (!changedSchemas || changedSchemas.has(schema))) {
            this.emitUpdated(new SchemaItem(server, schema));
          }
        }
      }
      this.refreshVisibleObjectSnapshots(
        buildWorkbenchObjects(this.index.databaseSymbols(identity), identity),
        state.result,
        state.change ? new Set(state.change.sourceUris) : undefined,
        identity,
      );
    }
  }

  private refreshVisibleObjectSnapshots(
    objects: readonly WorkbenchObjectModel[],
    result: WorkbenchIndexResult,
    changedUris?: ReadonlySet<string>,
    identity?: { serverId: string; database: string },
  ): void {
    const currentObjects = new Map(objects.map((object) => [object.sourceUri, object]));
    for (const [sourceUri, item] of this.visibleObjects) {
      if (
        identity &&
        (item.object.serverId !== identity.serverId || item.object.database !== identity.database)
      ) {
        continue;
      }
      const current = currentObjects.get(sourceUri);
      if (current) {
        this.emitUpdated(objectTreeItem(current, result));
      } else if (!changedUris || changedUris.has(sourceUri)) {
        this.visibleObjects.delete(sourceUri);
        if (item.id) this.visibleItems.delete(item.id);
      }
    }
  }

  private forgetVisibleObjects(schema?: string, server?: ServerConfig): void {
    for (const [sourceUri, item] of this.visibleObjects) {
      if (schema && item.object.schema !== schema) continue;
      if (
        server &&
        (item.object.serverId !== server.id || item.object.database !== server.database)
      ) {
        continue;
      }
      this.visibleObjects.delete(sourceUri);
      if (item.id) this.visibleItems.delete(item.id);
    }
  }

  private refreshDdlSync(state: WorkbenchDdlSyncState): void {
    const server = this.connections.store.get(state.serverId);
    if (server) this.emitUpdated(new WorkbenchDdlSyncItem(server, state));
  }

  private emitUpdated(replacement: PlpgsqlTreeItem): void {
    if (!replacement.id) return;
    const current = this.visibleItems.get(replacement.id);
    if (!current) return;
    synchronizeTreeItem(current, replacement);
    this.changeEmitter.fire(current);
  }
}

function treeDatabaseScope(serverId: string, database: string): string {
  return `${serverId}\0${database}`;
}

function treeSchemaScope(serverId: string, database: string, schema: string): string {
  return `${treeDatabaseScope(serverId, database)}\0${schema}`;
}

function schemaFromTreeScope(key: string, scope: string): string | undefined {
  const prefix = `${scope}\0`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
}

function synchronizeTreeItem(current: PlpgsqlTreeItem, replacement: PlpgsqlTreeItem): void {
  current.label = replacement.label;
  current.collapsibleState = replacement.collapsibleState;
  current.description = replacement.description;
  current.tooltip = replacement.tooltip;
  current.iconPath = replacement.iconPath;
  current.contextValue = replacement.contextValue;
  current.command = replacement.command;
  Object.assign(current, replacement);
}

export const SOURCES_DRAG_HINT = "Shift+drop into SQL composes; drop opens the Cockpit.";

/** Appends the drag hint to the hover tooltip while keeping the accessible name unchanged. */
function applyDragHint(item: vscode.TreeItem, tooltip: string): void {
  item.tooltip = `${tooltip}\n${SOURCES_DRAG_HINT}`;
  item.accessibilityInformation = { label: tooltip };
}

function objectLabel(object: WorkbenchObjectModel): string {
  if (object.kind === "function" || object.kind === "procedure") {
    return `${object.name}(${object.signature})`;
  }
  return object.name;
}

function objectThemeIcon(kind: WorkbenchObjectKind): vscode.ThemeIcon {
  return postgresThemeIcon(kind);
}

function themedIcon(id: string, color: string): vscode.ThemeIcon {
  return new vscode.ThemeIcon(id, new vscode.ThemeColor(color));
}

function postgresThemeIcon(kind: string): vscode.ThemeIcon {
  const visual = postgresVisual(kind);
  return themedIcon(visual.icon, visual.color);
}

function objectTreeItem(
  object: WorkbenchObjectModel,
  snapshot: Pick<WorkbenchIndexResult, "revision" | "generation">,
): FunctionItem | WorkbenchObjectItem {
  return object.plpgsql && (object.kind === "function" || object.kind === "procedure")
    ? new FunctionItem(object, snapshot)
    : new WorkbenchObjectItem(object, snapshot);
}

function relationLabel(
  relation: WorkbenchRelationKind,
  direction: WorkbenchRelationDirection,
): string {
  const labels: Record<WorkbenchRelationKind, { outgoing: string; incoming: string }> = {
    calls: { outgoing: "Calls", incoming: "Called by" },
    reads: { outgoing: "Reads", incoming: "Read by" },
    writes: { outgoing: "Writes", incoming: "Written by" },
    references: { outgoing: "References", incoming: "Referenced by" },
    uses_type: { outgoing: "Uses type", incoming: "Used as type by" },
  };
  return labels[relation][direction];
}

function ddlSyncDescription(state: WorkbenchDdlSyncState): string {
  switch (state.status) {
    case "disabled":
      return "disabled";
    case "provisioning-required":
      return "provisioning required";
    case "listening":
      return "listening";
    case "insufficient-privilege":
      return "insufficient privilege";
    case "unavailable":
      return "unavailable";
    case "desynchronized":
      return "desynchronized";
  }
}

function ddlSyncIcon(status: WorkbenchDdlSyncState["status"]): vscode.ThemeIcon {
  switch (status) {
    case "disabled":
      return new vscode.ThemeIcon("circle-slash");
    case "provisioning-required":
      return new vscode.ThemeIcon("tools");
    case "listening":
      return new vscode.ThemeIcon("radio-tower", new vscode.ThemeColor("testing.iconPassed"));
    case "insufficient-privilege":
      return new vscode.ThemeIcon("lock");
    case "unavailable":
    case "desynchronized":
      return new vscode.ThemeIcon("warning");
  }
}
