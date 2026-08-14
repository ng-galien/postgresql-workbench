import * as vscode from "vscode";
import {
  classifySqlStatementCount,
  planSqlResultExecution,
} from "../../src/analysis/sqlStatements.js";
import type { SyntaxParser } from "../../src/analysis/syntaxTree.js";
import { parseCall } from "../../src/callParser.js";
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
  type DebugResultStatus,
  type DebugSessionStatus,
} from "../../src/debugger/launch/index.js";
import { registerAcceptanceControl } from "./acceptanceControl.js";
import { CallSiteConnectionStore } from "./callSiteConnectionStore.js";
import { CodeMonikerContentProvider } from "./codeMonikerContentProvider.js";
import { ConnectionManager } from "./connectionManager.js";
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
import { closePostgresqlDapTabs } from "./postgresqlDapSource.js";
import { showRequirementsGuide } from "./requirementsGuide.js";
import { createRoutineComparisonHandler } from "./routineComparisonCommand.js";
import { type ServerConfig, ServerStore } from "./serverStore.js";
import {
  type CommandCallSite,
  type CommandFunctionDefinition,
  type FunctionDefinition,
  SqlCodeLensProvider,
} from "./sqlCodeLensProvider.js";
import { registerSqlNotebook } from "./sqlNotebook.js";
import type { SqlNotebookWorkspace } from "./sqlNotebookWorkspace.js";
import { executeSqlSelection, prepareSqlSelection } from "./sqlSelectionExecution.js";
import { WorkbenchDdlSyncController } from "./workbenchDdlSync.js";
import { WorkbenchGraphTreeSync } from "./workbenchGraph/treeSync.js";
import { registerWorkbenchGraphDropBridge } from "./workbenchGraphDropBridge.js";
import { WorkbenchGraphView } from "./workbenchGraphView.js";
import { WorkbenchIndexController } from "./workbenchIndexController.js";
import {
  actionsForWorkbenchSurface,
  buildWorkbenchObjectActions,
  type WorkbenchObjectAction,
  type WorkbenchObjectActionId,
  type WorkbenchObjectActionSurface,
} from "./workbenchObjectActions.js";
import { WorkbenchTreeDragAndDropController } from "./workbenchTreeDragAndDrop.js";
import type { WorkbenchObjectModel } from "./workbenchTreeModel.js";
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
  routine?: DebugLaunchRoutineTarget;
  routineArgs?: DebugLaunchRoutineArgument[];
  resultLabel?: string;
  resultSource?: DebugResultSource;
  serverId?: string;
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
): Promise<void> {
  if (vscode.debug.activeDebugSession?.type === "postgresql-workbench") {
    vscode.window.showWarningMessage("A PL/pgSQL debug session is already running.");
    return;
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  const serverId = config.serverId ?? cm.activeServer?.id;
  const name =
    config.name ??
    (config.routine
      ? configNameFromRoutine(config.routine)
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
    return;
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
    return;
  }

  await persistLaunchConfig(folder, debugConfig).catch((err) =>
    out.appendLine(`persistLaunchConfig failed: ${err}`),
  );
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
  if (debugConfig.routine) persisted.routine = debugConfig.routine;
  if (debugConfig.routineArgs) persisted.routineArgs = debugConfig.routineArgs;
  persisted.stopOnEntry = debugConfig.stopOnEntry ?? true;

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

async function assignCallSiteConnection(
  cm: ConnectionManager,
  assignments: CallSiteConnectionStore,
  codeLens: SqlCodeLensProvider,
  call: CommandCallSite,
  requestedServerId?: string,
): Promise<boolean> {
  let server: ServerConfig | undefined;
  if (requestedServerId) {
    server = cm.store.get(requestedServerId);
  } else if (cm.servers.length === 0) {
    const action = await vscode.window.showInformationMessage(
      "No PostgreSQL connection is configured.",
      "Add connection",
    );
    if (action !== "Add connection") return false;
    server = await cm.commands.addServer();
  } else {
    const picked = await vscode.window.showQuickPick(
      cm.servers.map((candidate) => ({
        label: candidate.name,
        description: cm.isActiveServer(candidate.id) ? "Connected" : undefined,
        server: candidate,
      })),
      {
        placeHolder: `PostgreSQL connection for ${call.schema ? `${call.schema}.` : ""}${call.routine}`,
        ignoreFocusOut: true,
      },
    );
    server = picked?.server;
  }
  if (!server) return false;

  await assignments.assign(
    {
      documentUri: call.documentUri ?? "",
      line: call.line,
      kind: call.kind,
      schema: call.schema,
      routine: call.routine,
    },
    server.id,
  );
  codeLens.refresh();
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
  revealSources(): Thenable<void>;
  selectedTreeItems(): readonly PlpgsqlTreeItem[];
}

function registerSqlWorkbenchCommands(options: SqlWorkbenchCommandOptions): void {
  const { context, connections, index, tree, coverage, resultStore, resultsView } = options;
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
      const client = connections.getClient();
      if (!client || !connections.isConnected) {
        void vscode.window.showInformationMessage(
          "Connect to a PostgreSQL database before executing SQL.",
        );
        return false;
      }
      const result = await executeSqlSelection(client, selected, resultStore, {
        maxRows: clampDebugResultRows(
          vscode.workspace
            .getConfiguration("postgresql-workbench.results")
            .get<number>("maxRows", DEBUG_RESULT_LIMITS.DEFAULT_ROWS),
        ),
        classifyStatementCount: async (sql) =>
          classifySqlStatementCount(sql, await index.syntaxParser()),
        onStarted: () => resultsView.reveal(true),
      });
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
          object.plpgsql ? "plpgsql" : "sql",
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
  const { context, connections, tree, sessions, index, output } = options;
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
        await vscode.languages.setTextDocumentLanguage(document, "plpgsql");
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
            serverId: definition.serverId,
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
            serverId: call.serverId,
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

  const contentProvider = new CodeMonikerContentProvider(connections, index);
  context.subscriptions.push(
    contentProvider,
    vscode.workspace.registerFileSystemProvider(CodeMonikerContentProvider.SCHEME, contentProvider),
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (document.uri.scheme !== CodeMonikerContentProvider.SCHEME) return;
      const descriptor = index.sourceDescriptorForDocumentUri(document.uri);
      const language = descriptor?.plpgsql === false ? "sql" : "plpgsql";
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
        const indexed = index.state.result;
        if (
          index.state.status === "indexing" ||
          indexed?.serverId !== serverId ||
          indexed.database !== database
        ) {
          vscode.window.showInformationMessage(
            "Index the active PostgreSQL DatabaseContext before starting a debug session.",
          );
          output.appendLine(
            `resolveDebugConfiguration: rejected launch because ${serverId || "<unknown>"}/${database || "<unknown>"} is not the available active index`,
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
        { language: "sql" },
        { language: "plpgsql" },
        { pattern: "**/*.sql" },
        { pattern: "**/*.pgsql" },
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
): void {
  context.subscriptions.push(
    new PlpgsqlDiagnosticsProvider(connections, () => index.syntaxParser(), index),
  );
  connections
    .tryReconnectSaved()
    .catch((error) => output.appendLine(`Auto-reconnect failed: ${error}`));
}

let shutdownScratchpads: (() => Promise<void>) | undefined;

export function activate(context: vscode.ExtensionContext): PlpgsqlExtensionApi {
  out.appendLine("activate() called");

  let resetAcceptanceWorkbench = () => {};
  let inspectAcceptanceDebugState = (): unknown => ({
    extensionSession: undefined,
    vscodeSessionId: vscode.debug.activeDebugSession?.id,
  });
  let inspectAcceptanceTestingState = (): unknown => ({});
  const acceptanceControl = registerAcceptanceControl(context, {
    inspectDebugState: () => inspectAcceptanceDebugState(),
    inspectTestingState: () => inspectAcceptanceTestingState(),
    resetWorkbench: () => resetAcceptanceWorkbench(),
  });
  if (acceptanceControl) context.subscriptions.push(acceptanceControl);

  const cm = new ConnectionManager(context, out);
  context.subscriptions.push(cm);
  const workbenchIndex = new WorkbenchIndexController(context, cm, out);
  context.subscriptions.push(workbenchIndex);
  const workbenchDdlSync = new WorkbenchDdlSyncController(cm, workbenchIndex, out);
  context.subscriptions.push(workbenchDdlSync);
  const scratchpads = registerSqlNotebook(context, cm, async (sql) =>
    planSqlResultExecution(sql, await workbenchIndex.syntaxParser()),
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
  graphTreeSync = new WorkbenchGraphTreeSync(
    workbenchTree,
    treeProvider,
    workbenchIndex,
    workbenchGraph,
  );
  resetAcceptanceWorkbench = async () => {
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
    syncGraphFromTree,
    workbenchTree.onDidExpandElement(({ element }) => treeProvider.setExpanded(element, true)),
    workbenchTree.onDidCollapseElement(({ element }) => treeProvider.setExpanded(element, false)),
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

  const codeLens = new SqlCodeLensProvider(() => workbenchIndex.syntaxParser(), {
    active: () => {
      const server = cm.activeServer;
      return server ? { id: server.id, name: server.name } : undefined;
    },
    forCall: (call) => {
      if (!call.documentUri) return undefined;
      const serverId = callSiteConnections.get({
        documentUri: call.documentUri,
        line: call.line,
        kind: call.kind,
        schema: call.schema,
        routine: call.routine,
      });
      const server = serverId ? cm.store.get(serverId) : undefined;
      return server ? { id: server.id, name: server.name } : undefined;
    },
    canDebug: (connection) => {
      const indexed = workbenchIndex.state.result;
      return (
        workbenchIndex.state.status !== "indexing" &&
        indexed?.serverId === connection.id &&
        indexed.database === cm.store.get(connection.id)?.database
      );
    },
  });
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [
        { language: "sql" },
        { language: "plpgsql" },
        { pattern: "**/*.sql" },
        { pattern: "**/*.pgsql" },
      ],
      codeLens,
    ),
    cm.onChanged(() => codeLens.refresh()),
    workbenchIndex.onDidChangeState(() => codeLens.refresh()),
    vscode.commands.registerCommand(
      "postgresql-workbench.assignCallConnection",
      (call: CommandCallSite, requestedServerId?: string) =>
        assignCallSiteConnection(cm, callSiteConnections, codeLens, call, requestedServerId),
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
    tree: connectionTreeProvider,
    sessions: debugSessions,
    index: workbenchIndex,
    output: out,
  });

  registerResultCommands(context, resultStore);

  registerDiagnosticsAndReconnect(context, cm, workbenchIndex, out);

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
    ...(config.routine ? { routine: config.routine as DebugLaunchRoutineTarget } : {}),
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
  await vscode.window.showTextDocument(document, {
    viewColumn: viewColumn ?? vscode.ViewColumn.Active,
    preview: false,
    preserveFocus: false,
    selection: new vscode.Range(line, 0, line, 0),
  });
}

function debugResultSource(call: CommandCallSite): DebugResultSource | undefined {
  if (!call.documentUri) return undefined;
  const uri = vscode.Uri.parse(call.documentUri);
  const relative = vscode.workspace.asRelativePath(uri, false);
  return {
    name: relative || uri.path.split("/").at(-1) || uri.toString(),
    uri: call.documentUri,
    ...(call.line ? { line: call.line } : {}),
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
