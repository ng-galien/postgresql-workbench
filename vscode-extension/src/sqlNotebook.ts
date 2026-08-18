import { TextDecoder, TextEncoder } from "node:util";
import * as vscode from "vscode";
import type { SqlExecutionPlan, SqlExecutionStatement } from "../../src/analysis/sqlStatements.js";
import {
  clampDebugResultRows,
  DEBUG_RESULT_LIMITS,
  type DebugResult,
  type DebugResultEntry,
  type DebugResultError,
  type DebugResultStatus,
} from "../../src/debugger/launch/index.js";
import type { ConnectionManager } from "./connectionManager.js";
import { ScratchpadTransactionManager } from "./scratchpadTransactions.js";
import { getConnectionName, type ServerConfig } from "./serverStore.js";
import {
  configureNotebookStatementTimeout,
  createDedicatedNotebookClient,
  DedicatedNotebookConnectionError,
  NotebookClientCancellation,
  NotebookExecutionCancelledError,
  withDedicatedNotebookClient,
} from "./sqlNotebookConnection.js";
import { SQL_NOTEBOOK_SCHEME, SqlNotebookFileSystemProvider } from "./sqlNotebookFileSystem.js";
import {
  associationFingerprint,
  associationSnapshot,
  DEFAULT_SCRATCHPAD_STATEMENT_TIMEOUT_MS,
  emptySqlNotebook,
  MAX_SCRATCHPAD_STATEMENT_TIMEOUT_MS,
  MIN_SCRATCHPAD_STATEMENT_TIMEOUT_MS,
  normalizeSqlNotebookName,
  parseSqlNotebookFile,
  resolveScratchpadAssociation,
  type ScratchpadAssociation,
  type ScratchpadAssociationSnapshot,
  type ScratchpadCellExecutionIntent,
  type ScratchpadExecutionMode,
  SQL_NOTEBOOK_RESULT_MIME,
  SQL_NOTEBOOK_TYPE,
  type SqlNotebookErrorPayload,
  type SqlNotebookFile,
  type SqlNotebookMetadata,
  type SqlNotebookResultPayload,
  scratchpadCellExecutionIntent,
  scratchpadCreationAssociation,
  scratchpadExecutionMode,
  scratchpadStatementTimeoutMs,
  serializeSqlNotebookFile,
  sqlNotebookResultPayload,
  validStatementTimeoutMs,
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
export const CONNECT_SQL_NOTEBOOK_ASSOCIATION_COMMAND =
  "postgresql-workbench.connectSqlNotebookAssociation";
export const SET_SCRATCHPAD_AUTO_MODE_COMMAND = "postgresql-workbench.setScratchpadAutoMode";
export const SET_SCRATCHPAD_MANUAL_MODE_COMMAND = "postgresql-workbench.setScratchpadManualMode";
export const SET_SCRATCHPAD_STATEMENT_TIMEOUT_COMMAND =
  "postgresql-workbench.setScratchpadStatementTimeout";
export const SET_SCRATCHPAD_CELL_EXECUTION_INTENT_COMMAND =
  "postgresql-workbench.setScratchpadCellExecutionIntent";
export const COMMIT_SCRATCHPAD_TRANSACTION_COMMAND =
  "postgresql-workbench.commitScratchpadTransaction";
export const ROLLBACK_SCRATCHPAD_TRANSACTION_COMMAND =
  "postgresql-workbench.rollbackScratchpadTransaction";

type ResultPlanner = (sql: string) => Promise<SqlExecutionPlan>;

export interface ScratchpadDebugRequest {
  sql: string;
  association: ScratchpadAssociationSnapshot;
  source: { name: string; uri: string; line: number };
}

export type ScratchpadDebugOutcome =
  | {
      started: true;
      /** Resolves with the captured SQL result when the debug session ends. */
      completion: Promise<DebugResultEntry | undefined>;
      stop: () => Promise<void>;
    }
  | { started: false; cancelled?: boolean; message?: string };

export type ScratchpadDebugger = (
  request: ScratchpadDebugRequest,
) => Promise<ScratchpadDebugOutcome>;

const DEBUGGABLE_ANALYSIS_DELAY_MS = 500;

/** Tells whether a cell's SQL currently offers one replayable PL/pgSQL entry point. */
export type ScratchpadDebugEligibility = (request: {
  sql: string;
  association: ScratchpadAssociationSnapshot;
}) => Promise<boolean>;

type ScratchpadSchemaMutation = (association: ScratchpadAssociationSnapshot) => void;

export function registerSqlNotebook(
  context: vscode.ExtensionContext,
  connections: ConnectionManager,
  planResult: ResultPlanner,
  debug: ScratchpadDebugger,
  canDebug: ScratchpadDebugEligibility = async () => false,
  openDataView: (request: ScratchpadDataViewRequest) => Promise<void> = async () => {},
  onSchemaMutation: ScratchpadSchemaMutation = () => {},
): ScratchpadFeature {
  const serializer = new SqlNotebookSerializer();
  const transactions = new ScratchpadTransactionManager(connections);
  const controller = new SqlNotebookController(
    connections,
    planResult,
    transactions,
    debug,
    canDebug,
    openDataView,
    onSchemaMutation,
  );
  const statusProvider = new SqlNotebookStatusProvider(connections, canDebug);
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
    vscode.commands.registerCommand(
      SET_SCRATCHPAD_CELL_EXECUTION_INTENT_COMMAND,
      async (cell: vscode.NotebookCell, requested?: ScratchpadCellExecutionIntent) => {
        if (!cell || cell.notebook.notebookType !== SQL_NOTEBOOK_TYPE) return false;
        const current = scratchpadCellExecutionIntent(cell.metadata);
        if (!statusProvider.isDebuggable(cell)) {
          void vscode.window.showInformationMessage(
            "This cell has no replayable PL/pgSQL entry point, so it always runs. Debug needs one indexed CALL or function SELECT.",
          );
          return false;
        }
        if (scratchpadExecutionMode(notebookMetadata(cell.notebook.metadata)) === "manual") {
          void vscode.window.showInformationMessage(
            "Debug is unavailable in Mode MANUAL: the debugger cannot join the Scratchpad Transaction. Change to Mode AUTO first.",
          );
          return false;
        }
        const executionIntent = requested ?? (await pickScratchpadCellExecutionIntent(current));
        if (!executionIntent) return false;
        if (executionIntent === current) return true;
        const edit = new vscode.WorkspaceEdit();
        edit.set(cell.notebook.uri, [
          vscode.NotebookEdit.updateCellMetadata(cell.index, {
            ...(cell.metadata && typeof cell.metadata === "object" ? cell.metadata : {}),
            executionIntent,
          }),
        ]);
        if (!(await vscode.workspace.applyEdit(edit))) return false;
        await cell.notebook.save();
        statusProvider.refresh();
        return true;
      },
    ),
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
              ...scratchpadTimeoutOverride(notebookMetadata(notebook.metadata)),
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
    vscode.commands.registerCommand(SET_SCRATCHPAD_STATEMENT_TIMEOUT_COMMAND, (target?: unknown) =>
      setScratchpadStatementTimeout(target, transactions, statusProvider),
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
      CONNECT_SQL_NOTEBOOK_ASSOCIATION_COMMAND,
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
  return {
    workspace,
    transactions,
    shutdown: () => transactions.shutdown(),
    refreshCellStatus: () => statusProvider.invalidateDebuggable(),
    async openWithSql(sql, association) {
      const file = emptySqlNotebook(association ? associationSnapshot(association) : {});
      file.cells = [{ kind: "code", language: "plpgsql", source: sql }];
      const uri = await workspace.create(new TextEncoder().encode(serializeSqlNotebookFile(file)));
      const notebook = await vscode.workspace.openNotebookDocument(uri);
      controller.prefer(notebook);
      await vscode.window.showNotebookDocument(notebook, { preview: false });
      return uri;
    },
  };
}

export interface ScratchpadFeature {
  readonly workspace: SqlNotebookWorkspace;
  readonly transactions: ScratchpadTransactionManager;
  shutdown(): Promise<void>;
  /** Re-evaluates cell status items (Debug eligibility) after the Workbench Index changed. */
  refreshCellStatus(): void;
  /** Creates and shows a Scratchpad holding one SQL cell, associated with the given Connexion. */
  openWithSql(sql: string, association: ServerConfig | undefined): Promise<vscode.Uri>;
}

/** A result renderer asked to open its Statement in a Data View. */
export interface ScratchpadDataViewRequest {
  sql: string;
  association: ScratchpadAssociationSnapshot;
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
        label: `${connections.isServerConnected(connection.id) ? "$(pass-filled)" : "$(circle-outline)"} ${getConnectionName(connection)}`,
        description: connections.isServerConnected(connection.id) ? "Connected" : "Disconnected",
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

interface ScratchpadTimeoutPick extends vscode.QuickPickItem {
  action: "global" | "timeout" | "custom" | "settings";
  timeoutMs?: number;
}

async function setScratchpadStatementTimeout(
  target: unknown,
  transactions: ScratchpadTransactionManager,
  statusProvider: SqlNotebookStatusProvider,
): Promise<boolean> {
  const notebook =
    (await notebookFromTarget(target)) ?? vscode.window.activeNotebookEditor?.notebook;
  if (!notebook || notebook.notebookType !== SQL_NOTEBOOK_TYPE) return false;
  const metadata = notebookMetadata(notebook.metadata);
  const globalTimeoutMs = configuredScratchpadStatementTimeoutMs();
  const effectiveTimeoutMs = scratchpadStatementTimeoutMs(metadata, globalTimeoutMs);
  const selected = await vscode.window.showQuickPick<ScratchpadTimeoutPick>(
    [
      {
        label: "$(globe) Use global setting",
        description: formatStatementTimeout(globalTimeoutMs),
        action: "global",
      },
      ...[60_000, 120_000, 300_000, 900_000, 1_800_000].map((timeoutMs) => ({
        label: formatStatementTimeout(timeoutMs),
        description:
          metadata.statementTimeoutMs === timeoutMs ? "Current Scratchpad override" : undefined,
        action: "timeout" as const,
        timeoutMs,
      })),
      {
        label: "$(edit) Custom…",
        description: `Current effective timeout: ${formatStatementTimeout(effectiveTimeoutMs)}`,
        action: "custom",
      },
      {
        label: "$(settings-gear) Open global timeout setting",
        action: "settings",
      },
    ],
    {
      title: "Scratchpad Statement timeout",
      placeHolder: "Choose the maximum duration of one PostgreSQL Statement",
    },
  );
  if (!selected) return false;
  if (selected.action === "settings") {
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "postgresql-workbench.sql.statementTimeoutMs",
    );
    return true;
  }
  let timeoutMs = selected.timeoutMs;
  if (selected.action === "custom") {
    const value = await vscode.window.showInputBox({
      title: "Scratchpad Statement timeout",
      prompt: "Maximum duration in seconds (1 to 3600)",
      value: String(Math.round(effectiveTimeoutMs / 1_000)),
      validateInput(input) {
        const seconds = Number(input);
        return Number.isInteger(seconds) &&
          seconds >= MIN_SCRATCHPAD_STATEMENT_TIMEOUT_MS / 1_000 &&
          seconds <= MAX_SCRATCHPAD_STATEMENT_TIMEOUT_MS / 1_000
          ? undefined
          : "Enter a whole number from 1 to 3600.";
      },
    });
    if (value === undefined) return false;
    timeoutMs = Number(value) * 1_000;
  }
  const changed = await transactions.runScratchpadChange(
    notebook.uri.toString(),
    "changing its Statement timeout",
    async () => {
      const current = notebookMetadata(notebook.metadata);
      const { statementTimeoutMs: _previous, ...withoutTimeout } = current;
      await updateNotebookMetadata(notebook, {
        ...withoutTimeout,
        ...(selected.action === "global" ? {} : { statementTimeoutMs: timeoutMs }),
      });
      statusProvider.refresh();
    },
    () =>
      selected.action === "global"
        ? metadata.statementTimeoutMs === undefined
        : metadata.statementTimeoutMs === timeoutMs,
  );
  return changed.accepted;
}

function scratchpadTimeoutOverride(
  metadata: SqlNotebookMetadata,
): Pick<SqlNotebookMetadata, "statementTimeoutMs"> {
  return metadata.statementTimeoutMs === undefined
    ? {}
    : { statementTimeoutMs: metadata.statementTimeoutMs };
}

function configuredScratchpadStatementTimeoutMs(): number {
  const value = vscode.workspace
    .getConfiguration("postgresql-workbench.sql")
    .get<number>("statementTimeoutMs", DEFAULT_SCRATCHPAD_STATEMENT_TIMEOUT_MS);
  return validStatementTimeoutMs(value) ?? DEFAULT_SCRATCHPAD_STATEMENT_TIMEOUT_MS;
}

function formatStatementTimeout(timeoutMs: number): string {
  const seconds = timeoutMs / 1_000;
  if (seconds < 60) return `${seconds} s`;
  const minutes = seconds / 60;
  return `${minutes} min`;
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
  return metadata.serverName ?? metadata.database;
}

export class SqlNotebookSerializer implements vscode.NotebookSerializer {
  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    const file = parseSqlNotebookFile(new TextDecoder().decode(content));
    const data = new vscode.NotebookData(
      file.cells.map((cell) => {
        const data = new vscode.NotebookCellData(
          cell.kind === "markup" ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code,
          cell.source,
          cell.language,
        );
        data.metadata = cell.metadata;
        return data;
      }),
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
          : {
              kind: "code",
              language: "plpgsql",
              source: cell.value,
              ...(scratchpadCellExecutionIntent(cell.metadata) === "debug"
                ? { metadata: { executionIntent: "debug" as const } }
                : {}),
            },
      ),
    };
    return new TextEncoder().encode(serializeSqlNotebookFile(file));
  }
}

class SqlNotebookController implements vscode.Disposable {
  private executionOrder = 0;
  private readonly controller: vscode.NotebookController;
  private readonly resultHost: SqlNotebookResultHost;
  private readonly subscriptions: vscode.Disposable[];
  private readonly scratchpadAssociations = new Map<string, string>();

  constructor(
    private readonly connections: ConnectionManager,
    private readonly planResult: ResultPlanner,
    private readonly transactions: ScratchpadTransactionManager,
    private readonly debug: ScratchpadDebugger,
    private readonly canDebug: ScratchpadDebugEligibility,
    openDataView: (request: ScratchpadDataViewRequest) => Promise<void>,
    private readonly onSchemaMutation: ScratchpadSchemaMutation,
  ) {
    this.resultHost = new SqlNotebookResultHost(openDataView);
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

    let batchCancelled = false;
    for (const cell of cells) {
      if (cell.kind !== vscode.NotebookCellKind.Code) continue;
      await this.executeCell(
        cell,
        association,
        scratchpadExecutionMode(notebookMetadata(notebook.metadata)),
        () => {
          batchCancelled = true;
        },
      );
      if (batchCancelled) break;
    }
  }

  private async executeCell(
    cell: vscode.NotebookCell,
    association: Extract<ScratchpadAssociation, { status: "associated" }>,
    mode: ScratchpadExecutionMode,
    onCancelled: () => void,
  ): Promise<void> {
    await this.resultHost.closeCell(cell.document.uri.toString());
    const execution = this.controller.createNotebookCellExecution(cell);
    execution.executionOrder = ++this.executionOrder;
    execution.start(Date.now());
    const cancellation = new NotebookClientCancellation();
    const cancellationSubscription = execution.token.onCancellationRequested(() => {
      onCancelled();
      cancellation.request();
    });
    if (execution.token.isCancellationRequested) {
      onCancelled();
      cancellation.request();
    }
    try {
      await this.runCellExecution(cell, association, mode, execution, cancellation);
    } catch (error) {
      if (
        cancellation.isCancellationRequested ||
        error instanceof NotebookExecutionCancelledError
      ) {
        await execution.replaceOutput(errorOutput(executionCancelledPayload()));
        execution.end(false, Date.now());
        return;
      }
      throw error;
    } finally {
      cancellationSubscription.dispose();
      await cancellation.settle();
    }
  }

  private async runCellExecution(
    cell: vscode.NotebookCell,
    association: Extract<ScratchpadAssociation, { status: "associated" }>,
    mode: ScratchpadExecutionMode,
    execution: vscode.NotebookCellExecution,
    cancellation: NotebookClientCancellation,
  ): Promise<void> {
    const sql = cell.document.getText();
    cancellation.throwIfCancellationRequested();
    if (!sql.trim()) {
      await execution.clearOutput();
      execution.end(true, Date.now());
      return;
    }

    const wantsDebug =
      scratchpadCellExecutionIntent(cell.metadata) === "debug" &&
      (await this.canDebug({ sql, association: association.snapshot }));
    cancellation.throwIfCancellationRequested();
    if (wantsDebug) {
      if (mode === "manual") {
        await execution.replaceOutput(
          errorOutput(
            notebookErrorPayload(
              "execution",
              "Debug unavailable in Mode MANUAL",
              "The debugger owns separate PostgreSQL sessions and cannot join the Scratchpad Transaction. Change to Mode AUTO, Commit, or Rollback first.",
            ),
          ),
        );
        execution.end(false, Date.now());
        return;
      }
      const debugPlan = await this.planResult(sql);
      cancellation.throwIfCancellationRequested();
      if (debugPlan.status !== "ready" && debugPlan.status !== "empty") {
        await execution.replaceOutput(errorOutput(planErrorPayload(debugPlan)));
        execution.end(false, Date.now());
        return;
      }
      const debug = await this.debug({
        sql,
        association: association.snapshot,
        source: {
          name: displaySqlNotebookName(cell.notebook.uri.path.split("/").at(-1) ?? "Scratchpad"),
          uri: cell.notebook.uri.toString(),
          line: 1,
        },
      });
      if (!debug.started) {
        if (debug.cancelled) {
          execution.end(undefined, Date.now());
          return;
        }
        await execution.replaceOutput(
          errorOutput(
            notebookErrorPayload(
              "execution",
              "PL/pgSQL Debug unavailable",
              debug.message ?? "This cell does not contain a reproducible PL/pgSQL entry point.",
            ),
          ),
        );
        execution.end(false, Date.now());
        return;
      }
      cancellation.onCancel(() => void debug.stop());
      const entry = await debug.completion;
      if (cancellation.isCancellationRequested) {
        await execution.replaceOutput(errorOutput(executionCancelledPayload()));
        execution.end(false, Date.now());
        return;
      }
      if (!entry) {
        await execution.replaceOutput(
          new vscode.NotebookCellOutput([
            vscode.NotebookCellOutputItem.text("Debug session ended without a SQL result."),
          ]),
        );
        execution.end(true, Date.now());
        return;
      }
      if ("status" in entry) {
        if (entry.status === "error") {
          await execution.replaceOutput(errorOutput(debugResultErrorPayload(entry)));
        }
        execution.end(entry.status !== "error", Date.now());
        return;
      }
      await execution.replaceOutput(
        entry.columns.length > 0
          ? resultOutput(sqlNotebookResultPayload(entry, association.snapshot))
          : new vscode.NotebookCellOutput([
              vscode.NotebookCellOutputItem.text(
                `${entry.command} · ${entry.rowCount} row${entry.rowCount === 1 ? "" : "s"} · ${entry.durationMs} ms · debugged`,
              ),
            ]),
      );
      execution.end(true, Date.now());
      return;
    }

    const plan = await this.planResult(sql);
    cancellation.throwIfCancellationRequested();
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
    const statementTimeoutMs = scratchpadStatementTimeoutMs(
      notebookMetadata(cell.notebook.metadata),
      configuredScratchpadStatementTimeoutMs(),
    );
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
          statementTimeoutMs,
          cancellation,
        );
        cancellation.throwIfCancellationRequested();
        await execution.replaceOutput(resultOutput(payload));
        execution.end(true, Date.now());
      } catch (error) {
        if (cancellation.isCancellationRequested) {
          await this.resultHost.closeCell(cell.document.uri.toString());
        }
        await execution.replaceOutput(
          errorOutput(
            cancellation.isCancellationRequested
              ? executionCancelledPayload()
              : executionErrorPayload(error, undefined, statementTimeoutMs),
          ),
        );
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
        statementTimeoutMs,
        cancellation,
      );
      cancellation.throwIfCancellationRequested();
      if (outcome.schemaChanged && mode === "auto") {
        this.onSchemaMutation(association.snapshot);
      }
      await execution.replaceOutput(outcome.outputs);
      execution.end(outcome.success, Date.now());
    } catch (error) {
      if (mode === "manual" && cancellation.isCancellationRequested) {
        this.transactions.markFailed(cell.notebook.uri.toString());
      }
      await execution.replaceOutput(
        errorOutput(
          cancellation.isCancellationRequested
            ? executionCancelledPayload()
            : executionErrorPayload(error, undefined, statementTimeoutMs),
        ),
      );
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
    statementTimeoutMs: number,
    cancellation: NotebookClientCancellation,
  ): Promise<{ outputs: vscode.NotebookCellOutput[]; success: boolean; schemaChanged: boolean }> {
    const execute = async (client: import("pg").Client) => {
      cancellation.bind(this.connections, association.connection.id, client);
      cancellation.throwIfCancellationRequested();
      await configureNotebookStatementTimeout(client, statementTimeoutMs);
      cancellation.throwIfCancellationRequested();
      const outputs: vscode.NotebookCellOutput[] = [];
      let schemaChanged = false;
      for (const [index, statement] of statements.entries()) {
        cancellation.throwIfCancellationRequested();
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
          cancellation.throwIfCancellationRequested();

          if ("status" in result) {
            if (mode === "manual") {
              this.transactions.record(cell.notebook.uri.toString(), statement.sql, false);
            }
            const error =
              result.status === "error"
                ? debugResultErrorPayload(
                    result,
                    statements.length > 1 ? index + 1 : undefined,
                    statementTimeoutMs,
                  )
                : executionErrorPayload(
                    new Error("The SQL execution plan became invalid before execution."),
                    statements.length > 1 ? index + 1 : undefined,
                  );
            outputs.push(errorOutput(error));
            return { outputs, success: false, schemaChanged: false };
          }
          if (mode === "manual") {
            this.transactions.record(cell.notebook.uri.toString(), statement.sql, true);
          }
          if (result.columns.length > 0) {
            outputs.push(
              resultOutput(
                sqlNotebookResultPayload(
                  result,
                  association.snapshot,
                  statement.resultKind === "paged-query" ? statement.sql : undefined,
                ),
              ),
            );
          }
          schemaChanged ||= statement.schemaMutation === true;
        } catch (error) {
          if (mode === "manual") {
            this.transactions.record(cell.notebook.uri.toString(), statement.sql, false);
          }
          throw error;
        }
      }
      return { outputs, success: true, schemaChanged };
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
    statementTimeoutMs: number,
    cancellation: NotebookClientCancellation,
  ): Promise<SqlNotebookResultPayload> {
    const client = await createDedicatedNotebookClient(this.connections, association.serverId);
    cancellation.bind(this.connections, association.serverId, client);
    let reader: PostgresCursorReader | undefined;
    try {
      cancellation.throwIfCancellationRequested();
      await configureNotebookStatementTimeout(client, statementTimeoutMs);
      cancellation.throwIfCancellationRequested();
      const resultIdleTimeoutMs = settings.cursorIdleTimeoutSeconds * 1_000;
      await client.query("SELECT set_config('idle_in_transaction_session_timeout', $1, false)", [
        `${postgresCursorSafetyTimeoutMs(resultIdleTimeoutMs)}ms`,
      ]);
      reader = new PostgresCursorReader(client, sql);
      const session = await SqlResultSession.open(reader, {
        pageSize: settings.pageSize,
        maxCachedRows: settings.maxCachedRows,
        binding: association,
        statement: sql,
      });
      cancellation.throwIfCancellationRequested();
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
  private readonly subscriptions: vscode.Disposable[];

  private readonly debuggable = new Map<string, { version: number; value?: boolean }>();
  private readonly debuggableTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly connections: ConnectionManager,
    private readonly canDebug: ScratchpadDebugEligibility,
  ) {
    this.subscriptions = [
      connections.onChanged(() => this.invalidateDebuggable()),
      vscode.workspace.onDidCloseNotebookDocument((notebook) => {
        for (const cell of notebook.getCells())
          this.debuggable.delete(cell.document.uri.toString());
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("postgresql-workbench.sql.statementTimeoutMs")) {
          this.changed.fire();
        }
      }),
    ];
  }

  invalidateDebuggable(): void {
    for (const timer of this.debuggableTimers.values()) clearTimeout(timer);
    this.debuggableTimers.clear();
    this.debuggable.clear();
    this.changed.fire();
  }

  /** Last known Debug eligibility of a cell; false until the analysis has completed. */
  isDebuggable(cell: vscode.NotebookCell): boolean {
    const cached = this.debuggable.get(cell.document.uri.toString());
    return cached?.version === cell.document.version && cached.value === true;
  }

  private requestDebuggable(
    cell: vscode.NotebookCell,
    association: ScratchpadAssociationSnapshot,
  ): boolean {
    const key = cell.document.uri.toString();
    const version = cell.document.version;
    const cached = this.debuggable.get(key);
    if (cached?.version === version) return cached.value === true;
    // Debounce: typing bumps the version on every keystroke; analyse only the settled text.
    clearTimeout(this.debuggableTimers.get(key));
    this.debuggable.set(key, { version });
    const sql = cell.document.getText();
    this.debuggableTimers.set(
      key,
      setTimeout(() => {
        this.debuggableTimers.delete(key);
        if (this.debuggable.get(key)?.version !== version) return;
        void this.canDebug({ sql, association })
          .then((value) => {
            if (this.debuggable.get(key)?.version !== version) return;
            this.debuggable.set(key, { version, value });
            if (value) this.changed.fire();
          })
          .catch(() => {
            if (this.debuggable.get(key)?.version === version) this.debuggable.delete(key);
          });
      }, DEBUGGABLE_ANALYSIS_DELAY_MS),
    );
    return false;
  }

  provideCellStatusBarItems(
    cell: vscode.NotebookCell,
  ): vscode.NotebookCellStatusBarItem[] | undefined {
    if (cell.kind === vscode.NotebookCellKind.Markup) return undefined;
    const executionIntent = scratchpadCellExecutionIntent(cell.metadata);
    const manualMode =
      scratchpadExecutionMode(notebookMetadata(cell.notebook.metadata)) === "manual";
    const intentItem = new vscode.NotebookCellStatusBarItem(
      executionIntent === "debug" ? "$(debug-alt) Debug" : "$(play) Run",
      vscode.NotebookCellStatusBarAlignment.Right,
    );
    intentItem.command = {
      title: "Change cell execution intent",
      command: SET_SCRATCHPAD_CELL_EXECUTION_INTENT_COMMAND,
      arguments: [cell],
    };
    intentItem.tooltip =
      executionIntent === "debug"
        ? "Execution intent: Debug — the cell action attaches the PL/pgSQL debugger. Click to choose Run or Debug."
        : "Execution intent: Run — click to choose Run or Debug.";
    intentItem.priority = 101;
    const association = resolveScratchpadAssociation(
      notebookMetadata(cell.notebook.metadata),
      this.connections.servers,
    );
    const connected =
      association.status === "associated" &&
      this.connections.isServerConnected(association.connection.id);
    const label =
      association.status === "unassociated"
        ? "Choose a Connexion"
        : association.snapshot.serverName;
    const associationItem = new vscode.NotebookCellStatusBarItem(
      `${association.status === "associated" ? (connected ? "$(pass-filled)" : "$(circle-outline)") : "$(warning)"} ${label}`,
      vscode.NotebookCellStatusBarAlignment.Right,
    );
    associationItem.command = {
      title: "Change Scratchpad Connexion",
      command: CHANGE_SQL_NOTEBOOK_CONNECTION_COMMAND,
      arguments: [cell.notebook],
    };
    associationItem.tooltip =
      association.status === "associated"
        ? `Scratchpad Connexion ${connected ? "connected" : "disconnected"} — click to change it`
        : "Scratchpad Association unavailable — click to change its Connexion";
    associationItem.priority = 100;
    const metadata = notebookMetadata(cell.notebook.metadata);
    const globalTimeoutMs = configuredScratchpadStatementTimeoutMs();
    const timeoutMs = scratchpadStatementTimeoutMs(metadata, globalTimeoutMs);
    const timeoutItem = new vscode.NotebookCellStatusBarItem(
      `$(clock) Timeout: ${formatStatementTimeout(timeoutMs)}`,
      vscode.NotebookCellStatusBarAlignment.Right,
    );
    timeoutItem.command = {
      title: "Change Scratchpad Statement timeout",
      command: SET_SCRATCHPAD_STATEMENT_TIMEOUT_COMMAND,
      arguments: [cell.notebook],
    };
    timeoutItem.tooltip =
      metadata.statementTimeoutMs === undefined
        ? "Scratchpad Statement timeout from the global setting — click to change"
        : "Scratchpad Statement timeout override — click to change or use the global setting";
    timeoutItem.priority = 99;
    if (manualMode) return [associationItem, timeoutItem];
    const debuggable =
      association.status === "associated" && this.requestDebuggable(cell, association.snapshot);
    if (!debuggable) return [associationItem, timeoutItem];
    return executionIntent === "debug"
      ? [intentItem, associationItem]
      : [intentItem, associationItem, timeoutItem];
  }

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    for (const timer of this.debuggableTimers.values()) clearTimeout(timer);
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changed.dispose();
  }
}

async function pickScratchpadCellExecutionIntent(
  current: ScratchpadCellExecutionIntent,
): Promise<ScratchpadCellExecutionIntent | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "$(play) Run",
        description: current === "run" ? "Current" : undefined,
        detail: "Execute the cell SQL and show its result in the cell.",
        intent: "run" as const,
      },
      {
        label: "$(debug-alt) Debug",
        description: current === "debug" ? "Current" : undefined,
        detail:
          "Execute one replayable PL/pgSQL entry point with the debugger attached, then show its result in the cell.",
        intent: "debug" as const,
      },
    ],
    {
      title: "Scratchpad cell execution intent",
      placeHolder: "What the native cell action does for this cell",
    },
  );
  return picked?.intent;
}

function notebookMetadata(value: unknown): SqlNotebookMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const metadata: SqlNotebookMetadata = {};
  for (const key of ["serverId", "serverName", "database"] as const) {
    if (typeof source[key] === "string" && source[key]) metadata[key] = source[key];
  }
  if (source.executionMode === "manual") metadata.executionMode = "manual";
  const statementTimeoutMs = validStatementTimeoutMs(source.statementTimeoutMs);
  if (statementTimeoutMs !== undefined) metadata.statementTimeoutMs = statementTimeoutMs;
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
  statementTimeoutMs?: number,
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
    ...statementTimeoutRecovery(error.code, error.message, statementTimeoutMs),
  };
}

function executionErrorPayload(
  error: unknown,
  statement?: number,
  statementTimeoutMs?: number,
): SqlNotebookErrorPayload {
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
    ...statementTimeoutRecovery(code, errorMessage(error), statementTimeoutMs),
  };
}

function statementTimeoutRecovery(
  code: string | undefined,
  message: string,
  statementTimeoutMs: number | undefined,
): Pick<SqlNotebookErrorPayload, "action" | "hint"> {
  if (code !== "57014" || !/statement timeout/iu.test(message)) return {};
  return {
    hint:
      statementTimeoutMs === undefined
        ? "Increase this Scratchpad's Statement timeout and run the cell again."
        : `This Scratchpad allows ${formatStatementTimeout(statementTimeoutMs)} per Statement. Increase its timeout and run the cell again.`,
    action: {
      type: "increase-scratchpad-timeout",
      label: "Increase Scratchpad timeout…",
    },
  };
}

function notebookErrorPayload(
  category: SqlNotebookErrorPayload["category"],
  title: string,
  message: string,
): SqlNotebookErrorPayload {
  return { version: 1, type: "error", category, title, message };
}

function executionCancelledPayload(): SqlNotebookErrorPayload {
  return notebookErrorPayload(
    "execution",
    "Execution cancelled",
    "The SQL execution was cancelled by the user.",
  );
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

export interface SqlResultSettings {
  pageSize: number;
  maxCachedRows: number;
  cursorIdleTimeoutSeconds: number;
  nonPagedMaxRows: number;
}

export function sqlResultSettings(): SqlResultSettings {
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
