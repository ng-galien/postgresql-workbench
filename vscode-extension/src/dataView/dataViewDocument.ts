import * as vscode from "vscode";
import {
  composeIntoDataViewQuery,
  dataViewAdditions,
} from "../../../packages/rows/src/dataView/additions.js";
import {
  type DataViewAddition,
  type DataViewEdit,
  type DataViewEditability,
  type DataViewProjection,
  type DataViewSource,
  dataViewRelationOwning,
  dataViewSourceTitle,
  EMPTY_DATA_VIEW_EDITABILITY,
} from "../../../packages/rows/src/dataView/dataView.js";
import type {
  DataViewRequest,
  DataViewResponse,
  DataViewState,
} from "../../../packages/rows/src/dataView/dataViewProtocol.js";
import { dataViewState } from "../../../packages/rows/src/dataView/dataViewState.js";
import { HiddenColumns } from "../../../packages/rows/src/dataView/hiddenColumns.js";
import { initialDataViewQuery } from "../../../packages/rows/src/dataView/initialProjection.js";
import { openDataViewResult, TableAccents } from "../../../packages/rows/src/dataView/openRows.js";
import {
  type DataViewWriteHost,
  PendingEdits,
} from "../../../packages/rows/src/dataView/pendingEdits.js";
import { declaredColumnType, heldValues } from "../../../packages/rows/src/dataView/shownValues.js";
import type {
  DataViewExportChoice,
  DataViewExportScope,
} from "../../../packages/rows/src/export.js";
import {
  navigateResult,
  type ResultNavigationCommand,
} from "../../../packages/rows/src/navigation.js";
import { type QueryRewrite, SqlQueryModel } from "../../../packages/sql/src/query/model.js";
import type {
  SqlAuthoringDragPayload,
  SqlAuthoringSnapshot,
} from "../../../packages/sql/src/snapshot.js";
import { quoteSqlIdentifierIfNeeded } from "../../../packages/sql/src/text/identifiers.js";
import type { SqlNotebookResultPayload, SqlResultSession } from "../scratchpad/index.js";
import { completeDataViewFilter } from "./completion/filterCompletion.js";
import { dataViewCompletionUri, dataViewQueryUri } from "./dataViewUri.js";
import { exportAllRows, exportHeldRows, pickExportTarget } from "./export/exportResult.js";
import { type DataViewHostServices, errorMessage } from "./hostServices.js";

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
  private readonly hidden = new HiddenColumns();
  private initialized: Promise<void> | undefined;
  private session: SqlResultSession | undefined;
  private payload: SqlNotebookResultPayload | undefined;
  private editability: DataViewEditability = EMPTY_DATA_VIEW_EDITABILITY;
  private projection: DataViewProjection = { tables: [], columnTable: [] };
  private status: DataViewState["status"] = "loading";
  private message: string | undefined;
  private busy = false;
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

  state(): DataViewState {
    return dataViewState({
      source: this.source,
      serverName: this.serverName(),
      queryUri: this.queryUri.toString(),
      query: this.query,
      hidden: this.hidden,
      editorDirty: this.queryDocument()?.isDirty === true,
      projection: this.projection,
      status: this.status,
      message: this.message,
      payload: this.payload,
      editability: this.editability,
      edits: this.edits,
      busy: this.busy,
    });
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
        const owning = dataViewRelationOwning(this.projection, request.schema, request.name);
        if (!owning) return;
        await this.applyRewrite(
          this.query.relationRemoved(owning.table, owning.ownedOrdinals, tabSize()),
        );
        return;
      }
      case "data-view/hide":
        this.hidden.hide(request.column);
        this.broadcastState();
        return;
      case "data-view/technical-columns":
        this.hidden.hideTechnical(request.hidden);
        this.broadcastState();
        return;
      case "data-view/unhide":
        this.hidden.unhide(request.column);
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
      case "data-view/add-row": {
        const added = this.edits.addRow(this.editability, request.values, request.above);
        if (!added.held) {
          this.notify(added.reason, "info");
          return;
        }
        this.hidden.revealRequired(this.editability);
        this.broadcastState();
        return;
      }
      case "data-view/drop-row":
        this.edits.dropRow(request.localId);
        this.broadcastState();
        return;
      case "data-view/fill-row":
        this.edits.fillRow(request.localId, request.values);
        this.broadcastState();
        return;
      case "data-view/remove-rows": {
        const removal = this.edits.removeRows(request.rows, this.editability);
        if (!removal.held) {
          this.notify(removal.reason, "info");
          return;
        }
        this.broadcastState();
        // Said when the row is taken, not discovered when the transaction fails.
        if (removal.consequences.length > 0) this.notify(removal.consequences.join(" "), "info");
        return;
      }
      case "data-view/copy":
        await vscode.env.clipboard.writeText(request.text);
        return;
      case "data-view/export":
        await this.export(request.choice, request.scope, request.selected);
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
        text: `SELECT * FROM ${quoteSqlIdentifierIfNeeded(this.source.schema)}.${quoteSqlIdentifierIfNeeded(this.source.name)} LIMIT 0`,
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
        this.editability = EMPTY_DATA_VIEW_EDITABILITY;
        this.edits.forget(this.editability);
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
      // The query may have composed away the table a held change was written against.
      const forgotten = this.edits.forget(this.editability);
      if (forgotten) this.notify(forgotten, "info");
      this.hidden.afterLoad(opened, hideKeyColumns());
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

  private async navigate(action: ResultNavigationCommand): Promise<void> {
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
      this.payload = await navigateResult(session, action, (loadedRowCount) =>
        this.broadcast({ type: "data-view/progress", loadedRowCount }),
      );
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
    const held = this.edits.record(edit, this.editability);
    if (!held.held) {
      this.notify(held.reason, "info");
      return;
    }
    const { previous } = held;
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
    await this.edits.apply(this.writeHost, this.editability);
  }

  /** What this surface can do so held changes reach PostgreSQL; the sequence itself is shared. */
  private get writeHost(): DataViewWriteHost {
    return {
      openClient: () => this.services.openClient(this.source.serverId),
      notify: (message, severity) => {
        if (severity === "error") this.log(`apply failed: ${message}`);
        this.notify(message, severity);
      },
      changed: () => this.broadcastState(),
      reload: () => this.load(),
      serverName: () => this.serverName(),
    };
  }

  // --- Export --------------------------------------------------------------------------------

  private async export(
    choice: DataViewExportChoice,
    scope: DataViewExportScope,
    selected: { from: number; to: number; ordinals: number[] } | undefined,
  ): Promise<void> {
    if (!this.payload) return;
    const target = await pickExportTarget(this.title, choice.format, scope);
    if (!target) return;
    try {
      const written =
        scope === "all"
          ? await exportAllRows({
              target,
              choice,
              sql: this.query.effectiveSql(),
              title: this.title,
              openClient: () => this.services.openClient(this.source.serverId),
              typeFor: (name) =>
                declaredColumnType(
                  this.editability,
                  this.payload?.columns ?? [],
                  this.columnOrdinal(name),
                ),
            })
          : await exportHeldRows(target, choice, this.heldValues(scope, selected));
      this.notify(`Exported ${written.toLocaleString("en-US")} rows to ${target.fsPath}`, "info");
    } catch (error) {
      this.notify(`Export failed: ${errorMessage(error)}`, "error");
    }
  }

  /*
   * The rows this document already holds, as the grid shows them: the reader's selection, or every
   * loaded row. The order and the values come from the same place the view previewed them, so a
   * preview and a file cannot disagree.
   */
  private heldValues(
    scope: DataViewExportScope,
    selected: { from: number; to: number; ordinals: number[] } | undefined,
  ) {
    return heldValues({
      payload: this.payload,
      addedRows: this.edits.addedRows,
      editability: this.editability,
      shownOrdinals: () => this.hidden.shownOrdinals(),
      scope,
      ...(selected ? { selected } : {}),
    });
  }

  private columnOrdinal(name: string): number {
    return this.payload?.columns.findIndex((column) => column.name === name) ?? -1;
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

/** Whether a Data View opens with its identity and relationship columns hidden. */
function hideKeyColumns(): boolean {
  return vscode.workspace
    .getConfiguration("postgresql-workbench.dataView")
    .get<boolean>("hideKeyColumns", true);
}
