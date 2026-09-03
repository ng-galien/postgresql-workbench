import * as vscode from "vscode";
import type { CallSiteConnectionStore } from "../../../packages/catalog/src/callSiteAssociations.js";
import type { WorkbenchIndexController } from "../../../packages/catalog/src/indexController.js";
import type {
  WorkbenchObjectAction,
  WorkbenchObjectActionId,
} from "../../../packages/catalog/src/objectActions.js";
import type { WorkbenchObjectModel } from "../../../packages/catalog/src/objectModel.js";
import {
  type ConnectionConfig,
  getConnectionName,
} from "../../../packages/catalog/src/savedConnection.js";
import {
  clampDebugResultRows,
  DEBUG_RESULT_LIMITS,
} from "../../../packages/dap/src/debugger/launch/index.js";
import type { DebugResultStore } from "../../../packages/rows/src/capturedResults.js";
import {
  executeSqlSelection,
  prepareSqlSelection,
} from "../../../packages/rows/src/runSelection.js";
import { classifySqlStatementCount } from "../../../packages/sql/src/analysis/sqlStatements.js";
import { postgresSourceLanguageId } from "../../../packages/sql/src/text/documentLanguage.js";
import { sqlStatementAtOffset } from "../../../packages/sql/src/text/sqlLexing.js";
import type { WorkbenchGraphTreeSync, WorkbenchGraphView } from "../cockpit/index.js";
import type {
  CommandSqlStatement,
  DocumentConnectionTarget,
  SqlCodeLensProvider,
} from "../codeLens/index.js";
import type { ConnectionManager } from "../connection/index.js";
import type { PgTapTestController } from "../coverage/index.js";
import type { DataViewEditorProvider } from "../dataView/dataViewEditorProvider.js";
import { dataViewSqlLabel } from "../dataView/dataViewUri.js";
import type { DebugResultsViewProvider } from "../debug/index.js";
import { debugResultSource } from "../debug/resultSource.js";
import { CodeMonikerContentProvider } from "../sources/index.js";
import { REFRESH_SQL_AUTHORING_CONTEXT_COMMAND, sqlSyntaxAnalysisBudget } from "../sqlAuthoring.js";
import type {
  FunctionItem,
  PlpgsqlTreeItem,
  WorkbenchObjectItem,
  WorkbenchRelationTargetItem,
  WorkbenchSourceUris,
  WorkbenchTreeProvider,
} from "./index.js";

/**
 * The VS Code commands of the Workbench: opening a routine's source, running and profiling it,
 * searching the indexed tree, and the Data View entry points. `WorkbenchCommandOptions` is the
 * shared bag every Workbench-facing registration receives.
 */

export interface WorkbenchCommandOptions {
  context: vscode.ExtensionContext;
  connections: ConnectionManager;
  index: WorkbenchIndexController;
  sourceUris: WorkbenchSourceUris;
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
export interface SqlWorkbenchCommandOptions extends WorkbenchCommandOptions {
  codeLens: SqlCodeLensProvider;
  output: vscode.OutputChannel;
  dataViews: DataViewEditorProvider;
  documentConnections: CallSiteConnectionStore;
  revealSources(connectionId: string): Thenable<void>;
  selectedTreeItems(): readonly PlpgsqlTreeItem[];
}
export function registerSqlWorkbenchCommands(options: SqlWorkbenchCommandOptions): void {
  const {
    context,
    connections,
    documentConnections,
    index,
    sourceUris,
    tree,
    coverage,
    resultStore,
    resultsView,
    codeLens,
  } = options;
  context.subscriptions.push(
    /*
     * Pointing a document, or one call inside it, at the Connection it runs on. Registered here
     * because assignDocumentConnection is this module's, not the entry point's.
     */
    vscode.commands.registerCommand(
      "postgresql-workbench.assignDocumentConnection",
      (target: DocumentConnectionTarget, requestedConnectionId?: string) =>
        assignDocumentConnection(
          connections,
          documentConnections,
          codeLens,
          target,
          requestedConnectionId,
        ),
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.assignCallConnection",
      (target: DocumentConnectionTarget, requestedConnectionId?: string) =>
        assignDocumentConnection(
          connections,
          documentConnections,
          codeLens,
          target,
          requestedConnectionId,
        ),
    ),
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
      let connectionId = documentConnections.getDocument(document.uri.toString());
      if (!connectionId) {
        const assigned = await assignDocumentConnection(
          connections,
          documentConnections,
          options.codeLens,
          { documentUri: document.uri.toString() },
        );
        if (!assigned) return false;
        connectionId = documentConnections.getDocument(document.uri.toString());
      }
      const connection = connectionId ? connections.store.get(connectionId) : undefined;
      if (!connection) {
        void vscode.window.showInformationMessage("Choose an available Document Association.");
        return false;
      }
      const client = await openDocumentSqlClient(
        connections,
        connection,
        options.output,
        document.uri.toString(),
        () =>
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
        let connectionId = documentConnections.getDocument(statement.documentUri);
        if (!connectionId) {
          const assigned = await assignDocumentConnection(
            connections,
            documentConnections,
            options.codeLens,
            { documentUri: statement.documentUri },
          );
          if (!assigned) return false;
          connectionId = documentConnections.getDocument(statement.documentUri);
        }
        const connection = connectionId ? connections.store.get(connectionId) : undefined;
        if (!connection) {
          void vscode.window.showInformationMessage("Choose an available Document Association.");
          return false;
        }
        const client = await openDocumentSqlClient(
          connections,
          connection,
          options.output,
          statement.documentUri,
          () =>
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
    vscode.commands.registerCommand(
      "postgresql-workbench.openDataView",
      async (input?: WorkbenchObjectModel | WorkbenchObjectItem | WorkbenchRelationTargetItem) => {
        const selected = input ?? options.selectedTreeItems()[0];
        if (!selected) return false;
        const object =
          "target" in selected
            ? selected.target.object
            : "object" in selected
              ? selected.object
              : "symbolUri" in selected
                ? selected
                : undefined;
        if (!object || (object.kind !== "table" && object.kind !== "view")) {
          void vscode.window.showInformationMessage(
            "Data Views open tables and views. Select one in the Workbench tree.",
          );
          return false;
        }
        await options.dataViews.open({
          kind: "relation",
          connectionId: object.connectionId,
          database: object.database,
          schema: object.schema,
          name: object.name,
          relationKind: object.kind,
        });
        return true;
      },
    ),
    vscode.commands.registerCommand("postgresql-workbench.openDataViewForStatement", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage("Open a SQL editor first.");
        return false;
      }
      const document = editor.document;
      const documentUri = document.uri.toString();
      const offset = document.offsetAt(editor.selection.active);
      const selectedText = document.getText(editor.selection).trim();
      const statement = selectedText || sqlStatementAtOffset(document.getText(), offset).text;
      if (!statement?.trim()) {
        void vscode.window.showInformationMessage("Place the cursor in a SQL Statement first.");
        return false;
      }
      let connectionId = documentConnections.getDocument(documentUri);
      if (!connectionId) {
        const assigned = await assignDocumentConnection(
          connections,
          documentConnections,
          options.codeLens,
          { documentUri },
        );
        if (!assigned) return false;
        connectionId = documentConnections.getDocument(documentUri);
      }
      const connection = connectionId ? connections.store.get(connectionId) : undefined;
      if (!connection) {
        void vscode.window.showInformationMessage("Choose an available Document Association.");
        return false;
      }
      await options.dataViews.open({
        kind: "sql",
        connectionId: connection.id,
        database: connection.database,
        sql: statement,
        label: dataViewSqlLabel(statement),
      });
      return true;
    }),
    vscode.commands.registerCommand(
      "postgresql-workbench.indexDatabase",
      async (target?: string | { connection?: { id?: string } }) => {
        const requestedConnectionId =
          typeof target === "string"
            ? target
            : typeof target?.connection?.id === "string"
              ? target.connection.id
              : undefined;
        const connectionId =
          requestedConnectionId ??
          (connections.connectedConnectionIds.length === 1
            ? connections.connectedConnectionIds[0]
            : await pickConnectedConnectionId(connections));
        if (!connectionId) {
          return undefined;
        }
        const connection = connections.store.get(connectionId);
        if (!connection) return undefined;
        await options.revealSources(connectionId);
        try {
          return await index.indexDatabase(connectionId);
        } catch (error) {
          const state = index.databaseState({ connectionId, database: connection.database });
          if (state.status === "cancelled") return undefined;
          const message = error instanceof Error ? error.message : String(error);
          if (state.status !== "error" && state.status !== "stale") {
            void vscode.window.showErrorMessage(`PostgreSQL indexing failed: ${message}`);
          }
          return undefined;
        }
      },
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.indexAssociation",
      async (target?: { connectionId?: string }) => {
        const connection = target?.connectionId
          ? connections.store.get(target.connectionId)
          : undefined;
        if (!connection) {
          void vscode.window.showInformationMessage("Choose an available Association first.");
          return false;
        }
        const client = await openDocumentSqlClient(
          connections,
          connection,
          options.output,
          connection.id,
          async () => false,
        );
        if (!client) return false;
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Indexing ${getConnectionName(connection)}`,
            },
            () =>
              index.indexPostgresDatabase(client, {
                connectionId: connection.id,
                database: connection.database,
              }),
          );
          options.codeLens.refresh();
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          options.output.appendLine(
            `Association indexing failed (${getConnectionName(connection)}): ${message}`,
          );
          void vscode.window.showErrorMessage(
            `Indexing ${getConnectionName(connection)} failed. See the PostgreSQL Workbench output.`,
          );
          return false;
        } finally {
          await client.end().catch(() => {});
        }
      },
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.cancelDatabaseIndex",
      (target?: string | { connection?: { id?: string } }) => {
        const connectionId =
          typeof target === "string"
            ? target
            : typeof target?.connection?.id === "string"
              ? target.connection.id
              : undefined;
        return index.cancelDatabaseIndex(connectionId);
      },
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
        const state = index.databaseState({
          connectionId: object.connectionId,
          database: object.database,
        });
        const result = state.result;
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
        const uri = sourceUris.documentUri(object.symbolUri);
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

/** Opens the PostgreSQL client for a free SQL document's Document Association. */
async function openDocumentSqlClient(
  connections: ConnectionManager,
  connection: ConnectionConfig,
  output: vscode.OutputChannel,
  documentUri: string,
  reassign: () => Promise<boolean>,
): Promise<Awaited<ReturnType<ConnectionManager["openClient"]>> | undefined> {
  const timeoutMs = vscode.workspace
    .getConfiguration("postgresql-workbench.sql")
    .get<number>("statementTimeoutMs", 60_000);
  try {
    return await connections.openClient(connection.id, {
      applicationName: "postgresql-workbench:sql",
      statementTimeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60_000,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    output.appendLine(
      `SQL execution connection failed (${getConnectionName(connection)}, ${documentUri}): ${detail}`,
    );
    const password = await connections.store.getPassword(connection.id);
    const choice =
      password === undefined
        ? await vscode.window.showErrorMessage(
            `Connection ${getConnectionName(connection)} has no saved password.`,
            "Change Password",
            "Change Association",
          )
        : await vscode.window.showErrorMessage(
            `Cannot connect to ${getConnectionName(connection)}. See the PostgreSQL Workbench output for details.`,
            "Show Output",
            "Change Association",
          );
    if (choice === "Change Password") await connections.commands.changePassword(connection.id);
    else if (choice === "Change Association") await reassign();
    else if (choice === "Show Output") output.show(true);
    return undefined;
  }
}
export async function assignDocumentConnection(
  cm: ConnectionManager,
  assignments: CallSiteConnectionStore,
  codeLens: SqlCodeLensProvider,
  target: DocumentConnectionTarget,
  requestedConnectionId?: string,
): Promise<boolean> {
  let connection: ConnectionConfig | undefined;
  const current = assignments.getDocument(target.documentUri);
  if (requestedConnectionId) {
    connection = cm.store.get(requestedConnectionId);
  } else if (cm.connections.length === 0) {
    const action = await vscode.window.showInformationMessage(
      "No saved Connection is available for the Document Association.",
      "Add Connection",
    );
    if (action !== "Add Connection") return false;
    connection = await cm.commands.addConnection();
  } else if (cm.connections.length === 1) {
    connection = cm.connections[0];
    if (connection && current === connection.id) {
      void vscode.window.showInformationMessage(
        `${getConnectionName(connection)} is the only saved Connection; add another connection to change the Document Association.`,
      );
    }
  } else {
    const picked = await vscode.window.showQuickPick(
      cm.connections.map((candidate) => ({
        label: getConnectionName(candidate),
        description: [
          current === candidate.id ? "Current Association" : undefined,
          cm.isConnectionConnected(candidate.id) ? "Connected" : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
        connection: candidate,
      })),
      {
        title: "Document Association",
        placeHolder: "Saved Connection used by Run and Debug in this document",
        ignoreFocusOut: true,
      },
    );
    connection = picked?.connection;
  }
  if (!connection) return false;

  await assignments.assignDocument(target.documentUri, connection.id);
  codeLens.refresh();
  await vscode.commands.executeCommand(REFRESH_SQL_AUTHORING_CONTEXT_COMMAND);
  return true;
}

/** Asks which connected Connection to work against when the command carries no context. */
export async function pickConnectedConnectionId(
  connections: ConnectionManager,
): Promise<string | undefined> {
  const items = connections.connectedConnectionIds.flatMap((connectionId) => {
    const connection = connections.store.get(connectionId);
    return connection ? [{ label: getConnectionName(connection), connectionId }] : [];
  });
  if (items.length === 0) {
    void vscode.window.showInformationMessage("Connect a PostgreSQL Connection before indexing.");
    return undefined;
  }
  return (
    await vscode.window.showQuickPick(items, {
      title: "Choose the Connection to index",
      placeHolder: "Each Connection owns an independent database index",
    })
  )?.connectionId;
}
