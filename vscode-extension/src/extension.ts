import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { WorkbenchDdlSyncController } from "../../packages/catalog/src/ddlSync.js";
import { WorkbenchIndexController } from "../../packages/catalog/src/indexController.js";
import {
  buildWorkbenchObjectActions,
  type WorkbenchObjectAction,
  type WorkbenchObjectActionId,
} from "../../packages/catalog/src/objectActions.js";
import {
  buildWorkbenchObjects,
  buildWorkbenchTableMembers,
  type WorkbenchObjectModel,
} from "../../packages/catalog/src/objectModel.js";
import { getConnectionName } from "../../packages/catalog/src/savedConnection.js";
import type { DebugSessionStatus } from "../../packages/dap/src/debugger/launch/index.js";
import { DebugSessionController } from "../../packages/dap/src/debugger/launch/sessionController.js";
import type { DebugResultStore } from "../../packages/rows/src/capturedResults.js";
import { planSqlResultExecution } from "../../packages/sql/src/analysis/sqlStatements.js";
import { POSTGRES_SOURCE_LANGUAGE_IDS } from "../../packages/sql/src/text/documentLanguage.js";
import { createAcceptanceProbes, registerAcceptanceControl } from "./acceptanceControl.js";
import { registerWorkbenchGraphDropBridge, WorkbenchGraphView } from "./cockpit/index.js";
import { registerGraphWorkbenchCommands } from "./cockpit/registerCommands.js";
import { WorkbenchGraphTreeSync } from "./cockpit/treeSync.js";
import {
  debuggableSqlCall,
  debuggableSqlDefinition,
  PlpgsqlDiagnosticsProvider,
  SqlCodeLensProvider,
  type SqlDebugAvailability,
} from "./codeLens/index.js";
import { CallSiteConnectionStore, ConnectionManager } from "./connection/index.js";
import { registerConnectionCommands } from "./connection/registerCommands.js";
import { openCoverageClient, PgTapTestController } from "./coverage/index.js";
import { DataViewEditorProvider } from "./dataView/dataViewEditorProvider.js";
import { dataViewSqlLabel } from "./dataView/dataViewUri.js";
import { DataViewQueryFileSystem } from "./dataView/queryFileSystem.js";
import { registerDataViewQueryLens } from "./dataView/queryLens.js";
import {
  debugLaunchToken,
  registerDebugCommands,
  registerDebugInfrastructure,
  registerResultCommands,
  revealStoppedSource,
} from "./debug/registerCommands.js";
import { createScratchpadDebugging } from "./scratchpad/debugBridge.js";
import type { SqlNotebookWorkspace } from "./scratchpad/index.js";
import {
  registerSqlNotebook,
  type ScratchpadDebugEligibility,
  type ScratchpadDebugger,
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
} from "./sqlAuthoring.js";
import {
  FunctionItem,
  type PlpgsqlTreeItem,
  WorkbenchSourceUris,
  WorkbenchTreeDragAndDropController,
  WorkbenchTreeProvider,
} from "./workbench/index.js";
import { registerSqlWorkbenchCommands } from "./workbench/registerCommands.js";

const out = vscode.window.createOutputChannel("PostgreSQL Workbench");

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
  /* What a Data View can be asked for from outside it: opened, and read back. Not the editor
   * provider whole — `exports` reaches every installed extension, and the rest of that class is
   * VS Code's to call. */
  dataViews: Pick<DataViewEditorProvider, "open" | "opened">;
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

  const acceptanceProbes = createAcceptanceProbes();
  const acceptanceControl = registerAcceptanceControl(context, acceptanceProbes);
  if (acceptanceControl) context.subscriptions.push(acceptanceControl);

  const cm = new ConnectionManager(context, out);
  acceptanceProbes.removeServer = async (id) => {
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
  acceptanceProbes.armIndexPhaseGate = (phases) => workbenchIndex.armAcceptancePhaseGate(phases);
  acceptanceProbes.releaseIndexPhaseGate = (runId, phase) =>
    workbenchIndex.releaseAcceptancePhaseGate(runId, phase);
  acceptanceProbes.inspectWorkbenchState = () => ({
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
  acceptanceProbes.inspectTestingState = () => {
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
  const scratchpadDebugging = createScratchpadDebugging({
    connections: cm,
    index: workbenchIndex,
    debugSessions,
    output: out,
  });
  canDebugScratchpadSql = scratchpadDebugging.canDebugScratchpadSql;
  debugScratchpadSql = scratchpadDebugging.debugScratchpadSql;
  acceptanceProbes.inspectDebugState = scratchpadDebugging.inspectAcceptanceDebugState;
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
  acceptanceProbes.resetWorkbench = async () => {
    await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
    // Before the tabs close: a Scratchpad closed with an open Transaction warns the user, and a
    // reset owes the next scenario a clean workbench rather than a dialog.
    await scratchpads.transactions.rollbackAll();
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
    dataViews,
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
