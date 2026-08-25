import * as vscode from "vscode";
import {
  composeIntoDataViewQuery,
  dataViewAdditions,
} from "../../../packages/rows/src/dataView/additions.js";
import { conditionForCell, withCondition } from "../../../packages/rows/src/dataView/cellFilter.js";
import {
  type DataViewAddition,
  type DataViewEditability,
  type DataViewProjection,
  type DataViewSource,
  dataViewRelationOwning,
  dataViewTitle,
  EMPTY_DATA_VIEW_EDITABILITY,
} from "../../../packages/rows/src/dataView/dataView.js";
import type {
  DataViewRequest,
  DataViewResponse,
  DataViewSqlToken,
  DataViewState,
} from "../../../packages/rows/src/dataView/dataViewProtocol.js";
import { dataViewState } from "../../../packages/rows/src/dataView/dataViewState.js";
import { dataViewFilterProposals } from "../../../packages/rows/src/dataView/filterCompletions.js";
import { filterTokensOf } from "../../../packages/rows/src/dataView/filterTokens.js";
import { HiddenColumns } from "../../../packages/rows/src/dataView/hiddenColumns.js";
import { initialDataViewQuery } from "../../../packages/rows/src/dataView/initialProjection.js";
import { openDataViewResult, TableAccents } from "../../../packages/rows/src/dataView/openRows.js";
import {
  type DataViewMoveContext,
  type DataViewWriteHost,
  isDataViewMove,
  PendingEdits,
} from "../../../packages/rows/src/dataView/pendingEdits.js";
import { declaredColumnType, heldValues } from "../../../packages/rows/src/dataView/shownValues.js";
import type {
  DataViewExportChoice,
  DataViewExportScope,
} from "../../../packages/rows/src/export.js";
import { dataViewExportText } from "../../../packages/rows/src/export.js";
import {
  navigateResult,
  navigationReadsPostgres,
  type ResultNavigationCommand,
} from "../../../packages/rows/src/navigation.js";
import type { OffsetResultSession } from "../../../packages/rows/src/offsetQuery.js";
import type { SqlNotebookResultPayload } from "../../../packages/rows/src/resultPayload.js";
import type { SqlAuthoringClient } from "../../../packages/sql/src/languageServer/client.js";
import { type QueryRewrite, SqlQueryModel } from "../../../packages/sql/src/query/model.js";
import type {
  SqlAuthoringDragPayload,
  SqlAuthoringSnapshot,
} from "../../../packages/sql/src/snapshot.js";
import { quoteSqlIdentifierIfNeeded } from "../../../packages/sql/src/text/identifiers.js";
import { followLinkFromView } from "../followLink.js";
import { configuredScratchpadStatementTimeoutMs } from "../scratchpad/scratchpadSettings.js";
import { DATA_VIEW_SCRATCHES, dataViewQueryUri, dataViewScratchUri } from "./dataViewUri.js";
import { exportAllRows, exportHeldRows, pickExportTarget } from "./exportResult.js";
import { type DataViewHostServices, errorMessage } from "./hostServices.js";

class LoadCancelledError extends Error {}

/**
 * One open Data View. Orchestrates its collaborators — the query text and its rewrites, the
 * bounded paged result, the pending edits — and mirrors their state to the webviews. Every
 * VS Code integration point (query file, editor, completion document) is reached through the
 * injected host services.
 */
export class DataViewDocument implements vscode.CustomDocument {
  readonly source: DataViewSource;
  readonly queryUri: vscode.Uri;
  /** Hidden SQL document that only exists to ask the SQL authoring server for filter completions. */
  private readonly completionUri: vscode.Uri;
  private readonly tokensUri: vscode.Uri;
  private readonly filterTokensUri: vscode.Uri;
  private client?: SqlAuthoringClient;
  private readonly query: SqlQueryModel;
  private readonly edits = new PendingEdits();
  private readonly accents = new TableAccents();
  private readonly hidden = new HiddenColumns();
  private initialized: Promise<void> | undefined;
  private session: OffsetResultSession | undefined;
  private pendingLoadCancel: (() => Promise<void>) | undefined;
  private payload: SqlNotebookResultPayload | undefined;
  private editability: DataViewEditability = EMPTY_DATA_VIEW_EDITABILITY;
  private projection: DataViewProjection = { tables: [], columnTable: [] };
  private status: DataViewState["status"] = "loading";
  private message: string | undefined;
  private busy = false;
  private cancellable = false;
  private loadGeneration = 0;
  private readonly webviews = new Set<vscode.Webview>();
  private readonly _onDidChangeTitle = new vscode.EventEmitter<string>();
  private said = "";
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
    this.completionUri = dataViewScratchUri(source, "completion");
    this.tokensUri = dataViewScratchUri(source, "tokens");
    this.filterTokensUri = dataViewScratchUri(source, "filter-tokens");
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
    return dataViewTitle(this.source, this.projection);
  }

  /** Fires when the query draws from other relations than it did, so a tab can say the new ones. */
  readonly onDidChangeTitle = this._onDidChangeTitle.event;

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
      connectionName: this.connectionName(),
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
      cancellable: this.cancellable,
    });
  }

  /** The grid re-renders when its query editor becomes dirty or clean. */
  refreshQueryState(): void {
    this.broadcastState();
  }

  async handle(request: DataViewRequest): Promise<void> {
    const tabSize = () => this.services.authoringSettings(this.queryUri.toString()).tabSize;
    if (isDataViewMove(request)) {
      this.edits.move(request, this.moveContext);
      return;
    }
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
      case "data-view/inspect": {
        const retained = this.session?.loadedResult();
        const first = Math.max(0, request.page.start - 1);
        const cell = retained?.rows[first + request.row]?.[request.ordinal];
        this.broadcast({
          type: "data-view/inspected",
          requestId: request.requestId,
          ...(cell ? { cell } : {}),
        });
        return;
      }
      case "data-view/export-preview": {
        const values = this.heldValues(request.scope, request.selected);
        this.broadcast({
          type: "data-view/export-preview",
          requestId: request.requestId,
          text: dataViewExportText(values.columns, values.rows.slice(0, 12), {
            ...request.choice,
            finalNewline: false,
          }),
        });
        return;
      }
      case "data-view/sort":
        await this.applyRewrite(this.query.sorted(request.sorts, tabSize()));
        return;
      case "data-view/filter":
        await this.applyRewrite(this.query.filtered(request.text, tabSize()));
        return;
      case "data-view/filter-cell": {
        const written = conditionForCell({
          columns: this.payload?.columns,
          projection: this.projection,
          relations: this.query.analysis?.relations,
          ordinal: request.ordinal,
          value: request.value,
          negate: request.negate,
        });
        if ("refused" in written) {
          this.broadcast({ type: "data-view/notice", message: written.refused, severity: "info" });
          return;
        }
        const where = withCondition(this.query.whereText() ?? "", written.condition);
        await this.applyRewrite(this.query.filtered(where, tabSize()));
        return;
      }
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
          ? await dataViewFilterProposals({
              queryText: this.query.text,
              analysis,
              text: request.text,
              offset: request.offset,
              uri: this.completionUri.toString(),
              ask: this.authoring(),
            })
          : [];
        this.broadcast({ type: "data-view/completions", requestId: request.requestId, items });
        return;
      }
      case "data-view/tokens": {
        const of = request.of;
        this.broadcast({
          type: "data-view/tokens",
          requestId: request.requestId,
          tokens:
            of === "query"
              ? await this.semanticTokensOf(this.tokensUri, this.query.text)
              : await filterTokensOf({
                  queryText: this.query.text,
                  analysis: this.query.analysis,
                  text: of.filter,
                  ask: (sql: string) => this.semanticTokensOf(this.filterTokensUri, sql),
                }),
        });
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
      case "follow-link":
        await followLinkFromView(request);
        return;
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
      this.services.authoringSnapshot(source.connectionId, source.database),
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
    await this.services.associate(this.queryUri.toString(), source.connectionId);
    /*
     * Every scratch document is opened, associated and let go of as a set: a question added to the
     * three is one more entry in the list, and cannot be the one somebody forgets to release.
     */
    for (const scratch of this.scratchUris()) {
      this.services.queryFiles.set(scratch, text);
      await this.services.associate(scratch.toString(), source.connectionId);
    }
  }

  /**
   * What the language server makes of the names in a SQL text, for a view to colour them with.
   *
   * The tokens are asked of a document holding exactly that text, so what a view shows is coloured
   * by the same answer an editor tab would be. The legend comes back from the provider as well: a
   * token number means nothing without it, and the kinds are the connection's to name.
   */
  private async semanticTokensOf(uri: vscode.Uri, sql: string): Promise<DataViewSqlToken[]> {
    return (await this.authoring()?.semanticTokens(uri.toString(), sql)) ?? [];
  }

  /**
   * The client this view asks the language server through, and the one way its documents reach it:
   * a real SQL document the server's own client already watches, holding exactly this text.
   */
  private authoring(): SqlAuthoringClient | undefined {
    this.client ??= this.services.askAuthoring(async (uri, text) => {
      const target = vscode.Uri.parse(uri);
      this.services.queryFiles.set(target, text);
      const document = await vscode.workspace.openTextDocument(target);
      if (document.languageId !== "sql") {
        await vscode.languages.setTextDocumentLanguage(document, "sql");
      }
      const held = document.getText();
      if (held === text) return;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        target,
        new vscode.Range(document.positionAt(0), document.positionAt(held.length)),
        text,
      );
      await vscode.workspace.applyEdit(edit);
    });
    return this.client;
  }

  private scratchUris(): vscode.Uri[] {
    return DATA_VIEW_SCRATCHES.map((purpose) => dataViewScratchUri(this.source, purpose));
  }

  private async relationColumns(): Promise<string[]> {
    if (this.source.kind !== "relation") return [];
    const client = await this.services.openClient(this.source.connectionId);
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
    const snapshot = this.services.authoringSnapshot(
      this.source.connectionId,
      this.source.database,
    );
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

  /** What the query can grow by. The webview asks for exactly this list; so does the showcase. */
  additions() {
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
    if (
      payload.connectionId !== this.source.connectionId ||
      payload.database !== this.source.database
    ) {
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

  // --- Paged result --------------------------------------------------------------------------

  /** (Re)opens the LIMIT/OFFSET result for the current query text. */
  async load(): Promise<void> {
    const generation = ++this.loadGeneration;
    await this.closeSession();
    this.status = "loading";
    this.message = undefined;
    this.busy = true;
    this.cancellable = true;
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
      const opened = await openDataViewResult({
        openClient: () => this.services.openClient(this.source.connectionId),
        sql: this.query.effectiveSql(),
        settings: this.services.resultSettings(),
        binding: {
          connectionId: this.source.connectionId,
          connectionName: this.connectionName(),
          database: this.source.database,
        },
        accents: this.accents,
        orderBy: this.query.orderBy(),
        relationCount: this.query.analysis?.relations.length,
        sourcesAreNamedRelations: this.query.analysis?.fromSourcesAreNamedRelations,
        checkpoint: () => this.assertGeneration(generation),
        registerCancellation: (cancel) => {
          if (generation !== this.loadGeneration || this.disposed) void cancel();
          else this.pendingLoadCancel = cancel;
        },
      });
      this.session = opened.session;
      this.pendingLoadCancel = undefined;
      this.payload = opened.session.snapshot();
      this.editability = opened.editability;
      this.projection = opened.projection;
      // The query may have composed away the table a held change was written against.
      const forgotten = this.edits.forget(this.editability);
      if (forgotten) this.notify(forgotten, "info");
      this.hidden.afterLoad(opened, hideKeyColumns());
      this.status = "ready";
    } catch (error) {
      if (
        generation !== this.loadGeneration ||
        this.disposed ||
        error instanceof LoadCancelledError
      ) {
        return;
      }
      this.status = "error";
      this.message = errorMessage(error);
      this.log(`failed to load: ${this.message}`);
    } finally {
      if (generation === this.loadGeneration) {
        this.pendingLoadCancel = undefined;
        this.busy = false;
        this.cancellable = false;
        this.broadcastState();
      }
    }
  }

  private async navigate(action: ResultNavigationCommand): Promise<void> {
    if (action === "cancel") {
      this.loadGeneration += 1;
      await this.closeSession();
      this.busy = false;
      this.cancellable = false;
      this.message = "Loading cancelled. Refresh to load the rows again.";
      this.broadcastState();
      return;
    }
    const session = this.session;
    const generation = this.loadGeneration;
    if (!session) {
      this.notify("The result is closed. Refresh to load the rows again.", "info");
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.cancellable = navigationReadsPostgres(action, this.payload);
    this.broadcastState();
    try {
      const payload = await navigateResult(session, action, (loadedRowCount) =>
        this.broadcast({ type: "data-view/progress", loadedRowCount }),
      );
      if (this.session !== session) return;
      this.payload = payload;
    } catch (error) {
      if (this.session === session) {
        await this.closeSession();
        if (generation === this.loadGeneration) {
          this.message = `${errorMessage(error)} Refresh to load the rows again.`;
        }
      }
    } finally {
      if (generation === this.loadGeneration) {
        this.busy = false;
        this.cancellable = false;
        this.broadcastState();
      }
    }
  }

  private async closeSession(): Promise<void> {
    const pendingLoadCancel = this.pendingLoadCancel;
    this.pendingLoadCancel = undefined;
    const session = this.session;
    this.session = undefined;
    await Promise.all([pendingLoadCancel?.().catch(() => {}), session?.close().catch(() => {})]);
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.loadGeneration || this.disposed) throw new LoadCancelledError();
  }

  // --- Cell edits ----------------------------------------------------------------------------

  /**
   * What this surface answers a move with. VS Code counts a move as an edit of the document — it is
   * what carries the tab's dirty mark and its undo stack — so it remembers each one, and a move that
   * skipped it would leave the two out of step: a row added without it, then taken back out through
   * the list, leaves the tab dirty over an empty list, asking to save nothing at all. Read afresh
   * each time, because auto save can be turned on while the tab is open.
   */
  private get moveContext(): DataViewMoveContext {
    return {
      editability: this.editability,
      hidden: this.hidden,
      host: {
        notify: (message, severity) => this.notify(message, severity),
        changed: () => this.broadcastState(),
        ...(this.nativeDirtyTracking()
          ? {
              remember: (label: string, undo: () => void, redo: () => void) =>
                this._onDidEdit.fire({ label, undo, redo }),
            }
          : {}),
      },
    };
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
      openClient: () => this.services.openClient(this.source.connectionId),
      notify: (message, severity) => {
        if (severity === "error") this.log(`apply failed: ${message}`);
        this.notify(message, severity);
      },
      changed: () => this.broadcastState(),
      reload: () => this.load(),
      connectionName: () => this.connectionName(),
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
              openClient: () => this.services.openClient(this.source.connectionId),
              maxCellBytes: this.services.resultSettings().maxCellBytes,
              statementTimeoutMs: configuredScratchpadStatementTimeoutMs(),
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
    const retained = this.session?.loadedResult();
    const pageStart = this.payload?.navigation?.pageStart ?? 1;
    const fullPayload =
      this.payload && retained
        ? {
            ...this.payload,
            rows:
              scope === "selection"
                ? retained.rows.slice(
                    Math.max(0, pageStart - 1),
                    Math.max(0, pageStart - 1) + this.payload.rows.length,
                  )
                : retained.rows,
          }
        : this.payload;
    return heldValues({
      payload: fullPayload,
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

  private connectionName(): string {
    return this.services.connectionName(this.source.connectionId) ?? this.source.connectionId;
  }

  private log(line: string): void {
    this.services.output.appendLine(`Data View ${this.title}: ${line}`);
  }

  private notify(message: string, severity: "info" | "error"): void {
    this.broadcast({ type: "data-view/notice", message, severity });
  }

  private broadcastState(): void {
    this.broadcast({ type: "data-view/state", state: this.state() });
    const title = this.title;
    if (title === this.said) return;
    this.said = title;
    this._onDidChangeTitle.fire(title);
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
    void this.services.dissociate(queryUri);
    for (const scratch of this.scratchUris()) {
      this.services.queryFiles.remove(scratch);
      void this.services.dissociate(scratch.toString());
    }
  }
}

/** Whether a Data View opens with its identity and relationship columns hidden. */
function hideKeyColumns(): boolean {
  return vscode.workspace
    .getConfiguration("postgresql-workbench.dataView")
    .get<boolean>("hideKeyColumns", true);
}
