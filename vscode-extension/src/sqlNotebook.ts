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
import type { ServerConfig } from "./serverStore.js";
import {
  createDedicatedNotebookClient,
  DedicatedNotebookConnectionError,
  withDedicatedNotebookClient,
} from "./sqlNotebookConnection.js";
import { SQL_NOTEBOOK_SCHEME, SqlNotebookFileSystemProvider } from "./sqlNotebookFileSystem.js";
import {
  bindingFingerprint,
  bindingSnapshot,
  emptySqlNotebook,
  type NotebookBinding,
  type NotebookBindingSnapshot,
  normalizeSqlNotebookName,
  parseSqlNotebookFile,
  resolveNotebookBinding,
  SQL_NOTEBOOK_RESULT_MIME,
  SQL_NOTEBOOK_TYPE,
  type SqlNotebookErrorPayload,
  type SqlNotebookFile,
  type SqlNotebookMetadata,
  type SqlNotebookResultPayload,
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
export const USE_SQL_NOTEBOOK_BINDING_AS_ACTIVE_COMMAND =
  "postgresql-workbench.useSqlNotebookBindingAsActive";

type ResultPlanner = (sql: string) => Promise<SqlExecutionPlan>;

export function registerSqlNotebook(
  context: vscode.ExtensionContext,
  connections: ConnectionManager,
  planResult: ResultPlanner,
): SqlNotebookWorkspace {
  const serializer = new SqlNotebookSerializer();
  const controller = new SqlNotebookController(connections, planResult);
  const statusProvider = new SqlNotebookStatusProvider(connections);
  const fileSystem = new SqlNotebookFileSystemProvider(context.globalStorageUri);
  const workspace = new SqlNotebookWorkspace(fileSystem);

  context.subscriptions.push(
    fileSystem,
    workspace,
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
      const server = await pickNotebookServer(
        connections,
        target,
        "Create scratchpad for database",
      );
      if (!server) return undefined;

      const file = emptySqlNotebook(bindingSnapshot(server));
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
        return renameSqlNotebook(workspace, controller, entry, name);
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
        return deleteSqlNotebook(workspace, entry);
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
        const server = await pickNotebookServer(
          connections,
          undefined,
          "Rebind scratchpad to database",
        );
        if (!server) return false;
        await updateNotebookMetadata(notebook, bindingSnapshot(server));
        statusProvider.refresh();
        return true;
      },
    ),
    vscode.commands.registerCommand(
      RECONNECT_SQL_NOTEBOOK_COMMAND,
      async (target?: SqlNotebookEntry | vscode.NotebookDocument | vscode.NotebookCell) => {
        const notebook =
          (await notebookFromTarget(target)) ?? vscode.window.activeNotebookEditor?.notebook;
        if (!notebook || notebook.notebookType !== SQL_NOTEBOOK_TYPE) return false;
        const binding = resolveNotebookBinding(
          notebookMetadata(notebook.metadata),
          connections.servers,
        );
        if (binding.status !== "bound") {
          void vscode.window.showWarningMessage(
            "This scratchpad binding is unavailable. Rebind it to a saved database context.",
          );
          return false;
        }
        try {
          await withDedicatedNotebookClient(connections, binding.server.id, async () => undefined);
          void vscode.window.showInformationMessage(
            `Scratchpad connection to ${binding.snapshot.serverName} is available.`,
          );
          return true;
        } catch (error) {
          const action = await vscode.window.showErrorMessage(errorMessage(error), "Rebind");
          if (action === "Rebind") {
            void vscode.commands.executeCommand(CHANGE_SQL_NOTEBOOK_CONNECTION_COMMAND, notebook);
          }
          return false;
        }
      },
    ),
    vscode.commands.registerCommand(
      USE_SQL_NOTEBOOK_BINDING_AS_ACTIVE_COMMAND,
      async (target?: SqlNotebookEntry | vscode.NotebookDocument | vscode.NotebookCell) => {
        const notebook =
          (await notebookFromTarget(target)) ?? vscode.window.activeNotebookEditor?.notebook;
        if (!notebook || notebook.notebookType !== SQL_NOTEBOOK_TYPE) return false;
        const binding = resolveNotebookBinding(
          notebookMetadata(notebook.metadata),
          connections.servers,
        );
        if (binding.status !== "bound") return false;
        return connections.connectServer(binding.server.id);
      },
    ),
  );
  return workspace;
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
  server: ServerConfig;
}

async function pickNotebookServer(
  connections: ConnectionManager,
  target: unknown,
  placeHolder: string,
): Promise<ServerConfig | undefined> {
  const targetId = notebookServerId(target);
  if (targetId) return connections.store.get(targetId);
  const servers = [...connections.servers];
  if (servers.length === 0) {
    void vscode.window.showInformationMessage(
      "Add a PostgreSQL database context before creating or rebinding a scratchpad.",
    );
    return undefined;
  }
  const selected = await vscode.window.showQuickPick<SqlNotebookServerPick>(
    servers.map((server) => ({
      label: server.name,
      description: `${server.host}:${server.port} · ${server.database}`,
      server,
    })),
    { placeHolder },
  );
  return selected?.server;
}

function notebookServerId(target: unknown): string | undefined {
  if (typeof target === "string") return target;
  if (!target || typeof target !== "object") return undefined;
  const candidate = target as { kind?: unknown; server?: { id?: unknown } };
  if (candidate.kind !== "databaseSource" && candidate.kind !== "scratchpads") return undefined;
  return typeof candidate.server?.id === "string" ? candidate.server.id : undefined;
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
      description: notebookConnectionLabel(entry.metadata),
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

function notebookConnectionLabel(metadata: SqlNotebookMetadata): string | undefined {
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
  private readonly notebookBindings = new Map<string, string>();

  constructor(
    private readonly connections: ConnectionManager,
    private readonly planResult: ResultPlanner,
  ) {
    this.controller = vscode.notebooks.createNotebookController(
      "postgresql-workbench.sql",
      SQL_NOTEBOOK_TYPE,
      "PostgreSQL Workbench",
    );
    this.controller.description = "Persistent PostgreSQL scratch notebook";
    this.controller.supportedLanguages = ["plpgsql"];
    this.controller.supportsExecutionOrder = true;
    this.controller.executeHandler = (cells, notebook) => this.execute(cells, notebook);
    this.subscriptions = [
      connections.onChanged(() => {
        for (const notebook of vscode.workspace.notebookDocuments) {
          if (notebook.notebookType === SQL_NOTEBOOK_TYPE) void this.observeBinding(notebook);
        }
      }),
      vscode.workspace.onDidOpenNotebookDocument((notebook) => {
        if (notebook.notebookType === SQL_NOTEBOOK_TYPE) this.rememberBinding(notebook);
      }),
      vscode.workspace.onDidCloseNotebookDocument((notebook) => {
        this.notebookBindings.delete(notebook.uri.toString());
        void this.resultHost.closeNotebook(notebook.uri.toString());
      }),
      vscode.workspace.onDidChangeNotebookDocument(({ notebook }) => {
        if (notebook.notebookType !== SQL_NOTEBOOK_TYPE) return;
        void this.observeBinding(notebook);
      }),
    ];
  }

  prefer(notebook: vscode.NotebookDocument): void {
    this.rememberBinding(notebook);
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
    const binding = resolveNotebookBinding(
      notebookMetadata(notebook.metadata),
      this.connections.servers,
    );
    if (binding.status !== "bound") {
      const message =
        binding.status === "unavailable"
          ? `The bound PostgreSQL database ${binding.snapshot.serverName} is no longer saved. Rebind this scratchpad.`
          : "This scratchpad has no PostgreSQL binding. Rebind it before running SQL.";
      for (const cell of cells) await this.showError(cell, message);
      const action = await vscode.window.showWarningMessage(message, "Rebind");
      if (action === "Rebind") {
        void vscode.commands.executeCommand(CHANGE_SQL_NOTEBOOK_CONNECTION_COMMAND, notebook);
      }
      return;
    }

    for (const cell of cells) {
      if (cell.kind !== vscode.NotebookCellKind.Code) continue;
      await this.executeCell(cell, binding);
    }
  }

  private async executeCell(cell: vscode.NotebookCell, binding: NotebookBinding): Promise<void> {
    if (binding.status !== "bound") return;
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

    const settings = sqlResultSettings();
    const [singleStatement] = plan.statements;
    if (plan.statements.length === 1 && singleStatement?.resultKind === "paged-query") {
      try {
        const payload = await this.executePagedCell(
          cell,
          singleStatement.sql,
          settings,
          binding.snapshot,
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
      const outcome = await this.executeStatementPlan(cell, plan.statements, settings, binding);
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
    binding: Extract<NotebookBinding, { status: "bound" }>,
  ): Promise<{ outputs: vscode.NotebookCellOutput[]; success: boolean }> {
    return withDedicatedNotebookClient(this.connections, binding.server.id, async (client) => {
      const outputs: vscode.NotebookCellOutput[] = [];
      for (const [index, statement] of statements.entries()) {
        const result = await executeSqlSelection(
          client,
          {
            status: "ready",
            sql: statement.sql,
            source: {
              name: cell.notebook.uri.path.split("/").at(-1) ?? "SQL notebook",
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
        if (result.columns.length > 0) {
          outputs.push(resultOutput(sqlNotebookResultPayload(result, binding.snapshot)));
        }
      }
      return { outputs, success: true };
    });
  }

  private async executePagedCell(
    cell: vscode.NotebookCell,
    sql: string,
    settings: SqlResultSettings,
    binding: NotebookBindingSnapshot,
  ): Promise<SqlNotebookResultPayload> {
    const client = await createDedicatedNotebookClient(this.connections, binding.serverId);
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
        binding,
      });
      return this.resultHost.register(session, cell, resultIdleTimeoutMs, binding, () =>
        this.isBindingCurrent(cell.notebook, binding),
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
      errorOutput(notebookErrorPayload("connection", "Database binding unavailable", message)),
    );
    execution.end(false, Date.now());
  }

  private async offerConnectionRecovery(
    notebook: vscode.NotebookDocument,
    error: DedicatedNotebookConnectionError,
  ): Promise<void> {
    const action = await vscode.window.showWarningMessage(error.message, "Reconnect", "Rebind");
    if (action === "Reconnect") {
      void vscode.commands.executeCommand(RECONNECT_SQL_NOTEBOOK_COMMAND, notebook);
    } else if (action === "Rebind") {
      void vscode.commands.executeCommand(CHANGE_SQL_NOTEBOOK_CONNECTION_COMMAND, notebook);
    }
  }

  private isBindingCurrent(
    notebook: vscode.NotebookDocument,
    expected: NotebookBindingSnapshot,
  ): boolean {
    const binding = resolveNotebookBinding(
      notebookMetadata(notebook.metadata),
      this.connections.servers,
    );
    return (
      binding.status === "bound" &&
      bindingFingerprint(binding.snapshot) === bindingFingerprint(expected)
    );
  }

  private rememberBinding(notebook: vscode.NotebookDocument): void {
    this.notebookBindings.set(notebook.uri.toString(), this.bindingStateKey(notebook));
  }

  private async observeBinding(notebook: vscode.NotebookDocument): Promise<void> {
    const uri = notebook.uri.toString();
    const next = this.bindingStateKey(notebook);
    const previous = this.notebookBindings.get(uri);
    this.notebookBindings.set(uri, next);
    if (previous === undefined || previous === next) return;

    const binding = resolveNotebookBinding(
      notebookMetadata(notebook.metadata),
      this.connections.servers,
    );
    await this.resultHost.closeNotebookBindingMismatch(
      uri,
      binding.status === "bound" ? binding.snapshot : undefined,
    );
  }

  private bindingStateKey(notebook: vscode.NotebookDocument): string {
    const binding = resolveNotebookBinding(
      notebookMetadata(notebook.metadata),
      this.connections.servers,
    );
    return binding.status === "unbound"
      ? "unbound"
      : `${binding.status}:${bindingFingerprint(binding.snapshot)}`;
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
    const binding = resolveNotebookBinding(
      notebookMetadata(cell.notebook.metadata),
      this.connections.servers,
    );
    const label =
      binding.status === "unbound"
        ? "Rebind PostgreSQL database"
        : `${binding.snapshot.serverName} · ${binding.snapshot.database}`;
    const item = new vscode.NotebookCellStatusBarItem(
      `${binding.status === "bound" ? "$(database)" : "$(warning)"} ${label}`,
      vscode.NotebookCellStatusBarAlignment.Right,
    );
    item.command = {
      title: "Change PostgreSQL Connection",
      command: CHANGE_SQL_NOTEBOOK_CONNECTION_COMMAND,
      arguments: [cell.notebook],
    };
    item.tooltip =
      binding.status === "bound"
        ? "Scratchpad PostgreSQL binding — click to rebind it"
        : "Scratchpad binding unavailable — click to rebind it";
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
  return metadata;
}

async function updateNotebookMetadata(
  notebook: vscode.NotebookDocument,
  metadata: SqlNotebookMetadata,
): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, [vscode.NotebookEdit.updateNotebookMetadata(metadata)]);
  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error("Could not update SQL notebook connection metadata.");
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
      ...notebookErrorPayload("connection", "PostgreSQL connection error", error.message),
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
