import { TextDecoder, TextEncoder } from "node:util";
import * as vscode from "vscode";
import type { SqlExecutionPlan, SqlExecutionStatement } from "../../src/analysis/sqlStatements.js";
import {
  clampDebugResultRows,
  DEBUG_RESULT_LIMITS,
  type DebugResult,
  type DebugResultError,
  type DebugResultStatus,
} from "../../src/debugger/launch/index.js";
import type { ConnectionManager } from "./connectionManager.js";
import { ScratchpadTransactionManager } from "./scratchpadTransactions.js";
import type { ServerConfig } from "./serverStore.js";
import {
  createDedicatedNotebookClient,
  DedicatedNotebookConnectionError,
  withDedicatedNotebookClient,
} from "./sqlNotebookConnection.js";
import { SQL_NOTEBOOK_SCHEME, SqlNotebookFileSystemProvider } from "./sqlNotebookFileSystem.js";
import {
  associationFingerprint,
  associationSnapshot,
  emptySqlNotebook,
  normalizeSqlNotebookName,
  parseSqlNotebookFile,
  resolveScratchpadAssociation,
  type ScratchpadAssociation,
  type ScratchpadAssociationSnapshot,
  type ScratchpadExecutionMode,
  SQL_NOTEBOOK_RESULT_MIME,
  SQL_NOTEBOOK_TYPE,
  type SqlNotebookErrorPayload,
  type SqlNotebookFile,
  type SqlNotebookMetadata,
  type SqlNotebookResultPayload,
  scratchpadCreationAssociation,
  scratchpadExecutionMode,
  serializeSqlNotebookFile,
  sqlNotebookResultPayload,
} from "./sqlNotebookModel.js";
import { postgresCursorSafetyTimeoutMs, SqlNotebookResultHost } from "./sqlNotebookResultHost.js";
import {
  DELETE_SQL_NOTEBOOK_COMMAND,
  DUPLICATE_SQL_NOTEBOOK_COMMAND,
  EXPORT_SQL_NOTEBOOK_COMMAND,
  OPEN_SQL_NOTEBOOK_COMMAND,
  REFRESH_SQL_NOTEBOOKS_COMMAND,
  RENAME_SQL_NOTEBOOK_COMMAND,
  type SqlNotebookEntry,
  SqlNotebookWorkspace,
} from "./sqlNotebookWorkspace.js";
import { PostgresCursorReader, SqlResultSession } from "./sqlResultSession.js";
import { executeSqlSelection } from "./sqlSelectionExecution.js";

export const NEW_SQL_NOTEBOOK_COMMAND = "postgresql-workbench.newSqlNotebook";
export const CHANGE_SQL_NOTEBOOK_CONNECTION_COMMAND =
  "postgresql-workbench.changeSqlNotebookConnection";
export const RECONNECT_SQL_NOTEBOOK_COMMAND = "postgresql-workbench.reconnectSqlNotebook";
export const USE_SQL_NOTEBOOK_ASSOCIATION_AS_ACTIVE_COMMAND =
  "postgresql-workbench.useSqlNotebookBindingAsActive";
export const SET_SCRATCHPAD_AUTO_MODE_COMMAND = "postgresql-workbench.setScratchpadAutoMode";
export const SET_SCRATCHPAD_MANUAL_MODE_COMMAND = "postgresql-workbench.setScratchpadManualMode";
export const COMMIT_SCRATCHPAD_TRANSACTION_COMMAND =
  "postgresql-workbench.commitScratchpadTransaction";
export const ROLLBACK_SCRATCHPAD_TRANSACTION_COMMAND =
  "postgresql-workbench.rollbackScratchpadTransaction";

type ResultPlanner = (sql: string) => Promise<SqlExecutionPlan>;

export function registerSqlNotebook(
  context: vscode.ExtensionContext,
  connections: ConnectionManager,
  planResult: ResultPlanner,
): ScratchpadFeature {
  const serializer = new SqlNotebookSerializer();
  const transactions = new ScratchpadTransactionManager(connections);
  const controller = new SqlNotebookController(connections, planResult, transactions);
  const statusProvider = new SqlNotebookStatusProvider(connections);
  const fileSystem = new SqlNotebookFileSystemProvider(context.globalStorageUri);
  const workspace = new SqlNotebookWorkspace(fileSystem);

  context.subscriptions.push(
    fileSystem,
    workspace,
    transactions,
    connections.registerBeforeConnectionChange((connectionId, action) =>
      transactions.acquireConnectionChange(connectionId, action),
    ),
    vscode.workspace.registerFileSystemProvider(SQL_NOTEBOOK_SCHEME, fileSystem, {
      isCaseSensitive: true,
    }),
    vscode.workspace.registerNotebookSerializer(SQL_NOTEBOOK_TYPE, serializer, {
      transientOutputs: true,
    }),
    controller,
    statusProvider,
    vscode.notebooks.registerNotebookCellStatusBarItemProvider(SQL_NOTEBOOK_TYPE, statusProvider),
    vscode.commands.registerCommand(NEW_SQL_NOTEBOOK_COMMAND, async (target?: unknown) => {
      const connection = await pickScratchpadAssociationForCreation(connections, target);
      const file = emptySqlNotebook(connection ? associationSnapshot(connection) : {});
      const uri = await workspace.create(new TextEncoder().encode(serializeSqlNotebookFile(file)));
      const notebook = await vscode.workspace.openNotebookDocument(uri);
      controller.prefer(notebook);
      await vscode.window.showNotebookDocument(notebook, { preview: false });
      return uri;
    }),
    vscode.commands.registerCommand(
      OPEN_SQL_NOTEBOOK_COMMAND,
      async (target?: SqlNotebookCommandTarget) => {
        const entry = await selectSqlNotebook(workspace, target, "Open a SQL scratchpad");
        if (!entry) return undefined;
        if (entry.error) {
          await vscode.window.showErrorMessage(
            `Could not open “${displaySqlNotebookName(entry.name)}”: ${entry.error}`,
          );
          return undefined;
        }
        return openSqlNotebook(entry.uri, controller);
      },
    ),
    vscode.commands.registerCommand(
      RENAME_SQL_NOTEBOOK_COMMAND,
      async (target?: SqlNotebookCommandTarget, requestedName?: string) => {
        const entry = await selectSqlNotebook(workspace, target, "Rename a SQL scratchpad");
        if (!entry) return undefined;
        const name =
          requestedName ??
          (await vscode.window.showInputBox({
            title: "Rename SQL Scratchpad",
            prompt: "Scratchpad name",
            value: displaySqlNotebookName(entry.name),
            validateInput: validateSqlNotebookName,
          }));
        if (!name) return undefined;
        const renamed = await transactions.runScratchpadChange(
          entry.uri.toString(),
          "renaming it",
          () => renameSqlNotebook(workspace, controller, entry, name),
        );
        return renamed.accepted ? renamed.value : undefined;
      },
    ),
    vscode.commands.registerCommand(
      DELETE_SQL_NOTEBOOK_COMMAND,
      async (target?: SqlNotebookCommandTarget) => {
        const entry = await selectSqlNotebook(workspace, target, "Delete a SQL scratchpad");
        if (!entry) return false;
        const choice = await vscode.window.showWarningMessage(
          `Delete “${displaySqlNotebookName(entry.name)}”?`,
          { modal: true, detail: "The scratchpad file and its saved SQL cells will be deleted." },
          "Delete Scratchpad",
        );
        if (choice !== "Delete Scratchpad") return false;
        const deleted = await transactions.runScratchpadChange(
          entry.uri.toString(),
          "deleting it",
          () => deleteSqlNotebook(workspace, entry),
        );
        return deleted.accepted && deleted.value === true;
      },
    ),
    vscode.commands.registerCommand(REFRESH_SQL_NOTEBOOKS_COMMAND, () => workspace.refresh()),
    vscode.commands.registerCommand(
      DUPLICATE_SQL_NOTEBOOK_COMMAND,
      async (target?: SqlNotebookCommandTarget) => {
        const entry = await selectSqlNotebook(workspace, target, "Duplicate a SQL scratchpad");
        if (!entry) return undefined;
        const content = await vscode.workspace.fs.readFile(entry.uri);
        const uri = await workspace.create(content);
        return openSqlNotebook(uri, controller);
      },
    ),
    vscode.commands.registerCommand(
      EXPORT_SQL_NOTEBOOK_COMMAND,
      async (target?: SqlNotebookCommandTarget) => {
        const entry = await selectSqlNotebook(workspace, target, "Export a SQL scratchpad");
        if (!entry) return false;
        const destination = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(`${displaySqlNotebookName(entry.name)}.pgsql-notebook`),
          filters: { "PostgreSQL Workbench Scratchpad": ["pgsql-notebook"] },
        });
        if (!destination) return false;
        await vscode.workspace.fs.writeFile(
          destination,
          await vscode.workspace.fs.readFile(entry.uri),
        );
        return true;
      },
    ),
    vscode.commands.registerCommand(
      CHANGE_SQL_NOTEBOOK_CONNECTION_COMMAND,
      async (target?: SqlNotebookEntry | vscode.NotebookDocument | vscode.NotebookCell) => {
        const notebook =
          (await notebookFromTarget(target)) ?? vscode.window.activeNotebookEditor?.notebook;
        if (!notebook || notebook.notebookType !== SQL_NOTEBOOK_TYPE) return false;
        const selected = await pickScratchpadAssociation(connections, "Choose a Connexion");
        if (!selected.accepted) return false;
        const changed = await transactions.runScratchpadChange(
          notebook.uri.toString(),
          "changing its Association",
          async () => {
            await updateNotebookMetadata(notebook, {
              ...(selected.connection ? associationSnapshot(selected.connection) : {}),
              executionMode: scratchpadExecutionMode(notebookMetadata(notebook.metadata)),
            });
            statusProvider.refresh();
          },
        );
        return changed.accepted;
      },
    ),
    vscode.commands.registerCommand(SET_SCRATCHPAD_AUTO_MODE_COMMAND, (target?: unknown) =>
      setScratchpadExecutionMode(target, "auto", transactions, statusProvider),
    ),
    vscode.commands.registerCommand(SET_SCRATCHPAD_MANUAL_MODE_COMMAND, (target?: unknown) =>
      setScratchpadExecutionMode(target, "manual", transactions, statusProvider),
    ),
    vscode.commands.registerCommand(
      COMMIT_SCRATCHPAD_TRANSACTION_COMMAND,
      async (target?: unknown) => {
        const uri = scratchpadTransactionUriFromTarget(target, transactions);
        if (uri && (await transactions.commit(uri))) return true;
        void vscode.window.showWarningMessage(
          "The Scratchpad Transaction changed while the Workbench refreshed. Retry the action.",
        );
        return false;
      },
    ),
    vscode.commands.registerCommand(
      ROLLBACK_SCRATCHPAD_TRANSACTION_COMMAND,
      async (target?: unknown) => {
        const uri = scratchpadTransactionUriFromTarget(target, transactions);
        if (uri && (await transactions.rollback(uri))) return true;
        void vscode.window.showWarningMessage(
          "The Scratchpad Transaction changed while the Workbench refreshed. Retry the action.",
        );
        return false;
      },
    ),
    vscode.commands.registerCommand(
      RECONNECT_SQL_NOTEBOOK_COMMAND,
      async (target?: SqlNotebookEntry | vscode.NotebookDocument | vscode.NotebookCell) => {
        const notebook =
          (await notebookFromTarget(target)) ?? vscode.window.activeNotebookEditor?.notebook;
        if (!notebook || notebook.notebookType !== SQL_NOTEBOOK_TYPE) return false;
        const association = resolveScratchpadAssociation(
          notebookMetadata(notebook.metadata),
          connections.servers,
        );
        if (association.status !== "associated") {
          void vscode.window.showWarningMessage(
            "This Scratchpad Association is unavailable. Choose a saved Connexion.",
          );
          return false;
        }
        try {
          await withDedicatedNotebookClient(
            connections,
            association.connection.id,
            async () => undefined,
          );
          void vscode.window.showInformationMessage(
            `Scratchpad Connexion ${association.snapshot.serverName} is available.`,
          );
          return true;
        } catch (error) {
          const action = await vscode.window.showErrorMessage(
            errorMessage(error),
            "Change Association",
          );
          if (action === "Change Association") {
            void vscode.commands.executeCommand(CHANGE_SQL_NOTEBOOK_CONNECTION_COMMAND, notebook);
          }
          return false;
        }
      },
    ),
    vscode.commands.registerCommand(
      USE_SQL_NOTEBOOK_ASSOCIATION_AS_ACTIVE_COMMAND,
      async (target?: SqlNotebookEntry | vscode.NotebookDocument | vscode.NotebookCell) => {
        const notebook =
          (await notebookFromTarget(target)) ?? vscode.window.activeNotebookEditor?.notebook;
        if (!notebook || notebook.notebookType !== SQL_NOTEBOOK_TYPE) return false;
        const association = resolveScratchpadAssociation(
          notebookMetadata(notebook.metadata),
          connections.servers,
        );
        if (association.status !== "associated") return false;
        return connections.connectServer(association.connection.id);
      },
    ),
  );
  return { workspace, transactions, shutdown: () => transactions.shutdown() };
}

export interface ScratchpadFeature {
  readonly workspace: SqlNotebookWorkspace;
  readonly transactions: ScratchpadTransactionManager;
  shutdown(): Promise<void>;
}

interface SqlNotebookPick extends vscode.QuickPickItem {
  entry: SqlNotebookEntry;
}

type SqlNotebookCommandTarget =
  | SqlNotebookEntry
  | vscode.Uri
  | string
  | { entry: SqlNotebookEntry };

interface SqlNotebookServerPick extends vscode.QuickPickItem {
  connection?: ServerConfig;
}

async function pickScratchpadAssociationForCreation(
  connections: ConnectionManager,
  target: unknown,
): Promise<ServerConfig | undefined> {
  const targetId = notebookServerId(target);
  if (targetId) return connections.store.get(targetId);
  const savedConnections = [...connections.servers];
  const decision = scratchpadCreationAssociation(savedConnections);
  if (decision.kind === "unassociated") return undefined;
  if (decision.kind === "automatic") return decision.connection;
  return (await pickScratchpadAssociation(connections, "Choose a Connexion")).connection;
}

async function pickScratchpadAssociation(
  connections: ConnectionManager,
  placeHolder: string,
): Promise<{ accepted: boolean; connection?: ServerConfig }> {
  const selected = await vscode.window.showQuickPick<SqlNotebookServerPick>(
    [
      {
        label: "$(circle-slash) No connection",
        description: "Create or keep the Scratchpad without an Association",
      },
      ...connections.servers.map((connection) => ({
        label: connection.name,
        description: `${connection.host}:${connection.port} · ${connection.database}`,
        connection,
      })),
    ],
    { placeHolder },
  );
  return selected ? { accepted: true, connection: selected.connection } : { accepted: false };
}

function notebookServerId(target: unknown): string | undefined {
  if (typeof target === "string") return target;
  if (!target || typeof target !== "object") return undefined;
  const candidate = target as { kind?: unknown; server?: { id?: unknown } };
  if (candidate.kind !== "databaseSource") return undefined;
  return typeof candidate.server?.id === "string" ? candidate.server.id : undefined;
}

async function setScratchpadExecutionMode(
  target: unknown,
  mode: ScratchpadExecutionMode,
  transactions: ScratchpadTransactionManager,
  statusProvider: SqlNotebookStatusProvider,
): Promise<boolean> {
  const notebook =
    (await notebookFromTarget(target)) ?? vscode.window.activeNotebookEditor?.notebook;
  if (!notebook || notebook.notebookType !== SQL_NOTEBOOK_TYPE) return false;
  const changed = await transactions.runScratchpadChange(
    notebook.uri.toString(),
    "changing its Mode",
    async () => {
      const current = notebookMetadata(notebook.metadata);
      await updateNotebookMetadata(notebook, { ...current, executionMode: mode });
      statusProvider.refresh();
    },
    () => scratchpadExecutionMode(notebookMetadata(notebook.metadata)) === mode,
  );
  return changed.accepted;
}

function scratchpadUriFromTarget(target: unknown): string | undefined {
  if (typeof target === "string") return target;
  if (!target || typeof target !== "object") return undefined;
  const candidate = target as {
    scratchpadUri?: unknown;
    transaction?: { scratchpadUri?: unknown };
    id?: unknown;
    entry?: { uri?: { toString(): string } };
    notebook?: { entry?: { uri?: { toString(): string } } };
    resourceUri?: { toString(): string };
    uri?: { toString(): string };
  };
  if (typeof candidate.scratchpadUri === "string") return candidate.scratchpadUri;
  if (typeof candidate.transaction?.scratchpadUri === "string") {
    return candidate.transaction.scratchpadUri;
  }
  if (typeof candidate.id === "string" && candidate.id.endsWith(":transaction")) {
    return candidate.id.slice(0, -":transaction".length);
  }
  return (
    candidate.entry?.uri?.toString() ??
    candidate.notebook?.entry?.uri?.toString() ??
    candidate.resourceUri?.toString() ??
    candidate.uri?.toString()
  );
}

function scratchpadTransactionUriFromTarget(
  target: unknown,
  transactions: ScratchpadTransactionManager,
): string | undefined {
  return scratchpadUriFromTarget(target) ?? transactions.soleTransaction()?.scratchpadUri;
}

async function selectSqlNotebook(
  workspace: SqlNotebookWorkspace,
  target: SqlNotebookCommandTarget | undefined,
  placeHolder: string,
): Promise<SqlNotebookEntry | undefined> {
  if (target) {
    const entryTarget = typeof target === "object" && "entry" in target ? target.entry : target;
    return workspace.entry(entryTarget);
  }
  const entries = await workspace.list();
  if (entries.length === 0) {
    await vscode.window.showInformationMessage("No SQL scratchpads found.");
    return undefined;
  }
  const selected = await vscode.window.showQuickPick<SqlNotebookPick>(
    entries.map((entry) => ({
      label: displaySqlNotebookName(entry.name),
      description: scratchpadAssociationLabel(entry.metadata),
      entry,
    })),
    { placeHolder },
  );
  return selected?.entry;
}

async function openSqlNotebook(
  uri: vscode.Uri,
  controller: SqlNotebookController,
): Promise<vscode.Uri> {
  const notebook = await vscode.workspace.openNotebookDocument(uri);
  controller.prefer(notebook);
  await vscode.window.showNotebookDocument(notebook, { preview: false });
  return uri;
}

async function renameSqlNotebook(
  workspace: SqlNotebookWorkspace,
  controller: SqlNotebookController,
  entry: SqlNotebookEntry,
  requestedName: string,
): Promise<vscode.Uri | undefined> {
  const notebook = vscode.workspace.notebookDocuments.find(
    (candidate) => candidate.uri.toString() === entry.uri.toString(),
  );
  if (notebook?.isDirty && !(await notebook.save())) return undefined;
  const tabs = notebookTabs(entry.uri);
  const activeTab = tabs.find(({ tab }) => tab.isActive);
  const targetGroup = activeTab?.group ?? tabs[0]?.group;
  const target = await workspace.rename(entry, requestedName);
  if (notebook) {
    const replacement = await vscode.workspace.openNotebookDocument(target);
    controller.prefer(replacement);
    await vscode.window.showNotebookDocument(replacement, {
      preview: false,
      preserveFocus: !activeTab,
      viewColumn: targetGroup?.viewColumn,
    });
    const previousTabs = notebookTabs(entry.uri).map(({ tab }) => tab);
    if (previousTabs.length > 0) await vscode.window.tabGroups.close(previousTabs, true);
  }
  return target;
}

async function deleteSqlNotebook(
  workspace: SqlNotebookWorkspace,
  entry: SqlNotebookEntry,
): Promise<boolean> {
  const tabs = notebookTabs(entry.uri).map(({ tab }) => tab);
  if (tabs.length > 0 && !(await vscode.window.tabGroups.close(tabs, true))) return false;
  await workspace.delete(entry);
  return true;
}

function notebookTabs(uri: vscode.Uri): Array<{ group: vscode.TabGroup; tab: vscode.Tab }> {
  return vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs
      .filter(
        (tab) =>
          tab.input instanceof vscode.TabInputNotebook &&
          tab.input.uri.toString() === uri.toString(),
      )
      .map((tab) => ({ group, tab })),
  );
}

function displaySqlNotebookName(name: string): string {
  return name.endsWith(".pgsql-notebook") ? name.slice(0, -".pgsql-notebook".length) : name;
}

function validateSqlNotebookName(value: string): string | undefined {
  try {
    normalizeSqlNotebookName(value);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function scratchpadAssociationLabel(metadata: SqlNotebookMetadata): string | undefined {
  if (metadata.serverName && metadata.database) {
    return `${metadata.serverName} · ${metadata.database}`;
  }
  return metadata.serverName ?? metadata.database;
}

export class SqlNotebookSerializer implements vscode.NotebookSerializer {
  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    const file = parseSqlNotebookFile(new TextDecoder().decode(content));
    const data = new vscode.NotebookData(
      file.cells.map(
        (cell) =>
          new vscode.NotebookCellData(
            cell.kind === "markup" ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code,
            cell.source,
            cell.language,
          ),
      ),
    );
    data.metadata = file.metadata;
    return data;
  }

  serializeNotebook(data: vscode.NotebookData): Uint8Array {
    const file: SqlNotebookFile = {
      version: 1,
      metadata: notebookMetadata(data.metadata),
      cells: data.cells.map((cell) =>
        cell.kind === vscode.NotebookCellKind.Markup
          ? { kind: "markup", language: "markdown", source: cell.value }
          : { kind: "code", language: "plpgsql", source: cell.value },
      ),
    };
    return new TextEncoder().encode(serializeSqlNotebookFile(file));
  }
}

class SqlNotebookController implements vscode.Disposable {
  private executionOrder = 0;
  private readonly controller: vscode.NotebookController;
  private readonly resultHost = new SqlNotebookResultHost();
  private readonly subscriptions: vscode.Disposable[];
  private readonly scratchpadAssociations = new Map<string, string>();

  constructor(
    private readonly connections: ConnectionManager,
    private readonly planResult: ResultPlanner,
    private readonly transactions: ScratchpadTransactionManager,
  ) {
    this.controller = vscode.notebooks.createNotebookController(
      "postgresql-workbench.sql",
      SQL_NOTEBOOK_TYPE,
      "PostgreSQL Workbench",
    );
    this.controller.description = "Persistent PostgreSQL Scratchpad";
    this.controller.supportedLanguages = ["plpgsql"];
    this.controller.supportsExecutionOrder = true;
    this.controller.executeHandler = (cells, notebook) => this.execute(cells, notebook);
    this.subscriptions = [
      connections.onChanged(() => {
        for (const notebook of vscode.workspace.notebookDocuments) {
          if (notebook.notebookType === SQL_NOTEBOOK_TYPE) void this.observeAssociation(notebook);
        }
      }),
      vscode.workspace.onDidOpenNotebookDocument((notebook) => {
        if (notebook.notebookType === SQL_NOTEBOOK_TYPE) this.rememberAssociation(notebook);
      }),
      vscode.workspace.onDidCloseNotebookDocument((notebook) => {
        this.scratchpadAssociations.delete(notebook.uri.toString());
        void this.resultHost.closeNotebook(notebook.uri.toString());
      }),
      vscode.workspace.onDidChangeNotebookDocument(({ notebook }) => {
        if (notebook.notebookType !== SQL_NOTEBOOK_TYPE) return;
        void this.observeAssociation(notebook);
      }),
    ];
  }

  prefer(notebook: vscode.NotebookDocument): void {
    this.rememberAssociation(notebook);
    this.controller.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.resultHost.dispose();
    this.controller.dispose();
  }

  private async execute(
    cells: readonly vscode.NotebookCell[],
    notebook: vscode.NotebookDocument,
  ): Promise<void> {
    this.prefer(notebook);
    const association = resolveScratchpadAssociation(
      notebookMetadata(notebook.metadata),
      this.connections.servers,
    );
    if (association.status !== "associated") {
      const message =
        association.status === "unavailable"
          ? `The associated Connexion ${association.snapshot.serverName} is no longer saved. Change this Scratchpad Association.`
          : "This Scratchpad has no Connexion Association. Choose one before running SQL.";
      for (const cell of cells) await this.showError(cell, message);
      const action = await vscode.window.showWarningMessage(message, "Choose Connexion");
      if (action === "Choose Connexion") {
        void vscode.commands.executeCommand(CHANGE_SQL_NOTEBOOK_CONNECTION_COMMAND, notebook);
      }
      return;
    }

    for (const cell of cells) {
      if (cell.kind !== vscode.NotebookCellKind.Code) continue;
      await this.executeCell(
        cell,
        association,
        scratchpadExecutionMode(notebookMetadata(notebook.metadata)),
      );
    }
  }

  private async executeCell(
    cell: vscode.NotebookCell,
    association: Extract<ScratchpadAssociation, { status: "associated" }>,
    mode: ScratchpadExecutionMode,
  ): Promise<void> {
    await this.resultHost.closeCell(cell.document.uri.toString());
    const execution = this.controller.createNotebookCellExecution(cell);
    execution.executionOrder = ++this.executionOrder;
    execution.start(Date.now());
    const sql = cell.document.getText();
    if (!sql.trim()) {
      await execution.clearOutput();
      execution.end(true, Date.now());
      return;
    }

    const plan = await this.planResult(sql);
    if (plan.status === "empty") {
      await execution.clearOutput();
      execution.end(true, Date.now());
      return;
    }
    if (plan.status !== "ready") {
      await execution.replaceOutput(errorOutput(planErrorPayload(plan)));
      execution.end(false, Date.now());
      return;
    }
    if (mode === "manual" && plan.statements.some((statement) => statement.transactionControl)) {
      await execution.replaceOutput(
        errorOutput(
          notebookErrorPayload(
            "execution",
            "Scratchpad Transaction control",
            "Mode MANUAL does not execute transaction-control Statements (for example BEGIN, COMMIT, ROLLBACK, SAVEPOINT, or SET TRANSACTION). Use the Scratchpad Transaction controls.",
          ),
        ),
      );
      execution.end(false, Date.now());
      return;
    }

    const settings = sqlResultSettings();
    const [singleStatement] = plan.statements;
    if (
      mode === "auto" &&
      plan.statements.length === 1 &&
      singleStatement?.resultKind === "paged-query"
    ) {
      try {
        const payload = await this.executePagedCell(
          cell,
          singleStatement.sql,
          settings,
          association.snapshot,
        );
        await execution.replaceOutput(resultOutput(payload));
        execution.end(true, Date.now());
      } catch (error) {
        await execution.replaceOutput(errorOutput(executionErrorPayload(error)));
        execution.end(false, Date.now());
        if (error instanceof DedicatedNotebookConnectionError) {
          await this.offerConnectionRecovery(cell.notebook, error);
        }
      }
      return;
    }

    try {
      const outcome = await this.executeStatementPlan(
        cell,
        plan.statements,
        settings,
        association,
        mode,
      );
      await execution.replaceOutput(outcome.outputs);
      execution.end(outcome.success, Date.now());
    } catch (error) {
      await execution.replaceOutput(errorOutput(executionErrorPayload(error)));
      execution.end(false, Date.now());
      if (error instanceof DedicatedNotebookConnectionError) {
        await this.offerConnectionRecovery(cell.notebook, error);
      }
    }
  }

  private executeStatementPlan(
    cell: vscode.NotebookCell,
    statements: readonly SqlExecutionStatement[],
    settings: SqlResultSettings,
    association: Extract<ScratchpadAssociation, { status: "associated" }>,
    mode: ScratchpadExecutionMode,
  ): Promise<{ outputs: vscode.NotebookCellOutput[]; success: boolean }> {
    const execute = async (client: import("pg").Client) => {
      const outputs: vscode.NotebookCellOutput[] = [];
      for (const [index, statement] of statements.entries()) {
        try {
          const result = await executeSqlSelection(
            client,
            {
              status: "ready",
              sql: statement.sql,
              source: {
                name: cell.notebook.uri.path.split("/").at(-1) ?? "Scratchpad",
                uri: cell.notebook.uri.toString(),
                line: statement.line,
              },
            },
            {
              add: (_entry: DebugResult) => {},
              addStatus: (_entry: DebugResultStatus) => {},
            },
            {
              maxRows: settings.nonPagedMaxRows,
              classifyStatementCount: async () => "single-statement",
            },
          );

          if ("status" in result) {
            if (mode === "manual") {
              this.transactions.record(cell.notebook.uri.toString(), statement.sql, false);
            }
            const error =
              result.status === "error"
                ? debugResultErrorPayload(result, statements.length > 1 ? index + 1 : undefined)
                : executionErrorPayload(
                    new Error("The SQL execution plan became invalid before execution."),
                    statements.length > 1 ? index + 1 : undefined,
                  );
            outputs.push(errorOutput(error));
            return { outputs, success: false };
          }
          if (mode === "manual") {
            this.transactions.record(cell.notebook.uri.toString(), statement.sql, true);
          }
          if (result.columns.length > 0) {
            outputs.push(resultOutput(sqlNotebookResultPayload(result, association.snapshot)));
          }
        } catch (error) {
          if (mode === "manual") {
            this.transactions.record(cell.notebook.uri.toString(), statement.sql, false);
          }
          throw error;
        }
      }
      return { outputs, success: true };
    };

    if (mode === "manual") {
      return this.transactions.execute(
        cell.notebook.uri.toString(),
        displaySqlNotebookName(cell.notebook.uri.path.split("/").at(-1) ?? "Scratchpad"),
        association.snapshot,
        execute,
      );
    }
    return withDedicatedNotebookClient(this.connections, association.connection.id, execute);
  }

  private async executePagedCell(
    cell: vscode.NotebookCell,
    sql: string,
    settings: SqlResultSettings,
    association: ScratchpadAssociationSnapshot,
  ): Promise<SqlNotebookResultPayload> {
    const client = await createDedicatedNotebookClient(this.connections, association.serverId);
    let reader: PostgresCursorReader | undefined;
    try {
      const resultIdleTimeoutMs = settings.cursorIdleTimeoutSeconds * 1_000;
      await client.query("SELECT set_config('idle_in_transaction_session_timeout', $1, false)", [
        `${postgresCursorSafetyTimeoutMs(resultIdleTimeoutMs)}ms`,
      ]);
      reader = new PostgresCursorReader(client, sql);
      const session = await SqlResultSession.open(reader, {
        pageSize: settings.pageSize,
        maxCachedRows: settings.maxCachedRows,
        binding: association,
      });
      return this.resultHost.register(session, cell, resultIdleTimeoutMs, association, () =>
        this.isAssociationCurrent(cell.notebook, association),
      );
    } catch (error) {
      if (reader) await reader.close().catch(() => {});
      else await client.end().catch(() => {});
      throw error;
    }
  }

  private async showError(cell: vscode.NotebookCell, message: string): Promise<void> {
    const execution = this.controller.createNotebookCellExecution(cell);
    execution.start(Date.now());
    await execution.replaceOutput(
      errorOutput(
        notebookErrorPayload("connection", "Scratchpad Association unavailable", message),
      ),
    );
    execution.end(false, Date.now());
  }

  private async offerConnectionRecovery(
    notebook: vscode.NotebookDocument,
    error: DedicatedNotebookConnectionError,
  ): Promise<void> {
    const action = await vscode.window.showWarningMessage(
      error.message,
      "Reconnect",
      "Change Association",
    );
    if (action === "Reconnect") {
      void vscode.commands.executeCommand(RECONNECT_SQL_NOTEBOOK_COMMAND, notebook);
    } else if (action === "Change Association") {
      void vscode.commands.executeCommand(CHANGE_SQL_NOTEBOOK_CONNECTION_COMMAND, notebook);
    }
  }

  private isAssociationCurrent(
    notebook: vscode.NotebookDocument,
    expected: ScratchpadAssociationSnapshot,
  ): boolean {
    const association = resolveScratchpadAssociation(
      notebookMetadata(notebook.metadata),
      this.connections.servers,
    );
    return (
      association.status === "associated" &&
      associationFingerprint(association.snapshot) === associationFingerprint(expected)
    );
  }

  private rememberAssociation(notebook: vscode.NotebookDocument): void {
    this.scratchpadAssociations.set(notebook.uri.toString(), this.associationStateKey(notebook));
  }

  private async observeAssociation(notebook: vscode.NotebookDocument): Promise<void> {
    const uri = notebook.uri.toString();
    const next = this.associationStateKey(notebook);
    const previous = this.scratchpadAssociations.get(uri);
    this.scratchpadAssociations.set(uri, next);
    if (previous === undefined || previous === next) return;

    const association = resolveScratchpadAssociation(
      notebookMetadata(notebook.metadata),
      this.connections.servers,
    );
    await this.resultHost.closeNotebookAssociationMismatch(
      uri,
      association.status === "associated" ? association.snapshot : undefined,
    );
  }

  private associationStateKey(notebook: vscode.NotebookDocument): string {
    const association = resolveScratchpadAssociation(
      notebookMetadata(notebook.metadata),
      this.connections.servers,
    );
    return association.status === "unassociated"
      ? "unassociated"
      : `${association.status}:${associationFingerprint(association.snapshot)}`;
  }
}

class SqlNotebookStatusProvider
  implements vscode.NotebookCellStatusBarItemProvider, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCellStatusBarItems = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly connections: ConnectionManager) {
    this.subscription = connections.onChanged(() => this.changed.fire());
  }

  provideCellStatusBarItems(
    cell: vscode.NotebookCell,
  ): vscode.NotebookCellStatusBarItem | undefined {
    if (cell.kind === vscode.NotebookCellKind.Markup) return undefined;
    const association = resolveScratchpadAssociation(
      notebookMetadata(cell.notebook.metadata),
      this.connections.servers,
    );
    const label =
      association.status === "unassociated"
        ? "Choose a Connexion"
        : `${association.snapshot.serverName} · ${association.snapshot.database}`;
    const item = new vscode.NotebookCellStatusBarItem(
      `${association.status === "associated" ? "$(database)" : "$(warning)"} ${label}`,
      vscode.NotebookCellStatusBarAlignment.Right,
    );
    item.command = {
      title: "Change Scratchpad Connexion",
      command: CHANGE_SQL_NOTEBOOK_CONNECTION_COMMAND,
      arguments: [cell.notebook],
    };
    item.tooltip =
      association.status === "associated"
        ? "Scratchpad Association — click to change its Connexion"
        : "Scratchpad Association unavailable — click to change its Connexion";
    item.priority = 100;
    return item;
  }

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}

function notebookMetadata(value: unknown): SqlNotebookMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const metadata: SqlNotebookMetadata = {};
  for (const key of ["serverId", "serverName", "database"] as const) {
    if (typeof source[key] === "string" && source[key]) metadata[key] = source[key];
  }
  if (source.executionMode === "manual") metadata.executionMode = "manual";
  return metadata;
}

async function updateNotebookMetadata(
  notebook: vscode.NotebookDocument,
  metadata: SqlNotebookMetadata,
): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, [vscode.NotebookEdit.updateNotebookMetadata(metadata)]);
  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error("Could not update the Scratchpad Association metadata.");
  }
  await notebook.save();
}

async function notebookFromTarget(target: unknown): Promise<vscode.NotebookDocument | undefined> {
  if (!target || typeof target !== "object") return undefined;
  if ("notebookType" in target) return target as vscode.NotebookDocument;
  if ("notebook" in target) {
    const notebook = (target as { notebook?: unknown }).notebook;
    if (notebook && typeof notebook === "object" && "notebookType" in notebook) {
      return notebook as vscode.NotebookDocument;
    }
    if (notebook && typeof notebook === "object" && "entry" in notebook) {
      const entry = (notebook as { entry: SqlNotebookEntry }).entry;
      return vscode.workspace.openNotebookDocument(entry.uri);
    }
  }
  if ("scratchpad" in target) {
    const scratchpad = (target as { scratchpad?: { entry?: SqlNotebookEntry } }).scratchpad;
    if (scratchpad?.entry) return vscode.workspace.openNotebookDocument(scratchpad.entry.uri);
  }
  if ("entry" in target) {
    const entry = (target as { entry: SqlNotebookEntry }).entry;
    return vscode.workspace.openNotebookDocument(entry.uri);
  }
  if ("uri" in target) {
    return vscode.workspace.openNotebookDocument((target as SqlNotebookEntry).uri);
  }
  return undefined;
}

function errorOutput(payload: SqlNotebookErrorPayload): vscode.NotebookCellOutput {
  return new vscode.NotebookCellOutput([
    vscode.NotebookCellOutputItem.json(payload, SQL_NOTEBOOK_RESULT_MIME),
    vscode.NotebookCellOutputItem.text(errorSummary(payload)),
  ]);
}

function resultOutput(payload: SqlNotebookResultPayload): vscode.NotebookCellOutput {
  return new vscode.NotebookCellOutput([
    vscode.NotebookCellOutputItem.json(payload, SQL_NOTEBOOK_RESULT_MIME),
    vscode.NotebookCellOutputItem.text(resultSummary(payload)),
  ]);
}

function resultSummary(result: SqlNotebookResultPayload): string {
  const navigation = result.navigation;
  const rows = navigation
    ? navigation.pageEnd === 0
      ? "0 rows"
      : `rows ${navigation.pageStart}-${navigation.pageEnd}${navigation.hasNext ? " · more available" : ""}`
    : `${result.rowCount ?? result.capturedRowCount} row${result.rowCount === 1 ? "" : "s"}`;
  const truncation = result.truncated ? " · preview truncated" : "";
  return `${result.command} · ${rows} · ${result.durationMs} ms${truncation}`;
}

function errorSummary(error: SqlNotebookErrorPayload): string {
  const statement = error.statement ? ` · statement ${error.statement}` : "";
  const code = error.code ? ` · ${error.code}` : "";
  return `${error.title}${statement}${code}: ${error.message}`;
}

function planErrorPayload(
  plan: Exclude<SqlExecutionPlan, { status: "ready" } | { status: "empty" }>,
): SqlNotebookErrorPayload {
  if (plan.status === "syntax-error") {
    const location =
      plan.line !== undefined
        ? ` at line ${plan.line}${plan.column !== undefined ? `, column ${plan.column}` : ""}`
        : "";
    return {
      version: 1,
      type: "error",
      category: "syntax",
      title: "SQL syntax error",
      message: `The SQL parser found invalid syntax${location}.`,
      ...(plan.line !== undefined ? { line: plan.line } : {}),
      ...(plan.column !== undefined ? { column: plan.column } : {}),
    };
  }
  if (plan.reason === "budget-exhausted") {
    const budget = plan.budget;
    const usage = [
      budget ? `configured depth ${budget.maxDepth}` : undefined,
      budget ? `${budget.maxNodes.toLocaleString("en-US")} nodes` : undefined,
      plan.totalNodes !== undefined
        ? `${plan.totalNodes.toLocaleString("en-US")} nodes observed`
        : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      version: 1,
      type: "error",
      category: "execution",
      title: "SQL analysis budget reached",
      message: `The cell was not executed because PostgreSQL Workbench could not classify the complete SQL syntax tree${usage ? ` (${usage})` : ""}. Increase the SQL analysis budget and run the cell again.`,
      action: {
        type: "open-sql-analysis-settings",
        label: "Open SQL analysis settings",
      },
    };
  }
  return notebookErrorPayload(
    "execution",
    "SQL analysis failed",
    `The SQL parser could not analyze this cell: ${plan.message}`,
  );
}

function debugResultErrorPayload(
  error: DebugResultError,
  statement?: number,
): SqlNotebookErrorPayload {
  const isPostgres = Boolean(error.code && /^[0-9A-Z]{5}$/u.test(error.code));
  return {
    version: 1,
    type: "error",
    category: isPostgres ? "postgresql" : "execution",
    title: isPostgres ? "PostgreSQL error" : "SQL execution error",
    message: error.message,
    ...(statement ? { statement } : {}),
    ...(error.code ? { code: error.code } : {}),
    ...(error.detail ? { detail: error.detail } : {}),
    ...(error.hint ? { hint: error.hint } : {}),
    ...(error.position ? { position: error.position } : {}),
  };
}

function executionErrorPayload(error: unknown, statement?: number): SqlNotebookErrorPayload {
  if (error instanceof DedicatedNotebookConnectionError) {
    return {
      ...notebookErrorPayload("connection", "PostgreSQL Connexion error", error.message),
      ...(statement ? { statement } : {}),
    };
  }
  const source = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const code = stringErrorField(source, "code");
  const isPostgres = Boolean(code && /^[0-9A-Z]{5}$/u.test(code));
  return {
    version: 1,
    type: "error",
    category: isPostgres ? "postgresql" : "execution",
    title: isPostgres ? "PostgreSQL error" : "SQL execution error",
    message: errorMessage(error),
    ...(statement ? { statement } : {}),
    ...(code ? { code } : {}),
    ...optionalErrorField(source, "detail"),
    ...optionalErrorField(source, "hint"),
    ...optionalErrorField(source, "position"),
  };
}

function notebookErrorPayload(
  category: SqlNotebookErrorPayload["category"],
  title: string,
  message: string,
): SqlNotebookErrorPayload {
  return { version: 1, type: "error", category, title, message };
}

function optionalErrorField<K extends "detail" | "hint" | "position">(
  source: Record<string, unknown>,
  key: K,
): Partial<Pick<SqlNotebookErrorPayload, K>> {
  const value = stringErrorField(source, key);
  return value ? ({ [key]: value } as Pick<SqlNotebookErrorPayload, K>) : {};
}

function stringErrorField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

interface SqlResultSettings {
  pageSize: number;
  maxCachedRows: number;
  cursorIdleTimeoutSeconds: number;
  nonPagedMaxRows: number;
}

function sqlResultSettings(): SqlResultSettings {
  const configuration = vscode.workspace.getConfiguration("postgresql-workbench.results");
  const pageSizeInspection = configuration.inspect<number>("pageSize");
  const pageSizeExplicit =
    pageSizeInspection?.workspaceFolderValue ??
    pageSizeInspection?.workspaceValue ??
    pageSizeInspection?.globalValue;
  const legacyRows = configuration.get<number>("maxRows", DEBUG_RESULT_LIMITS.DEFAULT_ROWS);
  const pageSize = clampDebugResultRows(
    pageSizeExplicit ?? configuration.get<number>("pageSize", legacyRows),
  );
  return {
    pageSize,
    maxCachedRows: Math.max(
      pageSize,
      Math.min(100_000, Math.trunc(configuration.get<number>("maxCachedRows", 1_000))),
    ),
    cursorIdleTimeoutSeconds: Math.max(
      30,
      Math.min(3_600, Math.trunc(configuration.get<number>("cursorIdleTimeoutSeconds", 300))),
    ),
    nonPagedMaxRows: clampDebugResultRows(
      configuration.get<number>("nonPagedMaxRows", DEBUG_RESULT_LIMITS.DEFAULT_ROWS),
    ),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
