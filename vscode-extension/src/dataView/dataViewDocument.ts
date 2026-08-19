import * as vscode from "vscode";
import { quoteIdentifier } from "../../../packages/sql/src/authoring/completion.js";
import type {
  SqlAuthoringDragPayload,
  SqlAuthoringSnapshot,
} from "../../../packages/sql/src/authoring/protocol.js";
import {
  type QueryRewrite,
  SqlQueryModel,
} from "../../../packages/sql/src/authoring/query/model.js";
import {
  type DataViewAddition,
  type DataViewEdit,
  type DataViewEditability,
  type DataViewProjection,
  type DataViewQueryInfo,
  type DataViewRequest,
  type DataViewResponse,
  type DataViewSource,
  type DataViewState,
  dataViewSourceTitle,
} from "../../../packages/views/src/dataView/protocol.js";
import type { SqlNotebookResultPayload, SqlResultSession } from "../scratchpad/index.js";
import { completeDataViewFilter } from "./completion/filterCompletion.js";
import { dataViewCompletionUri, dataViewQueryUri } from "./dataViewUri.js";
import { READ_ONLY_REASONS } from "./editability.js";
import { exportAllRows, exportLoadedRows, pickExportTarget } from "./export/exportResult.js";
import { type DataViewHostServices, errorMessage } from "./hostServices.js";
import { composeIntoDataViewQuery, dataViewAdditions } from "./query/composition.js";
import { initialDataViewQuery } from "./query/initialQuery.js";
import { PendingEdits } from "./session/pendingEdits.js";
import { openDataViewResult, TableAccents } from "./session/resultLoader.js";

const EMPTY_EDITABILITY: DataViewEditability = { tables: [], columns: [] };

class LoadCancelledError extends Error {}

/**
 * One open Data View. Orchestrates its collaborators — the query text and its rewrites, the
 * bounded result cursor, the pending edits — and mirrors their state to the webviews. Every
 * VS Code integration point (query file, editor, completion document) is reached through the
 * injected host services.
 */
export class DataViewDocument implements vscode.CustomDocument {
  readonly source: DataViewSource;
  readonly queryUri: vscode.Uri;
  /** Hidden SQL document that only exists to ask the SQL authoring server for filter completions. */
  private readonly completionUri: vscode.Uri;
  private readonly query: SqlQueryModel;
  private readonly edits = new PendingEdits();
  private readonly accents = new TableAccents();
  private hidden: string[] = [];
  /** Column keys shown at least once: new technical columns start hidden, known ones keep the user's choice. */
  private readonly seenColumns = new Set<string>();
  private initialized: Promise<void> | undefined;
  private session: SqlResultSession | undefined;
  private payload: SqlNotebookResultPayload | undefined;
  private editability: DataViewEditability = EMPTY_EDITABILITY;
  private projection: DataViewProjection = { tables: [], columnTable: [] };
  private status: DataViewState["status"] = "loading";
  private message: string | undefined;
  private busy = false;
  private applying = false;
  private loadGeneration = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly webviews = new Set<vscode.Webview>();
  private readonly _onDidEdit = new vscode.EventEmitter<{
    label: string;
    undo: () => void;
    redo: () => void;
  }>();
  /** Fired only when VS Code's native dirty tracking is in use (see provider). */
  readonly onDidEdit = this._onDidEdit.event;
  private disposed = false;

  constructor(
    readonly uri: vscode.Uri,
    source: DataViewSource,
    private readonly services: DataViewHostServices,
    private readonly nativeDirtyTracking: () => boolean,
  ) {
    this.source = source;
    this.queryUri = dataViewQueryUri(source);
    this.completionUri = dataViewCompletionUri(source);
    this.query = new SqlQueryModel(() => services.parser(), {
      budget: () => {
        const settings = services.authoringSettings(this.queryUri.toString());
        return {
          uri: this.queryUri.toString(),
          maxDepth: settings.syntaxMaxDepth,
          maxNodes: settings.syntaxMaxNodes,
        };
      },
    });
  }

  get title(): string {
    return dataViewSourceTitle(this.source);
  }

  get hasPendingEdits(): boolean {
    return this.edits.size > 0;
  }

  attach(webview: vscode.Webview): vscode.Disposable {
    this.webviews.add(webview);
    return new vscode.Disposable(() => this.webviews.delete(webview));
  }

  /** What the grid shows about the query: the shared model's view, plus this Data View's state. */
  private queryInfo(): DataViewQueryInfo {
    const whereText = this.query.whereText();
    return {
      uri: this.queryUri.toString(),
      text: this.query.text,
      ...(whereText === undefined ? {} : { whereText }),
      orderBy: this.query.orderBy(),
      hidden: [...this.hidden],
      structured: this.query.analysis !== undefined,
      ...(this.query.problem === undefined ? {} : { problem: this.query.problem }),
      editorDirty: this.queryDocument()?.isDirty === true,
    };
  }

  state(): DataViewState {
    return {
      source: this.source,
      serverName: this.serverName(),
      query: this.queryInfo(),
      projection: this.projection,
      status: this.status,
      ...(this.message !== undefined ? { message: this.message } : {}),
      ...(this.payload ? { payload: this.payload } : {}),
      editability: this.editability,
      edits: [...this.edits.list],
      busy: this.busy,
      applying: this.applying,
    };
  }

  /** The grid re-renders when its query editor becomes dirty or clean. */
  refreshQueryState(): void {
    this.broadcastState();
  }

  async handle(request: DataViewRequest): Promise<void> {
    const tabSize = () => this.services.authoringSettings(this.queryUri.toString()).tabSize;
    switch (request.type) {
      case "data-view/ready":
        if (this.loadGeneration === 0) {
          await this.ensureInitialized();
          await this.load();
        } else this.broadcastState();
        return;
      case "data-view/refresh":
        await this.load();
        return;
      case "data-view/sort":
        await this.applyRewrite(this.query.sorted(request.sorts, tabSize()));
        return;
      case "data-view/filter":
        await this.applyRewrite(this.query.filtered(request.text, tabSize()));
        return;
      case "data-view/reorder":
        await this.applyRewrite(
          await this.query.reordered(
            request.from,
            request.to,
            this.payload?.columns.map((column) => column.name) ?? [],
            tabSize(),
          ),
        );
        return;
      case "data-view/reorder-table":
        await this.applyRewrite(
          this.query.tableBlockMoved(
            this.projection.columnTable,
            request.from,
            request.to,
            tabSize(),
          ),
        );
        return;
      case "data-view/remove-table": {
        const table = this.projection.tables[request.tableIndex];
        if (!table) return;
        await this.applyRewrite(
          this.query.relationRemoved(
            table,
            this.projection.columnTable.flatMap((owner, ordinal) =>
              owner === request.tableIndex ? [ordinal] : [],
            ),
            tabSize(),
          ),
        );
        return;
      }
      case "data-view/hide":
        this.hidden = [...this.hidden.filter((key) => key !== request.column), request.column];
        this.broadcastState();
        return;
      case "data-view/unhide":
        this.hidden =
          request.column === undefined ? [] : this.hidden.filter((key) => key !== request.column);
        this.broadcastState();
        return;
      case "data-view/additions":
        this.broadcast({ type: "data-view/additions", items: this.additions() });
        return;
      case "data-view/compose":
        await this.compose(
          request.addition.payload as SqlAuthoringDragPayload,
          request.addition,
          request.relationChoice,
        );
        return;
      case "data-view/drop-tree": {
        const payload = this.services.treeDragPayload(true);
        if (!payload) {
          this.notify("Drop a table, view, or column from the Workbench tree.", "info");
          return;
        }
        await this.compose(payload);
        return;
      }
      case "data-view/complete": {
        const analysis = this.query.analysis;
        const items = analysis
          ? await completeDataViewFilter({
              queryText: this.query.text,
              analysis,
              completionUri: this.completionUri,
              text: request.text,
              offset: request.offset,
              log: (line) => this.log(line),
            })
          : [];
        this.broadcast({ type: "data-view/completions", requestId: request.requestId, items });
        return;
      }
      case "data-view/edit-query":
        await this.editQuery(request.clause);
        return;
      case "data-view/apply-query":
        await this.applyQueryFromEditor();
        return;
      case "data-view/navigate":
        await this.navigate(request.action);
        return;
      case "data-view/edit":
        this.recordEdit(request.edit);
        return;
      case "data-view/copy":
        await vscode.env.clipboard.writeText(request.text);
        return;
      case "data-view/export":
        await this.export(request.format, request.scope);
        return;
      case "data-view/open-sql":
        await this.services.openSql(this.source, this.query.effectiveSql());
        return;
      case "data-view/discard":
      case "data-view/apply":
        // Routed by the provider: native save/revert or direct apply/discard.
        return;
    }
  }

  // --- Query text lifecycle -------------------------------------------------------------------

  /** Creates the query document: an explicit projection for relations, the statement for SQL. */
  private ensureInitialized(): Promise<void> {
    if (!this.initialized) this.initialized = this.initialize();
    return this.initialized;
  }

  private async initialize(): Promise<void> {
    const source = this.source;
    const text = await initialDataViewQuery(
      source,
      this.services.authoringSnapshot(source.serverId, source.database),
      this.services.authoringSettings(this.queryUri.toString()),
      () => this.relationColumns(),
    );
    await this.query.setText(text);
    this.services.queryFiles.set(this.queryUri, text, (saved, reason) => {
      // Only a deliberate save applies the query; auto save (delay, focus out) just persists it.
      if (reason === undefined || reason === vscode.TextDocumentSaveReason.Manual) {
        void this.applyQueryText(saved);
      }
    });
    this.services.queryFiles.set(this.completionUri, text);
    await this.services.associate(this.queryUri.toString(), source.serverId);
    await this.services.associate(this.completionUri.toString(), source.serverId);
  }

  private async relationColumns(): Promise<string[]> {
    if (this.source.kind !== "relation") return [];
    const client = await this.services.openClient(this.source.serverId);
    try {
      const probe = await client.query({
        text: `SELECT * FROM ${quoteIdentifier(this.source.schema)}.${quoteIdentifier(this.source.name)} LIMIT 0`,
        rowMode: "array",
      });
      return probe.fields.map((field) => field.name);
    } finally {
      await client.end().catch(() => {});
    }
  }

  private queryDocument(): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === this.queryUri.toString(),
    );
  }

  private async applyRewrite(rewrite: QueryRewrite): Promise<void> {
    if (rewrite.status === "rejected") {
      this.notify(rewrite.message, "info");
      return;
    }
    if (rewrite.status === "changed") await this.updateQueryText(rewrite.text);
  }

  /**
   * Writes new query text to the query file and reloads. An open, clean editor follows the file;
   * a dirty editor receives the text as an unsaved edit so the user's work is not replaced.
   */
  private async updateQueryText(text: string): Promise<void> {
    const document = this.queryDocument();
    if (document?.isDirty) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        this.queryUri,
        new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
        text,
      );
      await vscode.workspace.applyEdit(edit);
    }
    this.services.queryFiles.set(this.queryUri, text);
    await this.applyQueryText(text);
  }

  /** New query text saved from an editor or written by a grid action. */
  private async applyQueryText(text: string): Promise<void> {
    if (text === this.query.text && this.loadGeneration > 0 && this.status !== "error") {
      this.broadcastState();
      return;
    }
    await this.query.setText(text);
    await this.load();
  }

  /** Opens the query document beside the grid, reusing an editor that already shows it. */
  private async editQuery(clause: "select" | undefined): Promise<void> {
    await this.ensureInitialized();
    const document = await vscode.workspace.openTextDocument(this.queryUri);
    if (document.languageId !== "sql") {
      await vscode.languages.setTextDocumentLanguage(document, "sql");
    }
    const existing = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === this.queryUri.toString(),
    );
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: existing?.viewColumn ?? vscode.ViewColumn.Beside,
      preserveFocus: false,
      preview: false,
    });
    const analysis = this.query.analysis;
    if (clause === "select" && analysis && !document.isDirty) {
      const position = document.positionAt(analysis.targetList.end);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position));
    }
  }

  /** Applies the editor's current text to the grid without saving it. */
  private async applyQueryFromEditor(): Promise<void> {
    const document = this.queryDocument();
    if (document?.isDirty) await this.applyQueryText(document.getText());
    else await this.load();
  }

  // --- Composition ---------------------------------------------------------------------------

  /** The indexed snapshot to compose against, or nothing when the query or the index refuses it. */
  private composable(): SqlAuthoringSnapshot | undefined {
    const snapshot = this.services.authoringSnapshot(this.source.serverId, this.source.database);
    if (snapshot?.status !== "available") {
      this.notify("Index the database first: composition needs a fresh Workbench Index.", "info");
      return undefined;
    }
    if (!this.query.analysis && !this.query.isEmpty) {
      this.notify(this.query.problem ?? "The query cannot be composed from the grid.", "info");
      return undefined;
    }
    return snapshot;
  }

  private additions() {
    const snapshot = this.composable();
    if (!snapshot) return [];
    const items = dataViewAdditions(
      this.projection,
      new Set(this.payload?.columns.map((column) => column.name) ?? []),
      snapshot,
    );
    this.log(
      `${items.length} additions (${this.projection.tables.length} tables in query, ${snapshot.objects.length} indexed objects)`,
    );
    return items;
  }

  private async compose(
    payload: SqlAuthoringDragPayload,
    addition?: DataViewAddition,
    relationChoice?: number,
  ): Promise<void> {
    if (payload.serverId !== this.source.serverId || payload.database !== this.source.database) {
      this.notify("This object belongs to another database than the Data View.", "info");
      return;
    }
    const snapshot = this.composable();
    if (!snapshot) return;
    const analysis = this.query.analysis;
    const outcome = await composeIntoDataViewQuery({
      text: this.query.text,
      statementEnd: analysis?.statement.end ?? 0,
      uri: this.queryUri.toString(),
      payload,
      ...(relationChoice === undefined ? {} : { relationChoice }),
      settings: this.services.authoringSettings(this.queryUri.toString()),
      parser: await this.services.parser(),
      compose: (composeRequest) => this.services.compose(composeRequest),
    });
    if (outcome.status === "rejected") {
      this.notify(outcome.message, "info");
      return;
    }
    if (outcome.status === "ambiguous") {
      // Several JOIN paths: the view shows them where the user is, instead of a VS Code picker.
      const target = addition ?? {
        tableIndex: -1,
        kind: payload.kind === "column" ? ("column" as const) : ("table" as const),
        label: payload.kind === "column" ? payload.name : `${payload.schema}.${payload.name}`,
        detail: "",
        payload,
      };
      this.broadcast({
        type: "data-view/choices",
        addition: target,
        title: outcome.title,
        choices: outcome.choices,
      });
      return;
    }
    await this.updateQueryText(outcome.text);
  }

  // --- Result cursor -------------------------------------------------------------------------

  /** (Re)opens the bounded cursor for the current query text. */
  async load(): Promise<void> {
    const generation = ++this.loadGeneration;
    await this.closeSession();
    this.status = "loading";
    this.message = undefined;
    this.busy = true;
    this.broadcastState();
    try {
      await this.ensureInitialized();
      if (this.query.isEmpty) {
        this.payload = undefined;
        this.editability = EMPTY_EDITABILITY;
        this.projection = { tables: [], columnTable: [] };
        this.status = "ready";
        this.message =
          "The query is empty: add a table with + or drop one from the Workbench tree.";
        return;
      }
      const client = await this.services.openClient(this.source.serverId);
      this.assertGeneration(generation);
      const opened = await openDataViewResult({
        client,
        sql: this.query.effectiveSql(),
        settings: this.services.resultSettings(),
        binding: {
          serverId: this.source.serverId,
          serverName: this.serverName(),
          database: this.source.database,
        },
        accents: this.accents,
        checkpoint: () => this.assertGeneration(generation),
      });
      this.session = opened.session;
      this.payload = opened.session.snapshot();
      this.editability = opened.editability;
      this.projection = opened.projection;
      // Technical columns start hidden the first time they appear (including after a JOIN was
      // composed); the user's later choices are kept.
      const fresh = opened.technicalKeys.filter((key) => !this.seenColumns.has(key));
      if (fresh.length > 0) this.hidden = [...new Set([...this.hidden, ...fresh])];
      for (const key of opened.columnKeys) this.seenColumns.add(key);
      this.status = "ready";
      this.touch(opened.idleTimeoutMs);
    } catch (error) {
      if (error instanceof LoadCancelledError) return;
      this.status = "error";
      this.message = errorMessage(error);
      this.log(`failed to load: ${this.message}`);
    } finally {
      if (generation === this.loadGeneration) {
        this.busy = false;
        this.broadcastState();
      }
    }
  }

  private async navigate(action: "previous" | "next" | "load-all" | "cancel"): Promise<void> {
    const session = this.session;
    if (!session) {
      this.notify("The result cursor is closed. Refresh to load the rows again.", "info");
      return;
    }
    if (action === "cancel") {
      await this.closeSession();
      this.message = "Loading cancelled. Refresh to load the rows again.";
      this.broadcastState();
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.broadcastState();
    try {
      if (action === "previous") this.payload = session.previous();
      else if (action === "next") this.payload = await session.next();
      else {
        this.payload = await session.loadAll((loadedRowCount) =>
          this.broadcast({ type: "data-view/progress", loadedRowCount }),
        );
      }
      this.touch(this.services.resultSettings().cursorIdleTimeoutSeconds * 1_000);
    } catch (error) {
      if (this.session === session) {
        await this.closeSession();
        this.message = `${errorMessage(error)} Refresh to load the rows again.`;
      }
    } finally {
      this.busy = false;
      this.broadcastState();
    }
  }

  private touch(idleTimeoutMs: number): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.closeSession().then(() => {
        this.message =
          "The result cursor was closed after being idle. Refresh to load the rows again.";
        this.broadcastState();
      });
    }, idleTimeoutMs);
  }

  private async closeSession(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const session = this.session;
    this.session = undefined;
    await session?.close().catch(() => {});
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.loadGeneration || this.disposed) throw new LoadCancelledError();
  }

  // --- Cell edits ----------------------------------------------------------------------------

  private recordEdit(edit: DataViewEdit): void {
    const policy = this.editability.columns[edit.ordinal];
    if (!policy?.editable || this.applying) {
      this.notify(policy?.editable ? READ_ONLY_REASONS.applying : (policy?.reason ?? ""), "info");
      return;
    }
    const previous = this.edits.set(edit);
    if (this.nativeDirtyTracking()) {
      this._onDidEdit.fire({
        label: `Edit ${edit.column}`,
        undo: () => {
          if (previous) this.edits.set(previous);
          else this.edits.remove(edit);
          this.broadcastState();
        },
        redo: () => {
          this.edits.set(edit);
          this.broadcastState();
        },
      });
    }
    this.broadcastState();
  }

  discard(): void {
    this.edits.clear();
    this.broadcastState();
  }

  /** Applies every pending edit in one transaction; leaves the database unchanged on any failure. */
  async apply(): Promise<void> {
    if (this.edits.size === 0) return;
    if (this.applying) throw new Error("Changes are already being applied.");
    this.applying = true;
    this.broadcastState();
    const client = await this.services.openClient(this.source.serverId).catch((error) => {
      this.applying = false;
      this.broadcastState();
      throw error;
    });
    try {
      const applied = await this.edits.applyWith(client, this.editability);
      this.applying = false;
      this.notify(
        `${applied} change${applied === 1 ? "" : "s"} applied to ${this.serverName()}.`,
        "info",
      );
      await this.load();
    } catch (error) {
      this.applying = false;
      this.broadcastState();
      const detail = errorMessage(error);
      this.log(`apply failed: ${detail}`);
      throw new Error(detail);
    } finally {
      await client.end().catch(() => {});
    }
  }

  // --- Export --------------------------------------------------------------------------------

  private async export(format: "csv" | "tsv" | "json", scope: "loaded" | "all"): Promise<void> {
    const payload = this.payload;
    if (!payload) return;
    const target = await pickExportTarget(this.title, format, scope);
    if (!target) return;
    try {
      if (scope === "loaded") {
        await exportLoadedRows(target, format, payload, this.query.effectiveSql());
      } else {
        await exportAllRows({
          target,
          format,
          sql: this.query.effectiveSql(),
          title: this.title,
          openClient: () => this.services.openClient(this.source.serverId),
        });
      }
      this.notify(`Exported to ${target.fsPath}`, "info");
    } catch (error) {
      this.notify(`Export failed: ${errorMessage(error)}`, "error");
    }
  }

  // --- Webview messaging ---------------------------------------------------------------------

  private serverName(): string {
    return this.services.serverName(this.source.serverId) ?? this.source.serverId;
  }

  private log(line: string): void {
    this.services.output.appendLine(`Data View ${this.title}: ${line}`);
  }

  private notify(message: string, severity: "info" | "error"): void {
    this.broadcast({ type: "data-view/notice", message, severity });
  }

  private broadcastState(): void {
    this.broadcast({ type: "data-view/state", state: this.state() });
  }

  private broadcast(response: DataViewResponse): void {
    for (const webview of this.webviews) void webview.postMessage(response);
  }

  dispose(): void {
    this.disposed = true;
    this.loadGeneration += 1;
    void this.closeSession();
    this._onDidEdit.dispose();
    this.webviews.clear();
    const queryUri = this.queryUri.toString();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === queryUri) {
          void vscode.window.tabGroups.close(tab, true);
        }
      }
    }
    this.services.queryFiles.remove(this.queryUri);
    this.services.queryFiles.remove(this.completionUri);
    void this.services.dissociate(queryUri);
    void this.services.dissociate(this.completionUri.toString());
  }
}
