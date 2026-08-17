import * as vscode from "vscode";
import {
  classifySqlStatementCount,
  planSqlResultExecution,
} from "../../src/analysis/sqlStatements.js";
import type { SyntaxParser } from "../../src/analysis/syntaxTree.js";
import { parseCall, parseSqlCalls } from "../../src/callParser.js";
import type {
  DebugLaunchRoutineArgument,
  DebugLaunchRoutineTarget,
  DebugResultSource,
} from "../../src/debugger/launch/index.js";
import {
  clampDebugResultRows,
  DEBUG_RESULT_EVENT,
  DEBUG_RESULT_LIMITS,
  DEBUG_RESULT_STATUS_EVENT,
  DEBUG_SESSION_STATUS_EVENT,
  type DebugResult,
  type DebugResultEntry,
  type DebugResultStatus,
  type DebugSessionStatus,
} from "../../src/debugger/launch/index.js";
import { registerAcceptanceControl } from "./acceptanceControl.js";
import { CallSiteConnectionStore } from "./callSiteConnectionStore.js";
import { CodeMonikerContentProvider } from "./codeMonikerContentProvider.js";
import { ConnectionManager } from "./connectionManager.js";
import { openCoverageClient } from "./coverageConnection.js";
import { PgTapTestController } from "./coverageTestController.js";
import {
  buildRoutineArgs,
  buildRoutineTarget,
  configNameFromRoutine,
  configNameFromSql,
  resolveDebugConfiguration,
} from "./debugConfig.js";
import { DebugResultStore } from "./debugResultStore.js";
import { DEBUG_RESULTS_VIEW_ID, DebugResultsViewProvider } from "./debugResultsView.js";
import {
  DEBUG_LAUNCH_TOKEN_PROPERTY,
  type DebugLaunchDescriptor,
  DebugSessionController,
} from "./debugSessionController.js";
import { manageDebugSessions } from "./debugSessionRecoveryUi.js";
import { PlpgsqlDiagnosticsProvider } from "./diagnosticsProvider.js";
import { startDockerDebugDatabase } from "./dockerProvisioningUi.js";
import { PlpgsqlInlineValuesProvider } from "./plpgsqlInlineValues.js";
import { LEGEND, PlpgsqlSemanticTokensProvider } from "./plpgsqlSemanticTokens.js";
import {
  POSTGRES_SOURCE_LANGUAGE_IDS,
  postgresSourceLanguageId,
} from "./postgresDocumentLanguage.js";
import { closePostgresqlDapTabs } from "./postgresqlDapSource.js";
import { showRequirementsGuide } from "./requirementsGuide.js";
import { createRoutineComparisonHandler } from "./routineComparisonCommand.js";
import { type ServerConfig, ServerStore } from "./serverStore.js";
import {
  REFRESH_SQL_AUTHORING_CONTEXT_COMMAND,
  registerSqlAuthoring,
  resolveSqlAuthoringSettings,
  type SqlAuthoringNavigationTarget,
} from "./sqlAuthoring/client.js";
import { debuggableSqlCall, debuggableSqlDefinition } from "./sqlCodeLensPolicy.js";
import {
  type CommandCallSite,
  type CommandFunctionDefinition,
  type CommandSqlStatement,
  type DocumentConnectionTarget,
  type FunctionDefinition,
  SqlCodeLensProvider,
} from "./sqlCodeLensProvider.js";
import {
  registerSqlNotebook,
  type ScratchpadDebugger,
  type ScratchpadDebugOutcome,
} from "./sqlNotebook.js";
import type { SqlNotebookWorkspace } from "./sqlNotebookWorkspace.js";
import { executeSqlSelection, prepareSqlSelection } from "./sqlSelectionExecution.js";
import { WorkbenchDdlSyncController } from "./workbenchDdlSync.js";
import { WorkbenchGraphTreeSync } from "./workbenchGraph/treeSync.js";
import { registerWorkbenchGraphDropBridge } from "./workbenchGraphDropBridge.js";
import { WorkbenchGraphView } from "./workbenchGraphView.js";
import { WorkbenchIndexController, type WorkbenchIndexPhase } from "./workbenchIndexController.js";
import {
  actionsForWorkbenchSurface,
  buildWorkbenchObjectActions,
  type WorkbenchObjectAction,
  type WorkbenchObjectActionId,
  type WorkbenchObjectActionSurface,
} from "./workbenchObjectActions.js";
import { WorkbenchTreeDragAndDropController } from "./workbenchTreeDragAndDrop.js";
import {
  buildWorkbenchObjects,
  buildWorkbenchTableMembers,
  type WorkbenchObjectModel,
} from "./workbenchTreeModel.js";
import {
  FunctionItem,
  type PlpgsqlTreeItem,
  type ServerItem,
  type WorkbenchDdlSyncItem,
  type WorkbenchObjectItem,
  type WorkbenchRelationTargetItem,
  WorkbenchTreeProvider,
} from "./workbenchTreeProvider.js";

const out = vscode.window.createOutputChannel("PostgreSQL Workbench");

function selectionMatchesDatabase(
  item: PlpgsqlTreeItem | undefined,
  serverId: string,
  database: string,
): boolean {
  if (!item) return false;
  if (
    item.kind === "function" ||
    item.kind === "object" ||
    item.kind === "tableMember" ||
    item.kind === "relationGroup"
  ) {
    return item.object.serverId === serverId && item.object.database === database;
  }
  if (item.kind === "relationTarget") {
    return item.target.object?.serverId === serverId && item.target.object.database === database;
  }
  if (item.kind === "extensionGroup") {
    return item.objects.every(
      (object) => object.serverId === serverId && object.database === database,
    );
  }
  if (item.kind === "server" || item.kind === "databaseSource" || item.kind === "sourcesSnapshot") {
    return item.server.id === serverId && item.server.database === database;
  }
  return item.kind === "schema";
}

interface LaunchDebugConfig {
  name?: string;
  sql?: string;
  entryRoutine?: DebugLaunchRoutineTarget;
  routine?: DebugLaunchRoutineTarget;
  routineArgs?: DebugLaunchRoutineArgument[];
  resultLabel?: string;
  resultSource?: DebugResultSource;
  serverId?: string;
  preserveDatabaseContext?: boolean;
  stopOnEntry?: boolean;
}

interface WorkbenchObjectPick extends vscode.QuickPickItem {
  object: WorkbenchObjectModel;
}

interface WorkbenchObjectSelection {
  object: WorkbenchObjectModel;
  action: "open" | "graph" | "actions";
}

function workbenchObjectPicks(objects: readonly WorkbenchObjectModel[]): WorkbenchObjectPick[] {
  return objects.map((object) => ({
    label: `${object.schema}.${object.name}`,
    description: object.kind,
    detail: object.signature || `${object.database} · ${object.sourceUri}`,
    // The Workbench search already matches tokens across schema, name, kind, and
    // signature. Keep those results visible instead of letting QuickPick apply a
    // second, single-field fuzzy filter that can hide valid cross-field matches.
    alwaysShow: true,
    buttons: [
      {
        iconPath: new vscode.ThemeIcon("type-hierarchy"),
        tooltip: "Open Focused Graph",
      },
      {
        iconPath: new vscode.ThemeIcon("gear"),
        tooltip: "Show Object Actions",
      },
    ],
    object,
  }));
}

function pickWorkbenchObject(
  treeProvider: WorkbenchTreeProvider,
  initialQuery: string,
  onQueryChanged: (query: string) => void,
): Promise<WorkbenchObjectSelection | undefined> {
  const picker = vscode.window.createQuickPick<WorkbenchObjectPick>();
  picker.placeholder = "Search indexed PostgreSQL objects";
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  const update = (query: string) => {
    onQueryChanged(query);
    picker.items = workbenchObjectPicks(treeProvider.searchObjects(query, 200));
  };
  picker.value = initialQuery;
  update(initialQuery);

  return new Promise((resolve) => {
    let settled = false;
    const subscriptions: vscode.Disposable[] = [];
    const finish = (selection: WorkbenchObjectSelection | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
      picker.dispose();
      resolve(selection);
    };
    subscriptions.push(
      picker.onDidChangeValue(update),
      picker.onDidAccept(() => {
        const object = picker.activeItems[0]?.object;
        finish(object ? { object, action: "open" } : undefined);
      }),
      picker.onDidTriggerItemButton((event) => {
        finish({
          object: event.item.object,
          action: event.button.tooltip === "Show Object Actions" ? "actions" : "graph",
        });
      }),
      picker.onDidHide(() => finish(undefined)),
    );
    picker.show();
  });
}

async function launchDebug(
  cm: ConnectionManager,
  debugSessions: DebugSessionController,
  config: LaunchDebugConfig,
  parser: SyntaxParser,
): Promise<boolean> {
  if (vscode.debug.activeDebugSession?.type === "postgresql-workbench") {
    vscode.window.showWarningMessage("A PL/pgSQL debug session is already running.");
    return false;
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  const serverId = config.serverId ?? cm.activeServer?.id;
  const name =
    config.name ??
    (config.routine
      ? configNameFromRoutine(config.routine)
      : config.entryRoutine
        ? configNameFromRoutine(config.entryRoutine)
        : config.sql
          ? await configNameFromSql(config.sql, (sql) => parseCall(sql, parser))
          : "Debug PL/pgSQL");

  const debugConfig: vscode.DebugConfiguration = {
    type: "postgresql-workbench",
    request: "launch",
    name,
    ...config,
    stopOnEntry: config.stopOnEntry ?? true,
  };
  debugConfig.resultLabel =
    config.resultLabel ??
    String(debugConfig.name)
      .replace(/^Debug\s+/i, "")
      .trim();
  if (serverId) debugConfig.server = serverId;

  const launchToken = debugSessions.reserve(
    debugDescriptor(debugConfig, vscode.window.activeTextEditor?.viewColumn),
  );
  if (!launchToken) {
    const active = debugSessions.active;
    vscode.window.showWarningMessage(
      `A PL/pgSQL debug session is already ${active?.state ?? "running"}${active?.status?.routine ? ` for ${routineName(active.status.routine)}` : ""}.`,
    );
    return false;
  }
  debugConfig[DEBUG_LAUNCH_TOKEN_PROPERTY] = launchToken;

  out.appendLine(
    `launchDebug: ${debugConfig.name} target=${debugConfig.routine ? "routine" : "sql"} ` +
      `${debugConfig.sql ? `sql=${debugConfig.sql.slice(0, 80)}` : ""}`,
  );

  let started: boolean;
  try {
    started = await vscode.debug.startDebugging(folder, debugConfig);
  } catch (error) {
    debugSessions.cancelReservation(launchToken);
    throw error;
  }
  if (!started) {
    debugSessions.cancelReservation(launchToken);
    out.appendLine("launchDebug: startDebugging returned false — session not started");
    vscode.window.showWarningMessage(
      "PL/pgSQL debug not started — no server selected or configuration cancelled.",
    );
    return false;
  }

  await persistLaunchConfig(folder, debugConfig).catch((err) =>
    out.appendLine(`persistLaunchConfig failed: ${err}`),
  );
  return true;
}

/**
 * Write the launched configuration to .vscode/launch.json so the user can
 * relaunch with F5 or from the Run and Debug panel. Persisted configs contain
 * only the server ID and the target — never credentials.
 */
async function persistLaunchConfig(
  folder: vscode.WorkspaceFolder | undefined,
  debugConfig: vscode.DebugConfiguration,
): Promise<void> {
  if (!folder) return;

  const persisted: vscode.DebugConfiguration = {
    type: "postgresql-workbench",
    request: "launch",
    name: debugConfig.name,
  };
  if (debugConfig.server) persisted.server = debugConfig.server;
  if (debugConfig.sql) persisted.sql = debugConfig.sql;
  if (debugConfig.entryRoutine) persisted.entryRoutine = debugConfig.entryRoutine;
  if (debugConfig.routine) persisted.routine = debugConfig.routine;
  if (debugConfig.routineArgs) persisted.routineArgs = debugConfig.routineArgs;
  persisted.stopOnEntry = debugConfig.stopOnEntry ?? true;
  if (debugConfig.preserveDatabaseContext) persisted.preserveDatabaseContext = true;

  const launch = vscode.workspace.getConfiguration("launch", folder.uri);
  const configs = [...(launch.get<vscode.DebugConfiguration[]>("configurations") ?? [])];
  const existing = configs.findIndex(
    (c) => c.type === "postgresql-workbench" && c.name === persisted.name,
  );
  if (existing >= 0) {
    if (JSON.stringify(configs[existing]) === JSON.stringify(persisted)) return;
    configs[existing] = persisted;
  } else {
    configs.push(persisted);
  }
  await launch.update("configurations", configs, vscode.ConfigurationTarget.WorkspaceFolder);
}

async function promptArgs(def: FunctionDefinition): Promise<string[] | undefined> {
  if (def.params.length === 0) return [];
  const values: string[] = [];
  for (const param of def.params) {
    const label = param.name ? `${param.name} (${param.type})` : param.type;
    const value = await vscode.window.showInputBox({
      prompt: `Value for parameter: ${label} (type NULL for SQL NULL)`,
      placeHolder: param.type,
      ignoreFocusOut: true,
    });
    if (value === undefined) return undefined;
    values.push(value);
  }
  return values;
}

async function assignDocumentConnection(
  cm: ConnectionManager,
  assignments: CallSiteConnectionStore,
  codeLens: SqlCodeLensProvider,
  target: DocumentConnectionTarget,
  requestedServerId?: string,
): Promise<boolean> {
  let server: ServerConfig | undefined;
  const current = assignments.getDocument(target.documentUri);
  if (requestedServerId) {
    server = cm.store.get(requestedServerId);
  } else if (cm.servers.length === 0) {
    const action = await vscode.window.showInformationMessage(
      "No saved Connexion is available for the Document Association.",
      "Add Server",
    );
    if (action !== "Add Server") return false;
    server = await cm.commands.addServer();
  } else if (cm.servers.length === 1) {
    server = cm.servers[0];
    if (server && current === server.id) {
      void vscode.window.showInformationMessage(
        `${server.name} is the only saved Connexion; add another server to change the Document Association.`,
      );
    }
  } else {
    const picked = await vscode.window.showQuickPick(
      cm.servers.map((candidate) => ({
        label: candidate.name,
        description: [
          current === candidate.id ? "Current Association" : undefined,
          cm.isActiveServer(candidate.id) ? "Active DatabaseContext" : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
        server: candidate,
      })),
      {
        title: "Document Association",
        placeHolder: "Saved Connexion used by Run and Debug in this document",
        ignoreFocusOut: true,
      },
    );
    server = picked?.server;
  }
  if (!server) return false;

  await assignments.assignDocument(target.documentUri, server.id);
  codeLens.refresh();
  await vscode.commands.executeCommand(REFRESH_SQL_AUTHORING_CONTEXT_COMMAND);
  return true;
}

/** Surface returned by activate() — consumed by integration tests. */
export interface PlpgsqlExtensionApi {
  connectionManager: ConnectionManager;
  workbenchTreeProvider: WorkbenchTreeProvider;
  /** @deprecated Use workbenchTreeProvider. */
  connectionTreeProvider: WorkbenchTreeProvider;
  /** @deprecated Use workbenchTreeProvider. */
  treeProvider: WorkbenchTreeProvider;
  resultStore: DebugResultStore;
  callSiteConnections: CallSiteConnectionStore;
  debugSessions: DebugSessionController;
  coverageTests: PgTapTestController;
  workbenchIndex: WorkbenchIndexController;
  workbenchDdlSync: WorkbenchDdlSyncController;
  workbenchGraph: WorkbenchGraphView;
  sqlNotebooks: SqlNotebookWorkspace;
  workbenchObjectActions(object: WorkbenchObjectModel): Promise<WorkbenchObjectAction[]>;
  runWorkbenchObjectAction(
    action: WorkbenchObjectActionId,
    object: WorkbenchObjectModel,
    snapshot: { revision: string; generation: number | null },
  ): Promise<unknown>;
  workbenchSearchQuery(): string;
  resultsViewVisible(): boolean;
}

function registerResultCommands(
  context: vscode.ExtensionContext,
  resultStore: DebugResultStore,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("postgresql-workbench.results.clear", () =>
      resultStore.clear(),
    ),
    vscode.commands.registerCommand("postgresql-workbench.results.copy", async () => {
      const text = resultStore.selectedAsTsv();
      if (text === undefined) {
        await vscode.window.showInformationMessage("No successful PL/pgSQL result to copy.");
        return false;
      }
      const selected = resultStore.selected;
      if (selected?.truncated && !(await confirmIncompleteResult(selected, "Copy"))) return false;
      await vscode.env.clipboard.writeText(text);
      vscode.window.setStatusBarMessage("PL/pgSQL captured result copied", 2_000);
      return true;
    }),
    vscode.commands.registerCommand("postgresql-workbench.results.export", async () => {
      const selected = resultStore.selected;
      if (!selected) {
        await vscode.window.showInformationMessage("No successful PL/pgSQL result to export.");
        return false;
      }
      if (selected.truncated && !(await confirmIncompleteResult(selected, "Export"))) return false;
      const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
      const defaultUri = workspaceUri
        ? vscode.Uri.joinPath(workspaceUri, `postgresql-workbench-result-${selected.id}.csv`)
        : undefined;
      const target = await vscode.window.showSaveDialog({
        defaultUri,
        saveLabel: "Export captured result",
        filters: {
          CSV: ["csv"],
          JSON: ["json"],
        },
      });
      if (!target) return false;
      const contents = target.path.toLowerCase().endsWith(".json")
        ? resultStore.selectedAsJson()
        : resultStore.selectedAsCsv();
      if (contents === undefined) return false;
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(contents));
      vscode.window.setStatusBarMessage(
        `PL/pgSQL captured result exported to ${target.fsPath}`,
        3_000,
      );
      return true;
    }),
  );
}

interface DebugCommandOptions {
  context: vscode.ExtensionContext;
  connections: ConnectionManager;
  documentConnections: CallSiteConnectionStore;
  tree: WorkbenchTreeProvider;
  sessions: DebugSessionController;
  index: WorkbenchIndexController;
  output: vscode.OutputChannel;
}

interface ConnectionCommandOptions {
  context: vscode.ExtensionContext;
  connections: ConnectionManager;
  ddlSync: WorkbenchDdlSyncController;
  codeLens: SqlCodeLensProvider;
  output: vscode.OutputChannel;
}

interface WorkbenchCommandOptions {
  context: vscode.ExtensionContext;
  connections: ConnectionManager;
  index: WorkbenchIndexController;
  tree: WorkbenchTreeProvider;
  graph: WorkbenchGraphView;
  graphSync: WorkbenchGraphTreeSync;
  coverage: PgTapTestController;
  resultStore: DebugResultStore;
  resultsView: DebugResultsViewProvider;
  objectActions: (object: WorkbenchObjectModel) => Promise<WorkbenchObjectAction[]>;
  runObjectAction: (
    action: WorkbenchObjectActionId,
    object: WorkbenchObjectModel,
    snapshot: { revision: string; generation: number | null },
  ) => Promise<unknown>;
  search: { query: string };
}

interface SqlWorkbenchCommandOptions extends WorkbenchCommandOptions {
  codeLens: SqlCodeLensProvider;
  documentConnections: CallSiteConnectionStore;
  revealSources(): Thenable<void>;
  selectedTreeItems(): readonly PlpgsqlTreeItem[];
}

/** Opens the PostgreSQL client for a free SQL document's Document Association. */
async function openDocumentSqlClient(
  connections: ConnectionManager,
  server: ServerConfig,
  documentUri: string,
  reassign: () => Promise<boolean>,
): Promise<Awaited<ReturnType<typeof openCoverageClient>> | undefined> {
  const timeoutMs = vscode.workspace
    .getConfiguration("postgresql-workbench.sql")
    .get<number>("statementTimeoutMs", 60_000);
  try {
    return await openCoverageClient(connections, server.id, {
      applicationName: "postgresql-workbench:sql",
      statementTimeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    out.appendLine(`SQL execution connection failed (${server.name}, ${documentUri}): ${detail}`);
    const password = await connections.store.getPassword(server.id);
    const choice =
      password === undefined
        ? await vscode.window.showErrorMessage(
            `Connexion ${server.name} has no saved password.`,
            "Change Password",
            "Change Association",
          )
        : await vscode.window.showErrorMessage(
            `Cannot connect to ${server.name}. See the PostgreSQL Workbench output for details.`,
            "Show Output",
            "Change Association",
          );
    if (choice === "Change Password") await connections.commands.changePassword(server.id);
    else if (choice === "Change Association") await reassign();
    else if (choice === "Show Output") out.show(true);
    return undefined;
  }
}

function registerSqlWorkbenchCommands(options: SqlWorkbenchCommandOptions): void {
  const {
    context,
    connections,
    documentConnections,
    index,
    tree,
    coverage,
    resultStore,
    resultsView,
  } = options;
  context.subscriptions.push(
    vscode.commands.registerCommand("postgresql-workbench.refreshTree", () => tree.refresh()),
    vscode.commands.registerCommand("postgresql-workbench.refreshTests", () => coverage.refresh()),
    vscode.commands.registerCommand("postgresql-workbench.executeSqlSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage("Open a SQL editor and select a query first.");
        return false;
      }
      const document = editor.document;
      const selected = prepareSqlSelection({
        languageId: document.languageId,
        documentText: document.getText(),
        selectionStart: document.offsetAt(editor.selection.start),
        selectionEnd: document.offsetAt(editor.selection.end),
        source: {
          name:
            vscode.workspace.asRelativePath(document.uri, false) ||
            document.uri.path.split("/").at(-1) ||
            document.uri.toString(),
          uri: document.uri.toString(),
          line: editor.selection.start.line + 1,
        },
      });
      if (selected.status === "unsupported-language") {
        void vscode.window.showInformationMessage(
          "SQL selection execution is available only in SQL and PL/pgSQL editors.",
        );
        return false;
      }
      if (selected.status === "empty-selection") {
        void vscode.window.showInformationMessage("Select the SQL text to execute.");
        return false;
      }
      if (document.uri.scheme === CodeMonikerContentProvider.SCHEME) {
        void vscode.window.showInformationMessage(
          "Managed PostgreSQL definitions are not run as selections. Use Deploy or Debug deployed routine.",
        );
        return false;
      }
      let serverId = documentConnections.getDocument(document.uri.toString());
      if (!serverId) {
        const assigned = await assignDocumentConnection(
          connections,
          documentConnections,
          options.codeLens,
          { documentUri: document.uri.toString() },
        );
        if (!assigned) return false;
        serverId = documentConnections.getDocument(document.uri.toString());
      }
      const server = serverId ? connections.store.get(serverId) : undefined;
      if (!server) {
        void vscode.window.showInformationMessage("Choose an available Document Association.");
        return false;
      }
      const client = await openDocumentSqlClient(connections, server, document.uri.toString(), () =>
        assignDocumentConnection(connections, documentConnections, options.codeLens, {
          documentUri: document.uri.toString(),
        }),
      );
      if (!client) return false;
      let result: Awaited<ReturnType<typeof executeSqlSelection>>;
      try {
        result = await executeSqlSelection(client, selected, resultStore, {
          maxRows: clampDebugResultRows(
            vscode.workspace
              .getConfiguration("postgresql-workbench.results")
              .get<number>("maxRows", DEBUG_RESULT_LIMITS.DEFAULT_ROWS),
          ),
          classifyStatementCount: async (sql) =>
            classifySqlStatementCount(sql, await index.syntaxParser(), sqlSyntaxAnalysisBudget()),
          onStarted: () => resultsView.reveal(true),
        });
      } finally {
        await client.end().catch(() => {});
      }
      if ("status" in result && result.status === "multiple-statements") {
        void vscode.window.showInformationMessage("Select one PostgreSQL statement at a time.");
        return false;
      }
      if ("status" in result && result.status === "unclassifiable") {
        void vscode.window.showErrorMessage(
          "The selected SQL could not be classified safely and was not executed.",
        );
        return false;
      }
      resultsView.reveal(true);
      return result;
    }),
    vscode.commands.registerCommand(
      "postgresql-workbench.runSqlCall",
      async (statement: CommandSqlStatement) => {
        let serverId = documentConnections.getDocument(statement.documentUri);
        if (!serverId) {
          const assigned = await assignDocumentConnection(
            connections,
            documentConnections,
            options.codeLens,
            { documentUri: statement.documentUri },
          );
          if (!assigned) return false;
          serverId = documentConnections.getDocument(statement.documentUri);
        }
        const server = serverId ? connections.store.get(serverId) : undefined;
        if (!server) {
          void vscode.window.showInformationMessage("Choose an available Document Association.");
          return false;
        }
        const client = await openDocumentSqlClient(connections, server, statement.documentUri, () =>
          assignDocumentConnection(connections, documentConnections, options.codeLens, {
            documentUri: statement.documentUri,
          }),
        );
        if (!client) return false;
        try {
          const result = await executeSqlSelection(
            client,
            { status: "ready", sql: statement.sql, source: debugResultSource(statement) },
            resultStore,
            {
              maxRows: clampDebugResultRows(
                vscode.workspace
                  .getConfiguration("postgresql-workbench.results")
                  .get<number>("maxRows", DEBUG_RESULT_LIMITS.DEFAULT_ROWS),
              ),
              classifyStatementCount: async () => "single-statement",
              onStarted: () => resultsView.reveal(true),
            },
          );
          resultsView.reveal(true);
          return result;
        } finally {
          await client.end().catch(() => {});
        }
      },
    ),
    vscode.commands.registerCommand("postgresql-workbench.indexActiveDatabase", async () => {
      await options.revealSources();
      try {
        return await index.indexActiveDatabase();
      } catch (error) {
        if (index.state.status === "cancelled") return undefined;
        const message = error instanceof Error ? error.message : String(error);
        if (index.state.status !== "error" && index.state.status !== "stale") {
          void vscode.window.showErrorMessage(`PostgreSQL indexing failed: ${message}`);
        }
        return undefined;
      }
    }),
    vscode.commands.registerCommand(
      "postgresql-workbench.indexAssociation",
      async (target?: { serverId?: string }) => {
        const server = target?.serverId ? connections.store.get(target.serverId) : undefined;
        if (!server) {
          void vscode.window.showInformationMessage("Choose an available Association first.");
          return false;
        }
        if (connections.activeServer?.id === server.id) {
          await vscode.commands.executeCommand("postgresql-workbench.indexActiveDatabase");
          return true;
        }
        const client = await openDocumentSqlClient(
          connections,
          server,
          server.id,
          async () => false,
        );
        if (!client) return false;
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Indexing ${server.name}`,
            },
            () =>
              index.indexPostgresDatabase(client, {
                serverId: server.id,
                database: server.database,
              }),
          );
          options.codeLens.refresh();
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          out.appendLine(`Association indexing failed (${server.name}): ${message}`);
          void vscode.window.showErrorMessage(
            `Indexing ${server.name} failed. See the PostgreSQL Workbench output.`,
          );
          return false;
        } finally {
          await client.end().catch(() => {});
        }
      },
    ),
    vscode.commands.registerCommand("postgresql-workbench.cancelDatabaseIndex", () =>
      index.cancelActiveDatabaseIndex(),
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.openDatabaseObject",
      async (
        input?:
          | WorkbenchObjectModel
          | FunctionItem
          | WorkbenchObjectItem
          | WorkbenchRelationTargetItem,
        requestedSnapshot?: { revision: string; generation: number | null },
      ) => {
        const selected = input ?? options.selectedTreeItems()[0];
        if (!selected) return undefined;
        const object =
          "target" in selected
            ? selected.target.object
            : "object" in selected
              ? selected.object
              : "symbolUri" in selected
                ? selected
                : undefined;
        if (!object) return undefined;
        const itemSnapshot = "snapshot" in selected ? selected.snapshot : undefined;
        const snapshot = requestedSnapshot ?? itemSnapshot;
        const result = index.state.result;
        if (
          !result ||
          (snapshot &&
            (snapshot.revision !== result.revision || snapshot.generation !== result.generation))
        ) {
          void vscode.window.showWarningMessage(
            "This PostgreSQL object belongs to an outdated Workbench snapshot. Refresh the index and try again.",
          );
          return undefined;
        }
        const uri = index.documentUri(object.symbolUri);
        if (!uri) return undefined;
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.languages.setTextDocumentLanguage(
          document,
          postgresSourceLanguageId(object.kind),
        );
        await vscode.window.showTextDocument(document, { preview: true });
        return uri;
      },
    ),
  );
}

function registerGraphWorkbenchCommands(options: WorkbenchCommandOptions): void {
  const {
    context,
    index,
    tree,
    graph,
    graphSync,
    coverage,
    objectActions,
    runObjectAction,
    search,
  } = options;
  context.subscriptions.push(
    vscode.commands.registerCommand("postgresql-workbench.openDatabaseGraph", async () => {
      const result = index.state.result;
      if (index.state.status === "indexing" || !result) {
        void vscode.window.showInformationMessage(
          "Index the active PostgreSQL database before opening its graph.",
        );
        return false;
      }
      const candidate = graphSync.currentSelection;
      const selected = selectionMatchesDatabase(candidate, result.serverId, result.database)
        ? candidate
        : undefined;
      if (selected?.kind === "function" || selected?.kind === "object") {
        return graph.open(selected.object, result);
      }
      if (selected?.kind === "tableMember" || selected?.kind === "relationGroup") {
        return graph.open(selected.object, result);
      }
      if (selected?.kind === "relationTarget" && selected.target.object) {
        return graph.open(selected.target.object, result);
      }
      const database = { serverId: result.serverId, database: result.database };
      if (selected?.kind === "schema" || selected?.kind === "extensionGroup") {
        return graph.openSchema(database, selected.schema, result);
      }
      return graph.openDatabase(database, result);
    }),
    vscode.commands.registerCommand(
      "postgresql-workbench.openObjectGraph",
      async (
        input: WorkbenchObjectModel | FunctionItem | WorkbenchObjectItem | undefined,
        requestedSnapshot?: { revision: string; generation: number | null },
      ) => {
        const result = index.state.result;
        if (!input) {
          void vscode.window.showInformationMessage(
            "Choose a PostgreSQL object from the Workbench tree or search first.",
          );
          return false;
        }
        const object = "object" in input ? input.object : input;
        const itemSnapshot = "snapshot" in input ? input.snapshot : undefined;
        const snapshot = requestedSnapshot ?? itemSnapshot ?? result;
        if (
          index.state.status === "indexing" ||
          !result ||
          !snapshot ||
          snapshot.revision !== result.revision ||
          snapshot.generation !== result.generation
        ) {
          void vscode.window.showWarningMessage(
            "This PostgreSQL object belongs to an outdated Workbench snapshot. Refresh the index and try again.",
          );
          return false;
        }
        return graph.open(object, snapshot);
      },
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.revealDatabaseObjectInTree",
      async (item: WorkbenchRelationTargetItem) => {
        const object = item?.target.object;
        const result = index.state.result;
        if (
          !object ||
          index.state.status === "indexing" ||
          !result ||
          item.snapshot.revision !== result.revision ||
          item.snapshot.generation !== result.generation
        ) {
          void vscode.window.showWarningMessage(
            "This PostgreSQL reference belongs to an outdated Workbench snapshot. Refresh the index and try again.",
          );
          return false;
        }
        return graphSync.navigateToObject(object);
      },
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.showObjectActions",
      async (
        input: WorkbenchObjectModel | FunctionItem | WorkbenchObjectItem | undefined,
        requestedSnapshot?: { revision: string; generation: number | null },
        surface: WorkbenchObjectActionSurface = "default",
      ) => {
        const result = index.state.result;
        if (!input || !result) return false;
        const object = "object" in input ? input.object : input;
        const itemSnapshot = "snapshot" in input ? input.snapshot : undefined;
        const snapshot = requestedSnapshot ?? itemSnapshot ?? result;
        if (
          result.serverId !== object.serverId ||
          result.database !== object.database ||
          snapshot.revision !== result.revision ||
          snapshot.generation !== result.generation
        ) {
          void vscode.window.showWarningMessage(
            "This PostgreSQL object belongs to an outdated Workbench snapshot. Refresh the index and try again.",
          );
          return false;
        }
        const actions = actionsForWorkbenchSurface(await objectActions(object), surface).filter(
          (action) =>
            index.state.status !== "indexing" ||
            action.id === "open-definition" ||
            action.id === "open-deployed-source",
        );
        if (actions.length === 0) return false;
        const selected = await vscode.window.showQuickPick(
          actions.map((action) => ({
            label: action.label,
            description: action.description,
            iconPath: new vscode.ThemeIcon(action.icon),
            action,
          })),
          {
            placeHolder: `Actions for ${object.schema}.${object.name}`,
            matchOnDescription: true,
          },
        );
        return selected ? runObjectAction(selected.action.id, object, snapshot) : undefined;
      },
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.searchDatabaseObjects",
      async (context?: unknown) => {
        const query = typeof context === "string" ? context : undefined;
        if (query !== undefined) search.query = query;
        const result = index.state.result;
        if (!result) {
          const action = await vscode.window.showInformationMessage(
            "Index the active PostgreSQL database before searching its objects.",
            "Index Database",
          );
          if (action === "Index Database") {
            await vscode.commands.executeCommand("postgresql-workbench.indexActiveDatabase");
          }
          return undefined;
        }
        const objects = query ? tree.searchObjects(query, 500) : [];
        const updateQuery = (value: string) => {
          search.query = value;
        };
        const selection = query
          ? objects.length === 1
            ? { object: objects[0], action: "open" as const }
            : await pickWorkbenchObject(tree, query, updateQuery)
          : await pickWorkbenchObject(tree, search.query, updateQuery);
        if (query && objects.length === 0) {
          await vscode.window.showInformationMessage(
            `No indexed PostgreSQL object matches "${query}".`,
          );
          return undefined;
        }
        if (!selection) return undefined;
        const command =
          selection.action === "graph"
            ? "postgresql-workbench.openObjectGraph"
            : selection.action === "actions"
              ? "postgresql-workbench.showObjectActions"
              : "postgresql-workbench.openDatabaseObject";
        return vscode.commands.executeCommand(command, selection.object, {
          revision: result.revision,
          generation: result.generation,
        });
      },
    ),
    vscode.commands.registerCommand("postgresql-workbench.exportCoverage", () =>
      coverage.coverageProfile.exportLastCoverage(),
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.revealRoutineTests",
      async (context?: unknown) => {
        const item = routineTreeContext(context);
        const revealed = item
          ? await coverage.revealRoutine(item.serverId, item.oid)
          : await coverage.revealActiveRoutine();
        if (!revealed) {
          await vscode.window.showInformationMessage(
            "No pgTAP tests are mapped to this PL/pgSQL routine.",
          );
        }
        return revealed;
      },
    ),
  );
}

function routineTreeContext(context: unknown): Pick<FunctionItem, "serverId" | "oid"> | undefined {
  if (!context || typeof context !== "object") return undefined;
  const candidate = context as { serverId?: unknown; oid?: unknown };
  return typeof candidate.serverId === "string" && typeof candidate.oid === "number"
    ? { serverId: candidate.serverId, oid: candidate.oid }
    : undefined;
}

function showCockpitObjectActions(
  object: WorkbenchObjectModel,
  snapshot: { revision: string; generation: number | null },
): Promise<unknown> {
  return Promise.resolve(
    vscode.commands.executeCommand(
      "postgresql-workbench.showObjectActions",
      object,
      snapshot,
      "cockpit",
    ),
  );
}

function registerConnectionCommands(options: ConnectionCommandOptions): void {
  const { context, connections, ddlSync, codeLens, output } = options;
  context.subscriptions.push(
    vscode.commands.registerCommand("postgresql-workbench.addServer", () =>
      connections.commands.addServer(),
    ),
    vscode.commands.registerCommand("postgresql-workbench.startDockerDebugDatabase", () =>
      startDockerDebugDatabase(connections, output),
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.connectServer",
      (target: string | ServerItem) =>
        connections.connectServer(typeof target === "string" ? target : target.server.id),
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.useDatabaseContextAsActive",
      (target: string | ServerItem | { server: ServerItem["server"] }) =>
        connections.connectServer(typeof target === "string" ? target : target.server.id),
    ),
    vscode.commands.registerCommand("postgresql-workbench.removeServer", (item: ServerItem) => {
      connections.commands.removeServer(item.server.id);
    }),
    vscode.commands.registerCommand("postgresql-workbench.editServer", (item: ServerItem) =>
      connections.commands.editServer(item.server.id),
    ),
    vscode.commands.registerCommand("postgresql-workbench.changePassword", (item: ServerItem) =>
      connections.commands.changePassword(item.server.id),
    ),
    vscode.commands.registerCommand("postgresql-workbench.disconnectServer", () =>
      connections.disconnect(),
    ),
    vscode.commands.registerCommand("postgresql-workbench.pickConnection", async () => {
      const ok = await connections.commands.pickConnection();
      if (ok) codeLens.refresh();
    }),
    vscode.commands.registerCommand(
      "postgresql-workbench.configureWorkbenchSchemaSync",
      async (item?: WorkbenchDdlSyncItem) => {
        let server = item?.server;
        if (!server) {
          const pickedServer = await vscode.window.showQuickPick(
            connections.servers.map((candidate) => ({
              label: candidate.name,
              description: candidate.id,
              server: candidate,
            })),
            { placeHolder: "Select a PostgreSQL DatabaseContext" },
          );
          server = pickedServer?.server;
        }
        if (!server) return false;
        const configuration = ddlSync.configuration(server);
        const state = ddlSync.state(server.id);
        const picked = await vscode.window.showQuickPick(
          [
            {
              label: configuration.enabled
                ? "$(circle-slash) Disable for this DatabaseContext"
                : "$(radio-tower) Enable for this DatabaseContext",
              detail: configuration.enabled ? "disable" : "enable",
            },
            {
              label: "$(settings) Use User/Workspace Settings",
              description: "Clear connection-specific overrides",
              detail: "settings",
            },
            {
              label: "$(symbol-namespace) Change support schema...",
              description: configuration.supportSchema,
              detail: "schema",
            },
            {
              label: "$(settings-gear) Open extension Settings",
              detail: "open-settings",
            },
            ...(state.status === "provisioning-required" ||
            state.status === "insufficient-privilege"
              ? [
                  {
                    label: "$(tools) Provision database objects...",
                    description: "Requires PostgreSQL superuser privileges",
                    detail: "provision",
                  },
                ]
              : []),
            ...(state.status === "listening" || state.status === "desynchronized"
              ? [
                  {
                    label: "$(trash) Remove database provisioning...",
                    detail: "remove",
                  },
                ]
              : []),
          ],
          { placeHolder: `Schema synchronization · ${server.name}` },
        );
        switch (picked?.detail) {
          case "enable":
            await ddlSync.setConnectionEnabled(server.id, true);
            return true;
          case "disable":
            await ddlSync.setConnectionEnabled(server.id, false);
            return true;
          case "settings":
            await connections.setSchemaSyncOverride(server.id, undefined);
            return true;
          case "schema": {
            const schema = await vscode.window.showInputBox({
              prompt: "PostgreSQL support schema (lower-case, unquoted identifier)",
              value: configuration.supportSchema,
              validateInput: (value) => {
                try {
                  ddlSync.configuration({
                    ...server,
                    schemaSync: { ...server.schemaSync, supportSchema: value },
                  });
                  return undefined;
                } catch (error) {
                  return error instanceof Error ? error.message : String(error);
                }
              },
            });
            if (schema !== undefined) {
              await ddlSync.setConnectionSupportSchema(server.id, schema);
            }
            return schema !== undefined;
          }
          case "open-settings":
            await vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "@ext:ng-galien.postgresql-workbench schema synchronization",
            );
            return true;
          case "provision":
            return vscode.commands.executeCommand(
              "postgresql-workbench.provisionWorkbenchSchemaSync",
              {
                server,
              },
            );
          case "remove":
            return vscode.commands.executeCommand(
              "postgresql-workbench.removeWorkbenchSchemaSyncProvisioning",
              { server },
            );
          default:
            return false;
        }
      },
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.provisionWorkbenchSchemaSync",
      async (item: Pick<WorkbenchDdlSyncItem, "server">) => {
        const configuration = ddlSync.configuration(item.server);
        const confirm = await vscode.window.showWarningMessage(
          `Provision schema synchronization on ${item.server.name}? This creates two database-level EVENT TRIGGER objects and notification functions in schema ${configuration.supportSchema}. PostgreSQL superuser privileges are required.`,
          { modal: true },
          "Provision",
        );
        if (confirm !== "Provision") return false;
        try {
          await ddlSync.provision(item.server.id);
          void vscode.window.showInformationMessage(
            `Schema synchronization is listening on ${item.server.name}.`,
          );
          return true;
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Schema synchronization provisioning failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        }
      },
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.removeWorkbenchSchemaSyncProvisioning",
      async (item: Pick<WorkbenchDdlSyncItem, "server">) => {
        const confirm = await vscode.window.showWarningMessage(
          `Remove Workbench schema synchronization from ${item.server.name}? The database-level event triggers and Workbench notification functions will be removed without CASCADE.`,
          { modal: true },
          "Remove Provisioning",
        );
        if (confirm !== "Remove Provisioning") return false;
        await ddlSync.removeProvisioning(item.server.id);
        return true;
      },
    ),
  );
}

function registerDebugCommands(options: DebugCommandOptions): void {
  const { context, connections, documentConnections, tree, sessions, index, output } = options;
  context.subscriptions.push(
    vscode.commands.registerCommand("postgresql-workbench.manageDebugSessions", () =>
      manageDebugSessions(connections, tree, output, () => sessions.statuses),
    ),
    vscode.commands.registerCommand("postgresql-workbench.checkRequirements", async () => {
      if (!connections.isConnected || !connections.activeServer) {
        const action = await vscode.window.showInformationMessage(
          "Not connected to a PostgreSQL server.",
          "Pick Connection",
          "Setup Guide",
        );
        if (action === "Pick Connection") await connections.commands.pickConnection();
        if (action === "Setup Guide") await showRequirementsGuide();
        return;
      }
      const check = await connections.checkRequirements();
      if (!check) return;
      if (check.available) {
        vscode.window.showInformationMessage(
          `${connections.activeServer.name}: pldbgapi ready — debugging available.`,
        );
      } else {
        const action = await vscode.window.showWarningMessage(check.error, "Setup Guide");
        if (action === "Setup Guide") await showRequirementsGuide();
      }
    }),
    vscode.commands.registerCommand(
      "postgresql-workbench.debugFromTree",
      async (item: FunctionItem) => {
        const params = item.params.map((param) => ({
          name: param.name,
          type: param.type,
          mode: "in" as const,
        }));
        const args = await promptArgs({
          schema: item.schema,
          name: item.funcName,
          params,
          line: 0,
          kind: item.isProc ? "procedure" : "function",
        });
        if (!args) return;
        await launchDebug(
          connections,
          sessions,
          {
            name: `Debug ${item.schema}.${item.funcName}`,
            serverId: item.serverId,
            routine: {
              symbolUri: item.symbolUri,
              schema: item.schema,
              name: item.funcName,
              kind: item.isProc ? "procedure" : "function",
              oid: item.oid,
              argTypes: item.params.map((param) => param.type),
            },
            routineArgs: buildRoutineArgs(args),
          },
          await index.syntaxParser(),
        );
      },
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.openFunction",
      async (item: FunctionItem) => {
        const uri = index.documentUri(item.symbolUri);
        if (!uri) return undefined;
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.languages.setTextDocumentLanguage(
          document,
          postgresSourceLanguageId(item.isProc ? "procedure" : "function"),
        );
        await vscode.window.showTextDocument(document, { preview: false });
      },
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.compareRoutineWithDatabase",
      createRoutineComparisonHandler(connections, index),
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.debugDefinition",
      async (definition: CommandFunctionDefinition) => {
        const serverId = definition.symbolUri
          ? definition.serverId
          : definition.documentUri
            ? documentConnections.getDocument(definition.documentUri)
            : definition.serverId;
        if (!serverId) {
          void vscode.window.showInformationMessage("Choose an available Document Association.");
          return false;
        }
        const args = await promptArgs(definition);
        if (!args) return;
        const identity = {
          ...(definition.oid ? { oid: definition.oid } : {}),
          ...(definition.symbolUri ? { symbolUri: definition.symbolUri } : {}),
        };
        const routine = buildRoutineTarget(definition, identity);
        await launchDebug(
          connections,
          sessions,
          {
            name: configNameFromRoutine(routine),
            serverId,
            preserveDatabaseContext: true,
            routine,
            routineArgs: buildRoutineArgs(args),
          },
          await index.syntaxParser(),
        );
      },
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.debugCall",
      async (call: CommandCallSite) => {
        const serverId = call.documentUri
          ? documentConnections.getDocument(call.documentUri)
          : call.serverId;
        if (!serverId) {
          void vscode.window.showInformationMessage("Choose an available Document Association.");
          return false;
        }
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor && activeEditor.document.uri.toString() === call.documentUri) {
          await vscode.window.showTextDocument(activeEditor.document, {
            viewColumn: activeEditor.viewColumn,
            preview: false,
            preserveFocus: true,
            selection: activeEditor.selection,
          });
        }
        const source = debugResultSource(call);
        await launchDebug(
          connections,
          sessions,
          {
            sql: call.sql,
            serverId,
            preserveDatabaseContext: true,
            resultLabel: source
              ? `${(await configNameFromSql(call.sql, async (sql) => parseCall(sql, await index.syntaxParser()))).replace(/^Debug\s+/i, "")} · ${source.name}${source.line ? `:${source.line}` : ""}`
              : undefined,
            resultSource: source,
          },
          await index.syntaxParser(),
        );
      },
    ),
  );
}

interface DebugInfrastructureOptions {
  context: vscode.ExtensionContext;
  connections: ConnectionManager;
  index: WorkbenchIndexController;
  sessions: DebugSessionController;
  output: vscode.OutputChannel;
  refreshTree: () => void;
  revealStoppedSource: (session: vscode.DebugSession, status: DebugSessionStatus) => void;
}

interface DebugInfrastructure {
  resultStore: DebugResultStore;
  resultsView: DebugResultsViewProvider;
  contentProvider: CodeMonikerContentProvider;
}

function registerDebugInfrastructure(options: DebugInfrastructureOptions): DebugInfrastructure {
  const { context, connections, index, sessions, output, refreshTree, revealStoppedSource } =
    options;
  const resultStore = new DebugResultStore();
  const resultsView = new DebugResultsViewProvider(resultStore);
  context.subscriptions.push(
    resultsView,
    vscode.window.registerWebviewViewProvider(DEBUG_RESULTS_VIEW_ID, resultsView, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
      if (event.session.type !== "postgresql-workbench") return;
      if (event.event === DEBUG_SESSION_STATUS_EVENT && isDebugSessionStatus(event.body)) {
        if (
          !sessions.observeStart(event.session.id, debugLaunchToken(event.session.configuration))
        ) {
          return;
        }
        if (!sessions.applyStatus(event.session.id, event.body)) return;
        output.appendLine(
          `debugSession: ${event.body.sessionId} state=${event.body.state}` +
            `${event.body.routine ? ` routine=${routineName(event.body.routine)} oid=${event.body.routine.oid}` : ""}` +
            `${event.body.listenerPid ? ` listener=${event.body.listenerPid}` : ""}` +
            `${event.body.targetPid ? ` target=${event.body.targetPid}` : ""}`,
        );
        refreshTree();
        if (event.body.state === "suspended" && event.body.source) {
          revealStoppedSource(event.session, event.body);
        }
        return;
      }
      let shouldRevealResults = false;
      if (event.event === DEBUG_RESULT_EVENT && isDebugResult(event.body)) {
        resultStore.add(event.body);
        shouldRevealResults = true;
      } else if (event.event === DEBUG_RESULT_STATUS_EVENT && isDebugResultStatus(event.body)) {
        resultStore.addStatus(event.body);
        shouldRevealResults = event.body.status === "error";
      } else {
        return;
      }
      if (
        shouldRevealResults &&
        vscode.workspace
          .getConfiguration("postgresql-workbench.results")
          .get<boolean>("autoReveal", true)
      ) {
        resultsView.reveal(true);
      }
    }),
  );

  const contentProvider = new CodeMonikerContentProvider(
    connections,
    index,
    output,
    context.workspaceState,
  );
  context.subscriptions.push(
    contentProvider,
    vscode.workspace.registerFileSystemProvider(CodeMonikerContentProvider.SCHEME, contentProvider),
    vscode.commands.registerCommand(
      "postgresql-workbench.deployManagedRoutine",
      async (uri?: vscode.Uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target || target.scheme !== CodeMonikerContentProvider.SCHEME) return false;
        try {
          const document =
            vscode.workspace.textDocuments.find(
              (candidate) => candidate.uri.toString(true) === target.toString(true),
            ) ?? (await vscode.workspace.openTextDocument(target));
          if (!document.isDirty && !contentProvider.hasWorkingCopy(target)) {
            void vscode.window.showInformationMessage(
              "Nothing to deploy: this source matches the deployed routine.",
            );
            return false;
          }
          if (document.isDirty && !(await document.save())) {
            void vscode.window.showWarningMessage(
              "Deploy cancelled because the managed routine working copy could not be saved.",
            );
            return false;
          }
          const result = await contentProvider.deploy(target);
          if (result.status === "deployed-with-warning") {
            void vscode.window.showWarningMessage(
              `Routine deployed, but ${result.message}. Reindex before continuing.`,
            );
          } else {
            void vscode.window.showInformationMessage("Managed PL/pgSQL routine deployed.");
          }
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          output.appendLine(`Managed deploy rejected: ${message}`);
          const bindingServerId = /^Index (?:missing|stale)/u.test(message)
            ? index.sourceDescriptorForDocumentUri(target)?.serverId
            : undefined;
          void vscode.window
            .showWarningMessage(
              `Deploy rejected: ${message.slice(0, 240)}`,
              ...(bindingServerId ? ["Index Association"] : []),
              "Show Output",
            )
            .then((choice) => {
              if (choice === "Show Output") output.show(true);
              if (choice === "Index Association") {
                void vscode.commands.executeCommand("postgresql-workbench.indexAssociation", {
                  serverId: bindingServerId,
                });
              }
            });
          return false;
        }
      },
    ),
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (document.uri.scheme !== CodeMonikerContentProvider.SCHEME) return;
      const descriptor = index.sourceDescriptorForDocumentUri(document.uri);
      const kind =
        descriptor?.symbolKind === "function" || descriptor?.symbolKind === "procedure"
          ? descriptor.symbolKind
          : descriptor?.documentKind;
      const language = postgresSourceLanguageId(kind ?? "source");
      if (document.languageId !== language) {
        void vscode.languages.setTextDocumentLanguage(document, language);
      }
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (session.type === "postgresql-workbench") {
        contentProvider.invalidateAll();
        sessions.observeTermination(session.id);
        void closePostgresqlDapTabs();
      }
    }),
    vscode.debug.registerDebugAdapterDescriptorFactory("postgresql-workbench", {
      async createDebugAdapterDescriptor(): Promise<vscode.DebugAdapterDescriptor> {
        const dapPath = context.asAbsolutePath("dist/dap-server.js");
        const syntaxRuntime = index.syntaxRuntimeConfiguration();
        output.appendLine(`createDebugAdapterDescriptor: ${dapPath}`);
        return new vscode.DebugAdapterExecutable("node", [dapPath], {
          env: {
            PLPGSQL_CODE_MONIKER_RUNTIME: syntaxRuntime.runtimePath,
            PLPGSQL_CODE_MONIKER_TIMEOUT_MS: String(syntaxRuntime.timeoutMs),
          },
        });
      },
    }),
    vscode.debug.registerDebugConfigurationProvider("postgresql-workbench", {
      async resolveDebugConfiguration(
        _folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
      ): Promise<vscode.DebugConfiguration | undefined> {
        const resolved = (await resolveDebugConfiguration(
          config,
          connections,
          vscode.window,
          undefined,
          output,
        )) as vscode.DebugConfiguration | undefined;
        if (resolved && resolved.resultMaxRows === undefined) {
          resolved.resultMaxRows = vscode.workspace
            .getConfiguration("postgresql-workbench.results")
            .get<number>("maxRows", DEBUG_RESULT_LIMITS.DEFAULT_ROWS);
        }
        if (!resolved) return undefined;
        let serverId = String(resolved.server ?? "");
        const configuredServer = serverId ? connections.store.get(serverId) : undefined;
        const database = configuredServer?.database ?? String(resolved.database ?? "");
        if (!configuredServer) {
          const host = String(resolved.host ?? "");
          const port = Number(resolved.port ?? 5432);
          const user = String(resolved.user ?? "");
          if (host && database && user) {
            const inlineServerId = ServerStore.makeId(host, port, database, user);
            if (!serverId || serverId === inlineServerId) {
              serverId = inlineServerId;
              resolved.server = serverId;
            }
          }
        }
        const indexed = index.sqlAuthoringSnapshot({ serverId, database });
        if (indexed?.status !== "available") {
          vscode.window.showInformationMessage(
            "Index the PostgreSQL context selected for this Debug action before starting the session.",
          );
          output.appendLine(
            `resolveDebugConfiguration: rejected launch because ${serverId || "<unknown>"}/${database || "<unknown>"} has no available indexed snapshot`,
          );
          return undefined;
        }
        const sourceUris = index.routineSourceUris(serverId);
        if (Object.keys(sourceUris).length === 0) {
          vscode.window.showInformationMessage(
            "The active PostgreSQL index contains no debuggable routines.",
          );
          return undefined;
        }
        resolved.sourceUris = sourceUris;
        if (resolved.routine) {
          const oid = Number(resolved.routine.oid ?? 0);
          const symbol = oid > 0 ? index.routineSymbol(serverId, oid) : undefined;
          if (symbol) resolved.routine = { ...resolved.routine, symbolUri: symbol.uri };
        }
        if (resolved.entryRoutine) {
          const oid = Number(resolved.entryRoutine.oid ?? 0);
          const symbol = oid > 0 ? index.routineSymbol(serverId, oid) : undefined;
          if (symbol) {
            resolved.entryRoutine = { ...resolved.entryRoutine, symbolUri: symbol.uri };
          }
        }
        const launchToken = sessions.admit(
          debugDescriptor(resolved, vscode.window.activeTextEditor?.viewColumn),
          debugLaunchToken(resolved),
        );
        if (!launchToken) {
          const active = sessions.active;
          vscode.window.showWarningMessage(
            `A PL/pgSQL debug session is already ${active?.state ?? "running"}${active?.status?.routine ? ` for ${routineName(active.status.routine)}` : ""}.`,
          );
          output.appendLine(
            `resolveDebugConfiguration: rejected concurrent launch ${resolved.name ?? "<unnamed>"}`,
          );
          return undefined;
        }
        try {
          await vscode.commands.executeCommand("testing.coverage.close");
        } catch (error) {
          output.appendLine(
            `resolveDebugConfiguration: failed to close native test coverage: ${error}`,
          );
        }
        resolved[DEBUG_LAUNCH_TOKEN_PROPERTY] = launchToken;
        return resolved;
      },
    }),
    vscode.debug.registerDebugConfigurationProvider(
      "plpgsql",
      {
        provideDebugConfigurations(): vscode.ProviderResult<vscode.DebugConfiguration[]> {
          return connections.servers.map((server) => ({
            type: "postgresql-workbench",
            request: "launch",
            name: `PL/pgSQL on ${server.name}`,
            server: server.id,
          }));
        },
      },
      vscode.DebugConfigurationProviderTriggerKind.Dynamic,
    ),
    vscode.languages.registerInlineValuesProvider(
      [
        { scheme: CodeMonikerContentProvider.SCHEME },
        { scheme: "debug", language: "plpgsql" },
        { language: "sql" },
        { language: "plpgsql" },
      ],
      new PlpgsqlInlineValuesProvider(() => index.syntaxParser()),
    ),
    vscode.languages.registerDocumentSemanticTokensProvider(
      [
        ...POSTGRES_SOURCE_LANGUAGE_IDS.map((language) => ({
          scheme: CodeMonikerContentProvider.SCHEME,
          language,
        })),
        { scheme: "debug", language: "plpgsql" },
      ],
      new PlpgsqlSemanticTokensProvider(() => index.syntaxParser()),
      LEGEND,
    ),
  );
  return { resultStore, resultsView, contentProvider };
}

function registerDiagnosticsAndReconnect(
  context: vscode.ExtensionContext,
  connections: ConnectionManager,
  index: WorkbenchIndexController,
  output: vscode.OutputChannel,
  divergence: CodeMonikerContentProvider,
): void {
  context.subscriptions.push(
    new PlpgsqlDiagnosticsProvider(connections, () => index.syntaxParser(), index, divergence),
  );
  connections
    .tryReconnectSaved()
    .catch((error) => output.appendLine(`Auto-reconnect failed: ${error}`));
}

let shutdownScratchpads: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<PlpgsqlExtensionApi> {
  out.appendLine("activate() called");

  let resetAcceptanceWorkbench = () => {};
  let inspectAcceptanceDebugState = (): unknown => ({
    extensionSession: undefined,
    vscodeSessionId: vscode.debug.activeDebugSession?.id,
  });
  let inspectAcceptanceTestingState = (): unknown => ({});
  let inspectAcceptanceWorkbenchState = (): unknown => ({});
  let armAcceptanceIndexPhaseGate = (_phases: readonly WorkbenchIndexPhase[]): void => {};
  let releaseAcceptanceIndexPhaseGate = (_runId: number, _phase: WorkbenchIndexPhase): void => {};
  let removeAcceptanceServer = (_id: string): Promise<void> | void => {};
  const acceptanceControl = registerAcceptanceControl(context, {
    armIndexPhaseGate: (phases) => armAcceptanceIndexPhaseGate(phases),
    inspectDebugState: () => inspectAcceptanceDebugState(),
    inspectTestingState: () => inspectAcceptanceTestingState(),
    inspectWorkbenchState: () => inspectAcceptanceWorkbenchState(),
    releaseIndexPhaseGate: (runId, phase) => releaseAcceptanceIndexPhaseGate(runId, phase),
    removeServer: (id) => removeAcceptanceServer(id),
    resetWorkbench: () => resetAcceptanceWorkbench(),
  });
  if (acceptanceControl) context.subscriptions.push(acceptanceControl);

  const cm = new ConnectionManager(context, out);
  removeAcceptanceServer = async (id) => {
    await cm.removeDatabaseContextConfiguration(id);
  };
  context.subscriptions.push(cm);
  const workbenchIndex = new WorkbenchIndexController(context, cm, out);
  context.subscriptions.push(workbenchIndex);
  const workbenchDdlSync = new WorkbenchDdlSyncController(cm, workbenchIndex, out);
  context.subscriptions.push(workbenchDdlSync);
  armAcceptanceIndexPhaseGate = (phases) => workbenchIndex.armAcceptancePhaseGate(phases);
  releaseAcceptanceIndexPhaseGate = (runId, phase) =>
    workbenchIndex.releaseAcceptancePhaseGate(runId, phase);
  inspectAcceptanceWorkbenchState = () => ({
    connection: {
      activeServerId: cm.activeServer?.id,
      connected: cm.isConnected,
    },
    schemaSync: workbenchDdlSync.diagnosticStates(),
    index: workbenchIndex.acceptanceSnapshot(),
  });
  let debugScratchpadSql: ScratchpadDebugger = async () => ({
    started: false,
    message: "The PL/pgSQL debugger is still starting.",
  });
  const scratchpads = registerSqlNotebook(
    context,
    cm,
    async (sql) =>
      planSqlResultExecution(sql, await workbenchIndex.syntaxParser(), sqlSyntaxAnalysisBudget()),
    (request) => debugScratchpadSql(request),
  );
  const sqlNotebooks = scratchpads.workspace;
  shutdownScratchpads = scratchpads.shutdown;
  let treeProvider: WorkbenchTreeProvider;
  let connectionTreeProvider: WorkbenchTreeProvider;
  let graphTreeSync: WorkbenchGraphTreeSync;
  const workbenchTreeDragAndDrop = new WorkbenchTreeDragAndDropController((payload) =>
    workbenchGraph.previewTreeDrop(payload),
  );
  const workbenchGraph = new WorkbenchGraphView({
    extensionUri: context.extensionUri,
    index: workbenchIndex,
    openDefinition: (object, snapshot) =>
      Promise.resolve(
        vscode.commands.executeCommand("postgresql-workbench.openDatabaseObject", object, snapshot),
      ),
    showActions: showCockpitObjectActions,
    selectInTree: (object) => graphTreeSync.revealObject(object),
    workspaceState: context.workspaceState,
    collectRenderEvidence: context.extensionMode === vscode.ExtensionMode.Test,
    treeDragPayload: (consume) => workbenchTreeDragAndDrop.activePayload(consume),
  });
  context.subscriptions.push(workbenchTreeDragAndDrop, workbenchGraph);
  registerWorkbenchGraphDropBridge(context, workbenchGraph);
  const coverageTests = new PgTapTestController({
    connections: cm,
    output: out,
    syntaxParser: () => workbenchIndex.syntaxParser(),
    indexedDependencies: (routine) => workbenchIndex.routineDependencies(routine.oid),
    indexDatabase: async (serverId, client) => {
      const server = cm.store.get(serverId);
      if (!server) throw new Error(`Unknown PostgreSQL connection: ${serverId}`);
      const indexed = workbenchIndex.state.result;
      if (
        workbenchIndex.state.status !== "indexing" &&
        indexed?.serverId === serverId &&
        indexed.database === server.database
      ) {
        return;
      }
      await workbenchIndex.indexPostgresDatabase(client, {
        serverId,
        database: server.database,
      });
    },
    resolveRoutineSymbolUri: (serverId, oid) => workbenchIndex.routineSymbol(serverId, oid)?.uri,
    resolveDocumentUri: (symbolUri) => workbenchIndex.documentUri(symbolUri),
    resolveSource: (uri) => {
      const source = workbenchIndex.sourceDescriptorForDocumentUri(uri);
      return source ? { serverId: source.serverId, oid: source.oid } : undefined;
    },
  });
  let acceptanceTestRunSequence = 0;
  let acceptanceCoverageSequence = 0;
  let acceptanceTestRun: unknown;
  let acceptanceCoverage: unknown;
  context.subscriptions.push(
    coverageTests.onDidCompleteRun((outcomes) => {
      acceptanceTestRunSequence += 1;
      acceptanceTestRun = {
        outcomes: Object.fromEntries(outcomes),
        sequence: acceptanceTestRunSequence,
      };
    }),
    coverageTests.coverageProfile.onDidComplete((snapshot) => {
      acceptanceCoverageSequence += 1;
      acceptanceCoverage = {
        files: snapshot.files.map((file) => ({
          branch: file.branchCoverage
            ? {
                covered: file.branchCoverage.covered,
                total: file.branchCoverage.total,
              }
            : undefined,
          statement: {
            covered: file.statementCoverage.covered,
            total: file.statementCoverage.total,
          },
          uri: file.uri.toString(),
        })),
        outcomes: Object.fromEntries(snapshot.outcomes),
        sequence: acceptanceCoverageSequence,
      };
    }),
  );
  inspectAcceptanceTestingState = () => ({
    coverage: acceptanceCoverage,
    index: {
      database: workbenchIndex.state.result?.database,
      generation: workbenchIndex.state.result?.generation,
      revision: workbenchIndex.state.result?.revision,
      serverId: workbenchIndex.state.result?.serverId,
      status: workbenchIndex.state.status,
    },
    run: acceptanceTestRun,
  });
  context.subscriptions.push(coverageTests);
  const workbenchObjectActions = async (
    object: WorkbenchObjectModel,
  ): Promise<WorkbenchObjectAction[]> => {
    const isPlpgsqlRoutine =
      object.plpgsql && (object.kind === "function" || object.kind === "procedure");
    const hasMappedTests =
      isPlpgsqlRoutine && (await coverageTests.hasMappedTests(object.serverId, object.oid));
    return buildWorkbenchObjectActions(object, { hasMappedTests });
  };
  const runWorkbenchObjectAction = async (
    action: WorkbenchObjectActionId,
    object: WorkbenchObjectModel,
    snapshot: { revision: string; generation: number | null },
  ): Promise<unknown> => {
    const result = workbenchIndex.state.result;
    if (
      (workbenchIndex.state.status === "indexing" &&
        action !== "open-definition" &&
        action !== "open-deployed-source") ||
      !result ||
      result.serverId !== object.serverId ||
      result.database !== object.database ||
      result.revision !== snapshot.revision ||
      result.generation !== snapshot.generation
    ) {
      void vscode.window.showWarningMessage(
        "This PostgreSQL object belongs to an outdated Workbench snapshot. Refresh the index and try again.",
      );
      return false;
    }
    const available = await workbenchObjectActions(object);
    if (!available.some((candidate) => candidate.id === action)) {
      return false;
    }
    switch (action) {
      case "open-definition":
        return vscode.commands.executeCommand(
          "postgresql-workbench.openDatabaseObject",
          object,
          snapshot,
        );
      case "open-deployed-source":
        return vscode.commands.executeCommand(
          "postgresql-workbench.openFunction",
          new FunctionItem(object, snapshot),
        );
      case "open-graph":
        return vscode.commands.executeCommand(
          "postgresql-workbench.openObjectGraph",
          object,
          snapshot,
        );
      case "debug":
        return vscode.commands.executeCommand(
          "postgresql-workbench.debugFromTree",
          new FunctionItem(object, snapshot),
        );
      case "show-tests":
        return coverageTests.revealRoutine(object.serverId, object.oid);
      case "run-tests":
        return coverageTests.runRoutineTests(object.serverId, object.oid, false);
      case "run-with-coverage":
        return coverageTests.runRoutineTests(object.serverId, object.oid, true);
    }
  };
  const callSiteConnections = new CallSiteConnectionStore(context.workspaceState);
  const workbenchSearch = { query: "" };
  const debugSessions = new DebugSessionController(() => connectionTreeProvider?.refresh());
  /** Resolves with the SQL result of the next PL/pgSQL debug session, or undefined when it ends without one. */
  const awaitDebugResult = (): {
    completion: Promise<DebugResultEntry | undefined>;
    stop: () => Promise<void>;
    abandon: () => void;
  } => {
    let settle: (entry: DebugResultEntry | undefined) => void = () => {};
    const completion = new Promise<DebugResultEntry | undefined>((resolve) => {
      settle = resolve;
    });
    const subscriptions: vscode.Disposable[] = [];
    const finish = (entry: DebugResultEntry | undefined) => {
      for (const subscription of subscriptions) subscription.dispose();
      settle(entry);
    };
    subscriptions.push(
      vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
        if (event.session.type !== "postgresql-workbench") return;
        if (event.event === DEBUG_RESULT_EVENT && isDebugResult(event.body)) finish(event.body);
        else if (
          event.event === DEBUG_RESULT_STATUS_EVENT &&
          isDebugResultStatus(event.body) &&
          event.body.status === "error"
        ) {
          finish(event.body);
        }
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        if (session.type !== "postgresql-workbench") return;
        setTimeout(() => finish(undefined), 500);
      }),
    );
    return {
      completion,
      stop: async () => {
        const session = vscode.debug.activeDebugSession;
        if (session?.type === "postgresql-workbench") await vscode.debug.stopDebugging(session);
      },
      abandon: () => finish(undefined),
    };
  };
  const startScratchpadDebug = async (
    config: LaunchDebugConfig,
    failure: string,
  ): Promise<ScratchpadDebugOutcome> => {
    const pending = awaitDebugResult();
    const started = await launchDebug(
      cm,
      debugSessions,
      config,
      await workbenchIndex.syntaxParser(),
    );
    if (!started) {
      pending.abandon();
      return { started: false, message: failure };
    }
    return { started: true, completion: pending.completion, stop: pending.stop };
  };
  debugScratchpadSql = async ({ sql, association, source }) => {
    const snapshot = workbenchIndex.sqlAuthoringSnapshot(association);
    if (snapshot?.status !== "available") {
      const server = cm.store.get(association.serverId);
      void vscode.window
        .showWarningMessage(
          `Debug needs a fresh Workbench Index of ${server?.name ?? association.database}.`,
          "Index Association",
        )
        .then((choice) => {
          if (choice === "Index Association") {
            void vscode.commands.executeCommand("postgresql-workbench.indexAssociation", {
              serverId: association.serverId,
            });
          }
        });
      return {
        started: false,
        message:
          "The Scratchpad Association has no fresh Workbench Index. Use Index Association, then run the cell again.",
      };
    }
    const parsed = (await parseSqlCalls(sql, await workbenchIndex.syntaxParser())).filter(
      (call) => call.isLaunchable,
    );
    if (parsed.length === 0) {
      const triggerHarness = /-- Invokes trigger\s+\S+\s+and function\s+([^\s.]+)\.([^\s]+)/u.exec(
        sql,
      );
      const triggerRoutine = triggerHarness
        ? snapshot.objects.find(
            (object) =>
              object.kind === "function" &&
              object.plpgsql === true &&
              object.schema === triggerHarness[1] &&
              object.name === triggerHarness[2] &&
              object.returnType?.toLocaleLowerCase() === "trigger",
          )
        : undefined;
      if (triggerRoutine) {
        return startScratchpadDebug(
          {
            sql,
            entryRoutine: {
              schema: triggerRoutine.schema,
              name: triggerRoutine.name,
              kind: "function",
              oid: triggerRoutine.oid,
              argTypes: [],
            },
            serverId: association.serverId,
            preserveDatabaseContext: true,
            resultLabel: `${triggerRoutine.schema}.${triggerRoutine.name} · ${source.name}`,
            resultSource: source,
          },
          "The PL/pgSQL trigger debug session did not start.",
        );
      }
      return {
        started: false,
        message:
          "Debug requires a direct replayable CALL or SELECT of one indexed PL/pgSQL routine.",
      };
    }
    const picks = parsed.flatMap((call) => {
      const expectedKind = call.kind === "call" ? "procedure" : "function";
      const candidates = snapshot.objects.filter(
        (object) =>
          object.kind === expectedKind &&
          object.plpgsql === true &&
          object.name === call.routine &&
          (call.schema === null || object.schema === call.schema) &&
          object.parameters.length === call.args.length,
      );
      return candidates.length === 1
        ? [
            {
              label: `${call.kind === "call" ? "CALL" : "SELECT"} ${candidates[0].schema}.${candidates[0].name}`,
              description: `Line ${call.line}`,
              call,
            },
          ]
        : [];
    });
    if (picks.length === 0) {
      return {
        started: false,
        message:
          "No unique indexed PL/pgSQL overload matches this call. Qualify the schema and make the argument list unambiguous.",
      };
    }
    const selected =
      picks.length === 1
        ? picks[0]
        : await vscode.window.showQuickPick(
            picks.map((pick) => ({
              ...pick,
              detail:
                "Debug runs only this Statement; the other Statements of the cell are not executed.",
            })),
            {
              title: "Scratchpad Debug target",
              placeHolder: "Choose one PL/pgSQL entry point",
            },
          );
    if (!selected) return { started: false, cancelled: true };
    return startScratchpadDebug(
      {
        sql: selected.call.sql,
        serverId: association.serverId,
        preserveDatabaseContext: true,
        resultLabel: `${selected.label.replace(/^(?:CALL|SELECT)\s+/u, "")} · ${source.name}:${selected.call.line}`,
        resultSource: { ...source, line: selected.call.line },
      },
      "The PL/pgSQL debug session did not start.",
    );
  };
  inspectAcceptanceDebugState = () => ({
    breakpoints: vscode.debug.breakpoints.map((breakpoint) =>
      breakpoint instanceof vscode.SourceBreakpoint
        ? {
            enabled: breakpoint.enabled,
            line: breakpoint.location.range.start.line + 1,
            uri: breakpoint.location.uri.toString(),
          }
        : { enabled: breakpoint.enabled },
    ),
    extensionSession: debugSessions.active,
    vscodeSessionId: vscode.debug.activeDebugSession?.id,
  });
  let sourceNavigationSequence = 0;
  const queueStoppedSource = (session: vscode.DebugSession, status: DebugSessionStatus) => {
    const sequence = ++sourceNavigationSequence;
    void revealStoppedSource(
      session,
      status,
      debugSessions,
      () => sequence === sourceNavigationSequence,
    )
      .then(() =>
        out.appendLine(
          `stoppedSource: ${status.sessionId} active=${vscode.window.activeTextEditor?.document.uri.toString() ?? "<none>"}`,
        ),
      )
      .catch((error) => out.appendLine(`Stopped source navigation failed: ${error}`));
  };

  const { resultStore, resultsView, contentProvider } = registerDebugInfrastructure({
    context,
    connections: cm,
    index: workbenchIndex,
    sessions: debugSessions,
    output: out,
    refreshTree: () => connectionTreeProvider?.refresh(),
    revealStoppedSource: queueStoppedSource,
  });
  treeProvider = new WorkbenchTreeProvider(
    cm,
    workbenchIndex,
    sqlNotebooks,
    scratchpads.transactions,
    workbenchDdlSync,
    () => debugSessions.statuses,
  );
  connectionTreeProvider = treeProvider;
  const workbenchTree = vscode.window.createTreeView("postgresql-workbench-connections", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
    dragAndDropController: workbenchTreeDragAndDrop,
  });
  const scratchpadTreeProvider = new WorkbenchTreeProvider(
    cm,
    workbenchIndex,
    sqlNotebooks,
    scratchpads.transactions,
    workbenchDdlSync,
    () => debugSessions.statuses,
    "scratchpads",
  );
  const scratchpadsTree = vscode.window.createTreeView("postgresql-workbench-scratchpads", {
    treeDataProvider: scratchpadTreeProvider,
    showCollapseAll: true,
  });
  let scratchpadFilter = "";
  const filterScratchpads = vscode.commands.registerCommand(
    "postgresql-workbench.filterSqlNotebooks",
    async () => {
      const requested = await vscode.window.showInputBox({
        title: "Filter SQL Scratchpads",
        prompt: "Filter by name or Association",
        placeHolder: "Scratchpad name or Connexion",
        value: scratchpadFilter,
      });
      if (requested === undefined) return;
      scratchpadFilter = requested.trim();
      scratchpadTreeProvider.setScratchpadFilter(scratchpadFilter);
      scratchpadsTree.message = scratchpadFilter ? `Filtered by “${scratchpadFilter}”` : undefined;
    },
  );
  graphTreeSync = new WorkbenchGraphTreeSync(
    workbenchTree,
    treeProvider,
    workbenchIndex,
    workbenchGraph,
  );
  try {
    context.subscriptions.push(
      await registerSqlAuthoring(
        context,
        cm,
        workbenchIndex,
        (target) =>
          revealSqlAuthoringReference(
            target,
            workbenchIndex,
            treeProvider,
            workbenchTree,
            graphTreeSync,
          ),
        (uri) => callSiteConnections.getDocument(uri),
      ),
    );
  } catch (error) {
    out.appendLine(
      `SQL authoring server failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
    void vscode.window
      .showWarningMessage(
        "SQL authoring (formatting, completion, composition) could not start. Run, Debug, and the Workbench remain available.",
        "Show Output",
      )
      .then((choice) => {
        if (choice === "Show Output") out.show(true);
      });
  }
  resetAcceptanceWorkbench = async () => {
    await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
    await workbenchIndex.settleAcceptanceOperations();
    const debugSession = vscode.debug.activeDebugSession;
    if (debugSession?.type === "postgresql-workbench") {
      const terminated = new Promise<void>((resolve, reject) => {
        const subscription = vscode.debug.onDidTerminateDebugSession((session) => {
          if (session.id !== debugSession.id) return;
          clearTimeout(timeout);
          subscription.dispose();
          resolve();
        });
        const timeout = setTimeout(() => {
          subscription.dispose();
          reject(new Error(`Debug session ${debugSession.id} did not terminate within 5 seconds`));
        }, 5_000);
      });
      await vscode.debug.stopDebugging(debugSession);
      await terminated;
    }
    if (vscode.debug.breakpoints.length > 0) {
      vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
    }
    await callSiteConnections.clearAll();
    await vscode.commands.executeCommand("workbench.action.closePanel");
    await workbenchGraph.close();
    graphTreeSync.invalidateDatabaseContext();
  };
  const syncGraphFromTree = graphTreeSync.bind();
  const scheduleDebugSessionRefresh = () => {
    for (const delay of [100, 500, 2_000, 5_000]) {
      setTimeout(() => connectionTreeProvider.refresh(), delay);
    }
  };
  context.subscriptions.push(
    treeProvider,
    workbenchTree,
    scratchpadTreeProvider,
    scratchpadsTree,
    filterScratchpads,
    syncGraphFromTree,
    workbenchTree.onDidExpandElement(({ element }) => treeProvider.setExpanded(element, true)),
    workbenchTree.onDidCollapseElement(({ element }) => treeProvider.setExpanded(element, false)),
    scratchpadsTree.onDidExpandElement(({ element }) =>
      scratchpadTreeProvider.setExpanded(element, true),
    ),
    scratchpadsTree.onDidCollapseElement(({ element }) =>
      scratchpadTreeProvider.setExpanded(element, false),
    ),
    cm.onServerChanged(() => {
      graphTreeSync.invalidateDatabaseContext();
      workbenchGraph.invalidateDatabaseContext();
    }),
    workbenchIndex.onDidChangeState((state) => {
      if (state.status === "available" && state.result) {
        void workbenchGraph.refreshSnapshot(state.result);
      }
    }),
    vscode.debug.onDidStartDebugSession((session) => {
      if (session.type === "postgresql-workbench") {
        const admitted = debugSessions.observeStart(
          session.id,
          debugLaunchToken(session.configuration),
        );
        if (!admitted) {
          out.appendLine(`debugSession: rejecting unadmitted VS Code session ${session.id}`);
          void vscode.debug.stopDebugging(session);
          return;
        }
        scheduleDebugSessionRefresh();
      }
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (session.type === "postgresql-workbench") scheduleDebugSessionRefresh();
    }),
  );
  void closePostgresqlDapTabs();

  context.subscriptions.push(
    contentProvider.onDidChangeFile((events) => {
      if (events.some((e) => e.uri.scheme === CodeMonikerContentProvider.SCHEME)) {
        treeProvider.refresh();
      }
    }),
  );

  const connectionSnapshot = (serverId: string) => {
    const server = cm.store.get(serverId);
    return server
      ? workbenchIndex.sqlAuthoringSnapshot({ serverId: server.id, database: server.database })
      : undefined;
  };
  const codeLens = new SqlCodeLensProvider(() => workbenchIndex.syntaxParser(), {
    forDocument: (documentUri) => {
      const uri = vscode.Uri.parse(documentUri);
      const binding =
        uri.scheme === CodeMonikerContentProvider.SCHEME
          ? workbenchIndex.sourceDescriptorForDocumentUri(uri)
          : undefined;
      const serverId = binding?.serverId ?? callSiteConnections.getDocument(documentUri);
      const server = serverId ? cm.store.get(serverId) : undefined;
      return server ? { id: server.id, name: server.name } : undefined;
    },
    indexState: (connection) => {
      const snapshot = connectionSnapshot(connection.id);
      return snapshot ? (snapshot.status === "available" ? "available" : "stale") : "missing";
    },
    debugCallAvailability: (connection, call) =>
      debuggableSqlCall(connectionSnapshot(connection.id), call),
    debugDefinitionAvailability: (connection, definition) =>
      debuggableSqlDefinition(connectionSnapshot(connection.id), definition),
    canDeployManagedRoutine: (documentUri) => {
      const uri = vscode.Uri.parse(documentUri);
      const descriptor = workbenchIndex.sourceDescriptorForDocumentUri(uri);
      if (
        descriptor?.documentKind !== "routine" ||
        !descriptor.plpgsql ||
        (descriptor.symbolKind !== "function" && descriptor.symbolKind !== "procedure")
      ) {
        return false;
      }
      const edited = vscode.workspace.textDocuments.some(
        (candidate) => candidate.isDirty && candidate.uri.toString() === documentUri,
      );
      return edited || contentProvider.hasWorkingCopy(uri);
    },
  });
  context.subscriptions.push(contentProvider.onDidChangeFile(() => codeLens.refresh()));
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [
        { language: "sql" },
        { language: "plpgsql" },
        ...POSTGRES_SOURCE_LANGUAGE_IDS.map((language) => ({ language })),
        { pattern: "**/*.sql" },
        { pattern: "**/*.pgsql" },
      ],
      codeLens,
    ),
    cm.onChanged(() => codeLens.refresh()),
    workbenchIndex.onDidChangeState(() => codeLens.refresh()),
    vscode.commands.registerCommand(
      "postgresql-workbench.assignDocumentConnection",
      (target: DocumentConnectionTarget, requestedServerId?: string) =>
        assignDocumentConnection(cm, callSiteConnections, codeLens, target, requestedServerId),
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.assignCallConnection",
      (target: DocumentConnectionTarget, requestedServerId?: string) =>
        assignDocumentConnection(cm, callSiteConnections, codeLens, target, requestedServerId),
    ),
  );

  registerConnectionCommands({
    context,
    connections: cm,
    ddlSync: workbenchDdlSync,
    codeLens,
    output: out,
  });

  registerSqlWorkbenchCommands({
    context,
    connections: cm,
    codeLens,
    documentConnections: callSiteConnections,
    index: workbenchIndex,
    tree: treeProvider,
    graph: workbenchGraph,
    graphSync: graphTreeSync,
    coverage: coverageTests,
    resultStore,
    resultsView,
    objectActions: workbenchObjectActions,
    runObjectAction: runWorkbenchObjectAction,
    search: workbenchSearch,
    revealSources: () => revealActiveSources(workbenchTree, treeProvider),
    selectedTreeItems: () => workbenchTree.selection,
  });
  registerGraphWorkbenchCommands({
    context,
    connections: cm,
    index: workbenchIndex,
    tree: treeProvider,
    graph: workbenchGraph,
    graphSync: graphTreeSync,
    coverage: coverageTests,
    resultStore,
    resultsView,
    objectActions: workbenchObjectActions,
    runObjectAction: runWorkbenchObjectAction,
    search: workbenchSearch,
  });

  registerDebugCommands({
    context,
    connections: cm,
    documentConnections: callSiteConnections,
    tree: connectionTreeProvider,
    sessions: debugSessions,
    index: workbenchIndex,
    output: out,
  });

  registerResultCommands(context, resultStore);

  registerDiagnosticsAndReconnect(context, cm, workbenchIndex, out, contentProvider);

  acceptanceControl?.markReady();

  return {
    connectionManager: cm,
    workbenchTreeProvider: treeProvider,
    connectionTreeProvider,
    treeProvider,
    resultStore,
    callSiteConnections,
    debugSessions,
    coverageTests,
    workbenchIndex,
    workbenchDdlSync,
    workbenchGraph,
    sqlNotebooks,
    workbenchObjectActions,
    runWorkbenchObjectAction,
    workbenchSearchQuery: () => workbenchSearch.query,
    resultsViewVisible: () => resultsView.visible,
  };
}

function sqlSyntaxAnalysisBudget() {
  const settings = resolveSqlAuthoringSettings();
  return { maxDepth: settings.syntaxMaxDepth, maxNodes: settings.syntaxMaxNodes };
}

export async function deactivate(): Promise<void> {
  await shutdownScratchpads?.();
  shutdownScratchpads = undefined;
}

async function revealActiveSources(
  tree: vscode.TreeView<PlpgsqlTreeItem>,
  provider: WorkbenchTreeProvider,
): Promise<void> {
  const sources = provider.activeSourcesItem();
  if (sources) await tree.reveal(sources, { expand: true, focus: false });
}

async function revealSqlAuthoringReference(
  target: SqlAuthoringNavigationTarget,
  index: WorkbenchIndexController,
  provider: WorkbenchTreeProvider,
  tree: vscode.TreeView<PlpgsqlTreeItem>,
  graphSync: WorkbenchGraphTreeSync,
): Promise<boolean> {
  const result = index.state.result;
  if (
    index.state.status !== "available" ||
    !result ||
    result.serverId !== target.serverId ||
    result.database !== target.database
  ) {
    return false;
  }
  const object = buildWorkbenchObjects(index.indexedSymbols, target).find(
    (candidate) => candidate.oid === target.oid,
  );
  if (!object) return false;
  if (!target.column) return graphSync.navigateToObject(object);

  const parent = provider.itemForObject(object);
  if (!parent) return false;
  await tree.reveal(parent, { select: false, focus: false, expand: true });
  const members = buildWorkbenchTableMembers(index.indexedSymbols, object);
  const member = members.find(
    (candidate) => candidate.kind === "column" && candidate.name === target.column,
  );
  if (!member) return false;
  const child = (await provider.getChildren(parent)).find(
    (candidate) =>
      candidate.kind === "tableMember" &&
      candidate.member.kind === "column" &&
      candidate.member.name === member.name,
  );
  if (!child) return false;
  await tree.reveal(child, { select: true, focus: true, expand: false });
  return true;
}

function isDebugResult(value: unknown): value is DebugResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DebugResult>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.command === "string" &&
    typeof candidate.rowCount === "number" &&
    typeof candidate.capturedRowCount === "number" &&
    Array.isArray(candidate.columns) &&
    Array.isArray(candidate.rows)
  );
}

function isDebugResultStatus(value: unknown): value is DebugResultStatus {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DebugResultStatus>;
  return (
    typeof candidate.id === "string" &&
    (candidate.status === "pending" || candidate.status === "error") &&
    typeof candidate.label === "string" &&
    typeof candidate.query === "string" &&
    typeof candidate.timestamp === "string" &&
    (candidate.status !== "error" ||
      (typeof candidate.message === "string" && typeof candidate.durationMs === "number"))
  );
}

function isDebugSessionStatus(value: unknown): value is DebugSessionStatus {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DebugSessionStatus>;
  return (
    typeof candidate.sessionId === "string" &&
    typeof candidate.state === "string" &&
    typeof candidate.timestamp === "string"
  );
}

function debugDescriptor(
  config: vscode.DebugConfiguration,
  viewColumn?: vscode.ViewColumn,
): DebugLaunchDescriptor {
  return {
    name: String(config.name ?? "Debug PL/pgSQL"),
    ...(typeof config.sql === "string" ? { sql: config.sql } : {}),
    ...(config.routine || config.entryRoutine
      ? { routine: (config.routine ?? config.entryRoutine) as DebugLaunchRoutineTarget }
      : {}),
    ...(viewColumn !== undefined ? { viewColumn } : {}),
  };
}

function debugLaunchToken(config: vscode.DebugConfiguration): string | undefined {
  const value = config[DEBUG_LAUNCH_TOKEN_PROPERTY];
  return typeof value === "string" ? value : undefined;
}

function routineName(routine: { schema: string | null; name: string }): string {
  return routine.schema ? `${routine.schema}.${routine.name}` : routine.name;
}

async function revealStoppedSource(
  session: vscode.DebugSession,
  status: DebugSessionStatus,
  debugSessions: DebugSessionController,
  isLatest: () => boolean,
): Promise<void> {
  if (!status.source?.path || !isLatest() || !debugSessions.matches(session.id, status.sessionId)) {
    return;
  }
  const viewColumn = debugSessions.active?.viewColumn as vscode.ViewColumn | undefined;
  const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(status.source.path));
  if (!isLatest() || !debugSessions.matches(session.id, status.sessionId)) return;
  const line = Math.max(0, status.source.line - 1);
  // Reuse an editor group already showing this source instead of opening a second copy.
  const visible = vscode.window.visibleTextEditors.filter(
    (editor) => editor.document.uri.toString() === document.uri.toString(),
  );
  const target = visible.find((editor) => editor.viewColumn === viewColumn) ?? visible[0];
  await vscode.window.showTextDocument(document, {
    viewColumn: target?.viewColumn ?? viewColumn ?? vscode.ViewColumn.Active,
    preview: false,
    preserveFocus: false,
    selection: new vscode.Range(line, 0, line, 0),
  });
}

function debugResultSource(statement: {
  documentUri?: string;
  line?: number;
}): DebugResultSource | undefined {
  if (!statement.documentUri) return undefined;
  const uri = vscode.Uri.parse(statement.documentUri);
  const relative = vscode.workspace.asRelativePath(uri, false);
  return {
    name: relative || uri.path.split("/").at(-1) || uri.toString(),
    uri: statement.documentUri,
    ...(statement.line ? { line: statement.line } : {}),
  };
}

async function confirmIncompleteResult(result: DebugResult, action: string): Promise<boolean> {
  const reasons = result.truncationReasons
    .map((reason) => {
      if (reason === "rows") return "row limit";
      if (reason === "cell") return "truncated cell values";
      return "payload limit";
    })
    .join(", ");
  const choice = await vscode.window.showWarningMessage(
    `${action} the captured preview? The SQL result is incomplete (${reasons}).`,
    { modal: true, detail: "NULL values are exported as \\N; empty strings remain empty." },
    `${action} captured preview`,
  );
  return choice === `${action} captured preview`;
}
