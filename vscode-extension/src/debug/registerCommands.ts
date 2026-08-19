import * as vscode from "vscode";
import type {
  DebugLaunchRoutineArgument,
  DebugResult,
  DebugResultSource,
  DebugResultStatus,
} from "../../../packages/dap/src/debugger/launch/index.js";
import {
  DEBUG_RESULT_EVENT,
  DEBUG_RESULT_LIMITS,
  DEBUG_RESULT_STATUS_EVENT,
  DEBUG_SESSION_STATUS_EVENT,
  type DebugLaunchRoutineTarget,
  type DebugSessionStatus,
} from "../../../packages/dap/src/debugger/launch/index.js";
import type { SyntaxParser } from "../../../packages/sql/src/analysis/syntaxTree.js";
import {
  POSTGRES_SOURCE_LANGUAGE_IDS,
  postgresSourceLanguageId,
} from "../../../packages/sql/src/authoring/documentLanguage.js";
import { type FunctionDefinition, parseCall } from "../../../packages/sql/src/callParser.js";
import type { CommandCallSite, CommandFunctionDefinition } from "../codeLens/index.js";
import {
  type CallSiteConnectionStore,
  type ConnectionManager,
  getConnectionName,
  ServerStore,
} from "../connection/index.js";
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
  type DebugSessionController,
  manageDebugSessions,
  resolveDebugConfiguration,
} from "../debug/index.js";
import { debugResultSource } from "../debug/resultSource.js";
import { showRequirementsGuide } from "../docker/index.js";
import {
  createRoutineComparisonHandler,
  LEGEND,
  PlpgsqlInlineValuesProvider,
  PlpgsqlSemanticTokensProvider,
} from "../plpgsql/index.js";
import { CodeMonikerContentProvider, closePostgresqlDapTabs } from "../sources/index.js";
import type {
  FunctionItem,
  ServerItem,
  WorkbenchIndexController,
  WorkbenchSourceUris,
  WorkbenchTreeProvider,
} from "../workbench/index.js";

/**
 * The VS Code side of debugging: the debug adapter descriptor and configuration provider, the
 * session lifecycle (inline values, stopped source, RAISE NOTICE), and the commands that start a
 * debug session from a routine, a call site, or a captured result.
 */

export interface DebugInfrastructureOptions {
  context: vscode.ExtensionContext;
  connections: ConnectionManager;
  index: WorkbenchIndexController;
  sourceUris: WorkbenchSourceUris;
  sessions: DebugSessionController;
  output: vscode.OutputChannel;
  refreshTree: () => void;
  revealStoppedSource: (session: vscode.DebugSession, status: DebugSessionStatus) => void;
}
export interface DebugCommandOptions {
  context: vscode.ExtensionContext;
  connections: ConnectionManager;
  documentConnections: CallSiteConnectionStore;
  tree: WorkbenchTreeProvider;
  sessions: DebugSessionController;
  index: WorkbenchIndexController;
  sourceUris: WorkbenchSourceUris;
  output: vscode.OutputChannel;
}
export function registerDebugInfrastructure(
  options: DebugInfrastructureOptions,
): DebugInfrastructure {
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
  const resultsView = new DebugResultsViewProvider(resultStore, context.extensionUri);
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
export function registerDebugCommands(options: DebugCommandOptions): void {
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
          options.output,
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
          options.output,
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
          options.output,
        );
      },
    ),
  );
}
export async function launchDebug(
  cm: ConnectionManager,
  debugSessions: DebugSessionController,
  config: LaunchDebugConfig,
  parser: SyntaxParser,
  output: vscode.OutputChannel,
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

  output.appendLine(
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
    output.appendLine("launchDebug: startDebugging returned false — session not started");
    vscode.window.showWarningMessage(
      "PL/pgSQL debug not started — no server selected or configuration cancelled.",
    );
    return false;
  }

  await persistLaunchConfig(folder, debugConfig).catch((err) =>
    output.appendLine(`persistLaunchConfig failed: ${err}`),
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
export async function revealStoppedSource(
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
export async function promptArgs(def: FunctionDefinition): Promise<string[] | undefined> {
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
export function debugSessionConnectionName(
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
export function debugDescriptor(
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

export interface DebugInfrastructure {
  resultStore: DebugResultStore;
  resultsView: DebugResultsViewProvider;
  contentProvider: CodeMonikerContentProvider;
}
export interface LaunchDebugConfig {
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
export function isDebugResult(value: unknown): value is DebugResult {
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
export function isDebugResultStatus(value: unknown): value is DebugResultStatus {
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
export function isDebugSessionStatus(value: unknown): value is DebugSessionStatus {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DebugSessionStatus>;
  return (
    typeof candidate.sessionId === "string" &&
    typeof candidate.state === "string" &&
    typeof candidate.timestamp === "string"
  );
}
export function debugLaunchToken(config: vscode.DebugConfiguration): string | undefined {
  const value = config[DEBUG_LAUNCH_TOKEN_PROPERTY];
  return typeof value === "string" ? value : undefined;
}
export function routineName(routine: { schema: string | null; name: string }): string {
  return routine.schema ? `${routine.schema}.${routine.name}` : routine.name;
}
