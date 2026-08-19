import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import type {
  DebugLaunchRoutineArgument,
  DebugLaunchRoutineTarget,
  DebugResultSource,
} from "../../packages/dap/src/debugger/launch/index.js";
import {
  DEBUG_RESULT_EVENT,
  DEBUG_RESULT_LIMITS,
  DEBUG_RESULT_STATUS_EVENT,
  DEBUG_SESSION_STATUS_EVENT,
  type DebugResult,
  type DebugResultEntry,
  type DebugResultStatus,
  type DebugSessionStatus,
} from "../../packages/dap/src/debugger/launch/index.js";
import { planSqlResultExecution } from "../../packages/sql/src/analysis/sqlStatements.js";
import type { SyntaxParser } from "../../packages/sql/src/analysis/syntaxTree.js";
import {
  POSTGRES_SOURCE_LANGUAGE_IDS,
  postgresSourceLanguageId,
} from "../../packages/sql/src/authoring/documentLanguage.js";
import type {
  SqlAuthoringObject,
  SqlAuthoringSnapshot,
} from "../../packages/sql/src/authoring/protocol.js";
import {
  type FunctionDefinition,
  type ParsedCallSite,
  parseCall,
  parseSqlCalls,
} from "../../packages/sql/src/callParser.js";
import { registerAcceptanceControl } from "./acceptanceControl.js";
import { registerWorkbenchGraphDropBridge, WorkbenchGraphView } from "./cockpit/index.js";
import { registerGraphWorkbenchCommands } from "./cockpit/registerCommands.js";
import { WorkbenchGraphTreeSync } from "./cockpit/treeSync.js";
import {
  type CommandCallSite,
  type CommandFunctionDefinition,
  type DocumentConnectionTarget,
  debuggableSqlCall,
  debuggableSqlDefinition,
  PlpgsqlDiagnosticsProvider,
  SqlCodeLensProvider,
  type SqlDebugAvailability,
} from "./codeLens/index.js";
import {
  CallSiteConnectionStore,
  ConnectionManager,
  getConnectionName,
  ServerStore,
} from "./connection/index.js";
import { registerConnectionCommands } from "./connection/registerCommands.js";
import { openCoverageClient, PgTapTestController } from "./coverage/index.js";
import { DataViewEditorProvider } from "./dataView/dataViewEditorProvider.js";
import { dataViewSqlLabel } from "./dataView/dataViewUri.js";
import { DataViewQueryFileSystem } from "./dataView/queryFileSystem.js";
import { registerDataViewQueryLens } from "./dataView/queryLens.js";
import {
  buildRoutineArgs,
  buildRoutineTarget,
  configNameFromRoutine,
  configNameFromSql,
  DEBUG_LAUNCH_TOKEN_PROPERTY,
  DEBUG_RESULTS_VIEW_ID,
  type DebugLaunchDescriptor,
  DebugResultStore,
  DebugResultsViewProvider,
  DebugSessionController,
  manageDebugSessions,
  resolveDebugConfiguration,
} from "./debug/index.js";
import { debugResultSource } from "./debug/resultSource.js";
import { showRequirementsGuide } from "./docker/index.js";
import {
  createRoutineComparisonHandler,
  LEGEND,
  PlpgsqlInlineValuesProvider,
  PlpgsqlSemanticTokensProvider,
} from "./plpgsql/index.js";
import type { SqlNotebookWorkspace } from "./scratchpad/index.js";
import {
  registerSqlNotebook,
  type ScratchpadDebugEligibility,
  type ScratchpadDebugger,
  type ScratchpadDebugOutcome,
  type ScratchpadFeature,
  sqlResultSettings,
} from "./scratchpad/index.js";
import { CodeMonikerContentProvider, closePostgresqlDapTabs } from "./sources/index.js";
import {
  registerSqlAuthoring,
  resolveSqlAuthoringSettings,
  type SqlAuthoringNavigationTarget,
  type SqlAuthoringRegistration,
  sqlSyntaxAnalysisBudget,
} from "./sqlAuthoring/client.js";
import {
  buildWorkbenchObjectActions,
  buildWorkbenchObjects,
  buildWorkbenchTableMembers,
  FunctionItem,
  type PlpgsqlTreeItem,
  type ServerItem,
  WorkbenchDdlSyncController,
  WorkbenchIndexController,
  type WorkbenchIndexPhase,
  type WorkbenchObjectAction,
  type WorkbenchObjectActionId,
  type WorkbenchObjectModel,
  WorkbenchSourceUris,
  WorkbenchTreeDragAndDropController,
  WorkbenchTreeProvider,
} from "./workbench/index.js";
import {
  assignDocumentConnection,
  registerSqlWorkbenchCommands,
} from "./workbench/registerCommands.js";

const out = vscode.window.createOutputChannel("PostgreSQL Workbench");

interface LaunchDebugConfig {
  name?: string;
  sql?: string;
  entryRoutine?: DebugLaunchRoutineTarget;
  routine?: DebugLaunchRoutineTarget;
  routineArgs?: DebugLaunchRoutineArgument[];
  resultLabel?: string;
  resultSource?: DebugResultSource;
  serverId?: string;
  stopOnEntry?: boolean;
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
  const serverId =
    config.serverId ?? (cm.connectedServerIds.length === 1 ? cm.connectedServerIds[0] : undefined);
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
  workbenchSourceUris: WorkbenchSourceUris;
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
  sourceUris: WorkbenchSourceUris;
  output: vscode.OutputChannel;
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

function registerDebugCommands(options: DebugCommandOptions): void {
  const { context, connections, documentConnections, tree, sessions, index, sourceUris, output } =
    options;
  context.subscriptions.push(
    vscode.commands.registerCommand("postgresql-workbench.manageDebugSessions", () =>
      manageDebugSessions(connections, tree, output, () => sessions.statuses),
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.checkRequirements",
      async (item?: ServerItem) => {
        let server = item?.server;
        if (!server && connections.connectedServerIds.length === 1) {
          server = connections.store.get(connections.connectedServerIds[0]);
        }
        if (!server) {
          const action = await vscode.window.showInformationMessage(
            "Choose a connected PostgreSQL Connexion.",
            "Pick Connection",
            "Setup Guide",
          );
          if (action === "Pick Connection") await connections.commands.pickConnection();
          if (action === "Setup Guide") await showRequirementsGuide();
          return;
        }
        const check = await connections.checkRequirements(server.id);
        if (!check) return;
        if (check.available) {
          vscode.window.showInformationMessage(
            `${getConnectionName(server)}: pldbgapi ready — debugging available.`,
          );
        } else {
          const action = await vscode.window.showWarningMessage(check.error, "Setup Guide");
          if (action === "Setup Guide") await showRequirementsGuide();
        }
      },
    ),
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
        const uri = sourceUris.documentUri(item.symbolUri);
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
      createRoutineComparisonHandler(connections, index, sourceUris),
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

/** Where Code Moniker indexes: the open folders, or a private workspace when there is none. */
function codeMonikerWorkspaceRoots(context: vscode.ExtensionContext): string[] {
  const roots =
    vscode.workspace.workspaceFolders
      ?.filter((folder) => folder.uri.scheme === "file")
      .map((folder) => folder.uri.fsPath) ?? [];
  if (roots.length > 0) return roots;
  const fallback = vscode.Uri.joinPath(context.globalStorageUri, "code-moniker-workspace").fsPath;
  mkdirSync(fallback, { recursive: true });
  return [fallback];
}

interface DebugInfrastructureOptions {
  context: vscode.ExtensionContext;
  connections: ConnectionManager;
  index: WorkbenchIndexController;
  sourceUris: WorkbenchSourceUris;
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

function debugSessionConnectionName(
  connections: ConnectionManager,
  configuration: vscode.DebugConfiguration,
): string | undefined {
  const server =
    typeof configuration.server === "string"
      ? connections.store.get(configuration.server)
      : undefined;
  if (server) return getConnectionName(server);
  const { host, port, database, user } = configuration;
  if (typeof host !== "string" || typeof database !== "string") return undefined;
  const userPrefix = typeof user === "string" ? `${user}@` : "";
  const portSuffix = typeof port === "number" ? `:${port}` : "";
  return `${userPrefix}${host}${portSuffix}/${database}`;
}

function registerDebugInfrastructure(options: DebugInfrastructureOptions): DebugInfrastructure {
  const {
    context,
    connections,
    index,
    sourceUris,
    sessions,
    output,
    refreshTree,
    revealStoppedSource,
  } = options;
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
      const resultConnection = debugSessionConnectionName(connections, event.session.configuration);
      if (event.event === DEBUG_RESULT_EVENT && isDebugResult(event.body)) {
        resultStore.add(event.body, resultConnection);
        shouldRevealResults = true;
      } else if (event.event === DEBUG_RESULT_STATUS_EVENT && isDebugResultStatus(event.body)) {
        resultStore.addStatus(event.body, resultConnection);
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
    sourceUris,
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
            ? sourceUris.sourceDescriptorForDocumentUri(target)?.serverId
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
      const descriptor = sourceUris.sourceDescriptorForDocumentUri(document.uri);
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
        const routineSources = sourceUris.routineSourceUris(serverId);
        if (Object.keys(routineSources).length === 0) {
          vscode.window.showInformationMessage(
            "The active PostgreSQL index contains no debuggable routines.",
          );
          return undefined;
        }
        resolved.sourceUris = routineSources;
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
            name: `PL/pgSQL on ${getConnectionName(server)}`,
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
  sourceUris: WorkbenchSourceUris,
  output: vscode.OutputChannel,
  divergence: CodeMonikerContentProvider,
): void {
  context.subscriptions.push(
    new PlpgsqlDiagnosticsProvider(connections, () => index.syntaxParser(), sourceUris, divergence),
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
    await cm.removeConnectionConfiguration(id);
  };
  context.subscriptions.push(cm);
  // Indexing is domain code: VS Code answers where the runtime is and what to index.
  const workbenchIndex = new WorkbenchIndexController(
    {
      log: (message) => out.appendLine(message),
      runtimePath: () => join(context.extensionPath, "runtime", "code-moniker"),
      workspaceRoots: () => codeMonikerWorkspaceRoots(context),
      commandTimeoutMs: () =>
        vscode.workspace
          .getConfiguration("postgresql-workbench.workbench.codeMoniker")
          .get<number>("commandTimeoutMs", 30_000),
      acceptanceControlEnabled: () =>
        Boolean(
          process.env.POSTGRESQL_WORKBENCH_ACCEPTANCE_CONTROL_FILE &&
            context.extensionMode !== vscode.ExtensionMode.Production,
        ),
    },
    cm,
  );
  const workbenchSourceUris = new WorkbenchSourceUris(workbenchIndex);
  context.subscriptions.push({ dispose: () => workbenchIndex.dispose() });
  // The listener is domain code: VS Code supplies the log and the Schema Sync settings.
  const workbenchDdlSync = new WorkbenchDdlSyncController(cm, workbenchIndex, {
    log: (message) => out.appendLine(message),
    settings: () => {
      const configuration = vscode.workspace.getConfiguration(
        "postgresql-workbench.workbench.schemaSync",
      );
      return {
        enabled: configuration.get<boolean>("enabled", false),
        supportSchema: configuration.get<string>("supportSchema", "workbench"),
      };
    },
    onSettingsChanged: (listener) =>
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("postgresql-workbench.workbench.schemaSync")) listener();
      }),
  });
  context.subscriptions.push(workbenchDdlSync);
  armAcceptanceIndexPhaseGate = (phases) => workbenchIndex.armAcceptancePhaseGate(phases);
  releaseAcceptanceIndexPhaseGate = (runId, phase) =>
    workbenchIndex.releaseAcceptancePhaseGate(runId, phase);
  inspectAcceptanceWorkbenchState = () => ({
    connection: {
      connectedServerIds: [...cm.connectedServerIds],
      connected: cm.connectedServerIds.length > 0,
    },
    schemaSync: workbenchDdlSync.diagnosticStates(),
    index: workbenchIndex.acceptanceSnapshot(),
  });
  let debugScratchpadSql: ScratchpadDebugger = async () => ({
    started: false,
    message: "The PL/pgSQL debugger is still starting.",
  });
  let canDebugScratchpadSql: ScratchpadDebugEligibility = async () => false;
  let openScratchpadWithSql: ScratchpadFeature["openWithSql"] = async () => {
    throw new Error("Scratchpads are still starting.");
  };
  const dataViewQueryFiles = new DataViewQueryFileSystem();
  context.subscriptions.push(dataViewQueryFiles);
  let composeSqlAuthoring: SqlAuthoringRegistration["compose"] = async () => ({
    status: "rejected",
    message: "The SQL authoring server is still starting.",
  });
  const dataViews = new DataViewEditorProvider({
    parser: () => workbenchIndex.syntaxParser(),
    compose: (request) => composeSqlAuthoring(request),
    authoringSnapshot: (serverId, database) =>
      workbenchIndex.sqlAuthoringSnapshot({ serverId, database }),
    authoringSettings: (uri) => resolveSqlAuthoringSettings(uri),
    queryFiles: dataViewQueryFiles,
    treeDragPayload: (consume) => workbenchTreeDragAndDrop.activeAuthoringPayload(consume),
    associate: (documentUri, serverId) => callSiteConnections.assignDocument(documentUri, serverId),
    dissociate: (documentUri) => callSiteConnections.clearDocument(documentUri),
    openClient: (serverId) => {
      const timeoutMs = vscode.workspace
        .getConfiguration("postgresql-workbench.sql")
        .get<number>("statementTimeoutMs", 60_000);
      return openCoverageClient(cm, serverId, {
        applicationName: "postgresql-workbench:data-view",
        statementTimeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000,
      });
    },
    serverName: (serverId) => {
      const server = cm.store.get(serverId);
      return server ? getConnectionName(server) : undefined;
    },
    onConnectionsChanged: (listener) =>
      cm.onChanged((change) => {
        if (change.debugCapabilityOnly) return;
        listener(change.serverIds);
      }),
    resultSettings: () => sqlResultSettings(),
    openSql: async (source, sql) => {
      await openScratchpadWithSql(`${sql};\n`, cm.store.get(source.serverId));
    },
    output: out,
    extensionUri: context.extensionUri,
  });
  context.subscriptions.push(dataViews, dataViews.register(), registerDataViewQueryLens());
  const scratchpads = registerSqlNotebook(
    context,
    cm,
    async (sql) =>
      planSqlResultExecution(sql, await workbenchIndex.syntaxParser(), sqlSyntaxAnalysisBudget()),
    (request) => debugScratchpadSql(request),
    (request) => canDebugScratchpadSql(request),
    (request) =>
      dataViews.open({
        kind: "sql",
        serverId: request.association.serverId,
        database: request.association.database,
        sql: request.sql,
        label: dataViewSqlLabel(request.sql),
      }),
    (association) => {
      void cm.refreshDebugCapability(association.serverId);
      // A listening Schema Sync already refreshes this Connexion incrementally
      // from the committed DDL; a second full rebuild would only race it.
      if (workbenchDdlSync.state(association.serverId).status === "listening") return;
      workbenchIndex.markDatabaseStale(
        association.serverId,
        association.database,
        "Schema changed from a Scratchpad",
      );
      const client = cm.getClient(association.serverId);
      if (!client) return;
      void workbenchIndex
        .indexPostgresDatabase(client, {
          serverId: association.serverId,
          database: association.database,
        })
        .catch((error) =>
          out.appendLine(
            `Automatic Workbench refresh after Scratchpad DDL failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    },
  );
  openScratchpadWithSql = (sql, association) => scratchpads.openWithSql(sql, association);
  context.subscriptions.push(
    workbenchIndex.onDidChangeState(() => scratchpads.refreshCellStatus()),
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
    indexedDependencies: (serverId, routine) =>
      workbenchIndex.routineDependencies(routine.oid, serverId),
    indexDatabase: async (serverId, client) => {
      const server = cm.store.get(serverId);
      if (!server) throw new Error(`Unknown PostgreSQL connection: ${serverId}`);
      const state = workbenchIndex.databaseState({ serverId, database: server.database });
      if (state.status !== "indexing" && state.result) {
        return;
      }
      await workbenchIndex.indexPostgresDatabase(client, {
        serverId,
        database: server.database,
      });
    },
    resolveRoutineSymbolUri: (serverId, oid) => workbenchIndex.routineSymbol(serverId, oid)?.uri,
    resolveDocumentUri: (symbolUri) => workbenchSourceUris.documentUri(symbolUri),
    resolveSource: (uri) => {
      const source = workbenchSourceUris.sourceDescriptorForDocumentUri(uri);
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
  inspectAcceptanceTestingState = () => {
    const serverId = cm.connectedServerIds.length === 1 ? cm.connectedServerIds[0] : undefined;
    const server = serverId ? cm.store.get(serverId) : undefined;
    const state = server
      ? workbenchIndex.databaseState({ serverId: server.id, database: server.database })
      : { status: "not-indexed" as const };
    return {
      coverage: acceptanceCoverage,
      index: {
        database: state.result?.database,
        generation: state.result?.generation,
        revision: state.result?.revision,
        serverId: state.result?.serverId,
        status: state.status,
      },
      run: acceptanceTestRun,
    };
  };
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
    const state = workbenchIndex.databaseState(object);
    const result = state.result;
    if (
      (state.status === "indexing" &&
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
      case "open-data":
        return vscode.commands.executeCommand("postgresql-workbench.openDataView", object);
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
  const debugSessions = new DebugSessionController(() =>
    connectionTreeProvider?.refreshServer(debugSessions.active?.serverId),
  );
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
  /** Resolves the debuggable entry points of a Scratchpad cell against an available snapshot. */
  const scratchpadDebugTargets = async (
    sql: string,
    snapshot: SqlAuthoringSnapshot,
  ): Promise<{
    triggerRoutine?: SqlAuthoringObject;
    picks: Array<{ label: string; description: string; call: ParsedCallSite }>;
  }> => {
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
      return { triggerRoutine, picks: [] };
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
    return { picks };
  };
  canDebugScratchpadSql = async ({ sql, association }) => {
    if (cm.debugCapabilityFor(association.serverId).status !== "available") return false;
    const snapshot = workbenchIndex.sqlAuthoringSnapshot(association);
    if (snapshot?.status !== "available" || !sql.trim()) return false;
    try {
      const targets = await scratchpadDebugTargets(sql, snapshot);
      return Boolean(targets.triggerRoutine) || targets.picks.length > 0;
    } catch {
      return false;
    }
  };
  debugScratchpadSql = async ({ sql, association, source }) => {
    const snapshot = workbenchIndex.sqlAuthoringSnapshot(association);
    if (snapshot?.status !== "available") {
      const server = cm.store.get(association.serverId);
      void vscode.window
        .showWarningMessage(
          `Debug needs a fresh Workbench Index of ${server ? getConnectionName(server) : association.database}.`,
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
    const { triggerRoutine, picks } = await scratchpadDebugTargets(sql, snapshot);
    if (picks.length === 0) {
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
    sourceUris: workbenchSourceUris,
    sessions: debugSessions,
    output: out,
    refreshTree: () => connectionTreeProvider?.refreshServer(debugSessions.active?.serverId),
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
    const authoring = await registerSqlAuthoring(
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
    );
    composeSqlAuthoring = (request, token) => authoring.compose(request, token);
    context.subscriptions.push(authoring);
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
    graphTreeSync.invalidateCockpitContext();
  };
  const syncGraphFromTree = graphTreeSync.bind();
  const scheduleDebugSessionRefresh = (serverId: string | undefined) => {
    for (const delay of [100, 500, 2_000, 5_000]) {
      setTimeout(() => connectionTreeProvider.refreshServer(serverId), delay);
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
    cm.onServerChanged((change) => {
      const database = workbenchGraph.currentDatabase;
      if (!database || !change.serverIds.includes(database.serverId)) return;
      graphTreeSync.invalidateCockpitContext();
      workbenchGraph.invalidateCockpitContext();
    }),
    workbenchIndex.onDidChangeState((state) => {
      const database = workbenchGraph.currentDatabase;
      if (
        database &&
        state.status === "available" &&
        state.result?.serverId === database.serverId &&
        state.result.database === database.database
      ) {
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
        scheduleDebugSessionRefresh(debugSessions.active?.serverId);
      }
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (session.type === "postgresql-workbench") {
        const serverId =
          typeof session.configuration.server === "string"
            ? session.configuration.server
            : debugSessions.active?.serverId;
        scheduleDebugSessionRefresh(serverId);
      }
    }),
  );
  void closePostgresqlDapTabs();

  context.subscriptions.push(
    contentProvider.onDidChangeFile((events) => {
      const serverIds = new Set<string>();
      for (const event of events) {
        if (event.uri.scheme !== CodeMonikerContentProvider.SCHEME) continue;
        const descriptor = workbenchSourceUris.sourceDescriptorForDocumentUri(event.uri);
        if (descriptor) serverIds.add(descriptor.serverId);
      }
      for (const serverId of serverIds) treeProvider.refreshServer(serverId);
    }),
  );

  const connectionSnapshot = (serverId: string) => {
    const server = cm.store.get(serverId);
    return server
      ? workbenchIndex.sqlAuthoringSnapshot({ serverId: server.id, database: server.database })
      : undefined;
  };
  const debuggerCapabilityAvailability = (serverId: string): SqlDebugAvailability | undefined => {
    const capability = cm.debugCapabilityFor(serverId);
    if (capability.status === "available") return undefined;
    return {
      status: "unavailable",
      reason:
        capability.status === "checking"
          ? "Checking debugger capability"
          : "Debugger extension unavailable",
    };
  };
  const codeLens = new SqlCodeLensProvider(() => workbenchIndex.syntaxParser(), {
    forDocument: (documentUri) => {
      const uri = vscode.Uri.parse(documentUri);
      const binding =
        uri.scheme === CodeMonikerContentProvider.SCHEME
          ? workbenchSourceUris.sourceDescriptorForDocumentUri(uri)
          : undefined;
      const serverId = binding?.serverId ?? callSiteConnections.getDocument(documentUri);
      const server = serverId ? cm.store.get(serverId) : undefined;
      return server ? { id: server.id, name: getConnectionName(server) } : undefined;
    },
    indexState: (connection) => {
      const snapshot = connectionSnapshot(connection.id);
      return snapshot ? (snapshot.status === "available" ? "available" : "stale") : "missing";
    },
    debugCallAvailability: (connection, call) =>
      debuggerCapabilityAvailability(connection.id) ??
      debuggableSqlCall(connectionSnapshot(connection.id), call),
    debugDefinitionAvailability: (connection, definition) =>
      debuggerCapabilityAvailability(connection.id) ??
      debuggableSqlDefinition(connectionSnapshot(connection.id), definition),
    canDeployManagedRoutine: (documentUri) => {
      const uri = vscode.Uri.parse(documentUri);
      const descriptor = workbenchSourceUris.sourceDescriptorForDocumentUri(uri);
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
    output: out,
    context,
    connections: cm,
    codeLens,
    dataViews,
    documentConnections: callSiteConnections,
    index: workbenchIndex,
    sourceUris: workbenchSourceUris,
    tree: treeProvider,
    graph: workbenchGraph,
    graphSync: graphTreeSync,
    coverage: coverageTests,
    resultStore,
    resultsView,
    objectActions: workbenchObjectActions,
    runObjectAction: runWorkbenchObjectAction,
    search: workbenchSearch,
    revealSources: (serverId) => revealSources(workbenchTree, treeProvider, serverId),
    selectedTreeItems: () => workbenchTree.selection,
  });
  registerGraphWorkbenchCommands({
    context,
    connections: cm,
    index: workbenchIndex,
    sourceUris: workbenchSourceUris,
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
    sourceUris: workbenchSourceUris,
    output: out,
  });

  registerResultCommands(context, resultStore);

  registerDiagnosticsAndReconnect(
    context,
    cm,
    workbenchIndex,
    workbenchSourceUris,
    out,
    contentProvider,
  );

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
    workbenchSourceUris,
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

async function revealSources(
  tree: vscode.TreeView<PlpgsqlTreeItem>,
  provider: WorkbenchTreeProvider,
  serverId: string,
): Promise<void> {
  const sources = provider.sourcesItem(serverId);
  if (sources) await tree.reveal(sources, { expand: true, focus: false });
}

async function revealSqlAuthoringReference(
  target: SqlAuthoringNavigationTarget,
  index: WorkbenchIndexController,
  provider: WorkbenchTreeProvider,
  tree: vscode.TreeView<PlpgsqlTreeItem>,
  graphSync: WorkbenchGraphTreeSync,
): Promise<boolean> {
  const identity = { serverId: target.serverId, database: target.database };
  const state = index.databaseState(identity);
  const result = state.result;
  if (
    state.status !== "available" ||
    !result ||
    result.serverId !== target.serverId ||
    result.database !== target.database
  ) {
    return false;
  }
  const symbols = index.databaseSymbols(identity);
  const object = buildWorkbenchObjects(symbols, target).find(
    (candidate) => candidate.oid === target.oid,
  );
  if (!object) return false;
  if (!target.column) return graphSync.navigateToObject(object);

  const parent = provider.itemForObject(object);
  if (!parent) return false;
  await tree.reveal(parent, { select: false, focus: false, expand: true });
  const members = buildWorkbenchTableMembers(symbols, object);
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
    ...(typeof config.server === "string" ? { serverId: config.server } : {}),
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
