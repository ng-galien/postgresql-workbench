import { createWriteStream } from "node:fs";
import type { Client } from "pg";
import * as vscode from "vscode";
import {
  dataViewExportChunks,
  dataViewExportText,
  type ExportColumn,
} from "../../../packages/rows/src/export.js";
import { isFollowLinkRequest } from "../../../packages/rows/src/followLink.js";
import { navigateResult } from "../../../packages/rows/src/navigation.js";
import type { OffsetResultSession } from "../../../packages/rows/src/offsetQuery.js";
import type {
  ScratchpadAssociationSnapshot,
  SqlNotebookResultPayload,
} from "../../../packages/rows/src/resultPayload.js";
import {
  isSqlResultExportFormat,
  type SqlNotebookRendererRequest,
  type SqlNotebookRendererResponse,
  type SqlNotebookResultRequest,
  type SqlResultExportRequest,
  type SqlResultInspectRequest,
  type SqlResultPreviewRequest,
} from "../../../packages/views/src/results/payload.js";
import { sortedResultRowOrder } from "../../../packages/views/src/results/resultFormatting.js";
import { exportAllRows, pickExportTarget } from "../dataView/exportResult.js";
import { followLinkFromView } from "../followLink.js";
import { associationFingerprint, SQL_NOTEBOOK_RENDERER_ID } from "./notebookFile.js";

interface HostedResultSession {
  resultId: string;
  result: Pick<OffsetResultSession, "loadedResult" | "displayedRows" | "close">;
  paged?: OffsetResultSession;
  notebookUri: string;
  cellUri: string;
  associationFingerprint: string;
  binding: ScratchpadAssociationSnapshot;
  statement?: string;
  maxCellBytes: number;
  statementTimeoutMs?: number;
  busy: boolean;
}

/** A result whose rows are already in memory: nothing is paged and nothing is left open. */
export interface StaticResultRegistration {
  resultId: string;
  payload: SqlNotebookResultPayload;
  /** Retained values at full width; `payload.rows` carries the display projection of the same rows. */
  rows: SqlNotebookResultPayload["rows"];
  cell: vscode.NotebookCell;
  association: ScratchpadAssociationSnapshot;
  /** The SQL that produced it, where running it again is a scope the reader may ask for. */
  statement?: string;
  exportLimits?: { maxCellBytes?: number; statementTimeoutMs?: number };
}

export class SqlNotebookResultHost implements vscode.Disposable {
  private readonly messaging = vscode.notebooks.createRendererMessaging(SQL_NOTEBOOK_RENDERER_ID);
  private readonly sessions = new Map<string, HostedResultSession>();
  private readonly subscription: vscode.Disposable;

  constructor(private readonly openClient?: (connectionId: string) => Promise<Client>) {
    this.subscription = this.messaging.onDidReceiveMessage(({ editor, message }) => {
      if (isFollowLinkRequest(message)) {
        void followLinkFromView(message);
        return;
      }
      if (isExportRequest(message)) {
        void this.export(editor, message);
        return;
      }
      if (isPreviewRequest(message)) {
        void this.preview(editor, message);
        return;
      }
      if (isInspectRequest(message)) {
        void this.inspect(editor, message);
        return;
      }
      if (isOpenSettingsRequest(message)) {
        void vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "@ext:ng-galien.postgresql-workbench postgresql-workbench.sqlAuthoring.syntaxMax",
        );
        return;
      }
      if (isIncreaseTimeoutRequest(message)) {
        void vscode.commands.executeCommand(
          "postgresql-workbench.setScratchpadStatementTimeout",
          editor.notebook,
        );
        return;
      }
      if (!isRendererRequest(message)) return;
      void this.handleRequest(editor, message);
    });
  }

  async register(
    session: OffsetResultSession,
    cell: vscode.NotebookCell,
    association: ScratchpadAssociationSnapshot,
    isAssociationCurrent: () => boolean = () => true,
    exportLimits: { maxCellBytes?: number; statementTimeoutMs?: number } = {},
  ): Promise<SqlNotebookResultPayload> {
    await this.closeCell(cell.document.uri.toString());
    if (!isAssociationCurrent()) {
      await session.close().catch(() => {});
      throw new Error("The Scratchpad Association changed while the result session was opening.");
    }
    const payload = session.snapshot();
    const hosted: HostedResultSession = {
      resultId: session.id,
      result: session,
      paged: session,
      notebookUri: cell.notebook.uri.toString(),
      cellUri: cell.document.uri.toString(),
      associationFingerprint: associationFingerprint(association),
      binding: { ...association },
      ...(payload.statement ? { statement: payload.statement } : {}),
      maxCellBytes: exportLimits.maxCellBytes ?? 256 * 1024,
      ...(exportLimits.statementTimeoutMs !== undefined
        ? { statementTimeoutMs: exportLimits.statementTimeoutMs }
        : {}),
      busy: false,
    };
    this.sessions.set(session.id, hosted);
    return hasInteractiveNavigation(payload) ? payload : withoutNavigation(payload);
  }

  registerStatic(registration: StaticResultRegistration): SqlNotebookResultPayload {
    const {
      resultId,
      payload,
      rows,
      cell,
      association,
      statement,
      exportLimits = {},
    } = registration;
    const result = {
      loadedResult: () => ({ columns: payload.columns, rows }),
      displayedRows: (start: number, length: number) => payload.rows.slice(start, start + length),
      close: async () => {},
    };
    const hosted: HostedResultSession = {
      resultId,
      result,
      notebookUri: cell.notebook.uri.toString(),
      cellUri: cell.document.uri.toString(),
      associationFingerprint: associationFingerprint(association),
      binding: { ...association },
      ...(statement ? { statement } : {}),
      maxCellBytes: exportLimits.maxCellBytes ?? 256 * 1024,
      ...(exportLimits.statementTimeoutMs !== undefined
        ? { statementTimeoutMs: exportLimits.statementTimeoutMs }
        : {}),
      busy: false,
    };
    this.sessions.set(resultId, hosted);
    return { ...payload, resultId, ...(statement ? { statement } : {}) };
  }

  async closeCell(cellUri: string): Promise<void> {
    await this.closeMatching((hosted) => hosted.cellUri === cellUri);
  }

  async closeNotebook(notebookUri: string): Promise<void> {
    await this.closeMatching((hosted) => hosted.notebookUri === notebookUri);
  }

  async closeNotebookAssociationMismatch(
    notebookUri: string,
    association?: ScratchpadAssociationSnapshot,
  ): Promise<void> {
    const fingerprint = association ? associationFingerprint(association) : undefined;
    await this.closeMatching(
      (hosted) =>
        hosted.notebookUri === notebookUri && hosted.associationFingerprint !== fingerprint,
    );
  }

  async closeAll(): Promise<void> {
    await this.closeMatching(() => true);
  }

  private async export(
    _editor: vscode.NotebookEditor,
    request: SqlResultExportRequest,
  ): Promise<void> {
    try {
      const hosted = this.sessions.get(request.resultId);
      if (!hosted) throw new Error("This result is no longer available. Run the SQL cell again.");
      const target = await pickExportTarget(request.title, request.choice.format, request.scope);
      if (!target) return;
      const rowCount =
        request.scope === "all"
          ? await this.exportEntireQuery(hosted, target, request)
          : await this.exportHeld(hosted, target, request);
      void vscode.window.showInformationMessage(
        `Exported ${rowCount.toLocaleString("en-US")} rows to ${target.fsPath}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`Result export failed: ${message}`);
    }
  }

  private async exportHeld(
    hosted: HostedResultSession,
    target: vscode.Uri,
    request: SqlResultExportRequest,
  ): Promise<number> {
    const values =
      request.scope === "loaded"
        ? allHeldValues(hosted, retainedSortFor(request))
        : heldValues(hosted, request);
    const stream = createWriteStream(target.fsPath, { encoding: "utf8" });
    try {
      for (const chunk of dataViewExportChunks(values.columns, values.rows, request.choice)) {
        await writeStreamChunk(stream, chunk);
      }
    } finally {
      await endStream(stream);
    }
    return values.rows.length;
  }

  private async preview(
    editor: vscode.NotebookEditor,
    request: SqlResultPreviewRequest,
  ): Promise<void> {
    const hosted = this.sessions.get(request.resultId);
    if (!hosted) {
      await this.post(editor, {
        type: "sql-result/previewed",
        requestId: request.requestId,
        resultId: request.resultId,
        text: "This result is no longer available. Run the SQL cell again.",
        error: true,
      });
      return;
    }
    try {
      const values =
        request.scope === "selection"
          ? heldValues(hosted, request)
          : allHeldValues(hosted, retainedSortFor(request));
      await this.post(editor, {
        type: "sql-result/previewed",
        requestId: request.requestId,
        resultId: request.resultId,
        text: dataViewExportText(values.columns, values.rows.slice(0, 12), {
          ...request.choice,
          finalNewline: false,
        }),
      });
    } catch (error) {
      await this.post(editor, {
        type: "sql-result/previewed",
        requestId: request.requestId,
        resultId: request.resultId,
        text: error instanceof Error ? error.message : String(error),
        error: true,
      });
    }
  }

  private async exportEntireQuery(
    hosted: HostedResultSession,
    target: vscode.Uri,
    request: SqlResultExportRequest,
  ): Promise<number> {
    if (!hosted.statement) throw new Error("The query text is no longer available.");
    if (!this.openClient) throw new Error("A database connection is unavailable for this export.");
    return exportAllRows({
      target,
      choice: request.choice,
      sql: hosted.statement,
      title: request.title,
      openClient: () => this.openClient?.(hosted.binding.connectionId) as Promise<Client>,
      maxCellBytes: hosted.maxCellBytes,
      ...(hosted.statementTimeoutMs !== undefined
        ? { statementTimeoutMs: hosted.statementTimeoutMs }
        : {}),
    });
  }

  private async inspect(
    editor: vscode.NotebookEditor,
    request: SqlResultInspectRequest,
  ): Promise<void> {
    const hosted = this.sessions.get(request.resultId);
    const retained = hosted?.result.loadedResult();
    const first = Math.max(0, request.page.start - 1);
    let rows = retained?.rows.slice(first, first + request.page.length);
    if (rows && request.sort && hosted) {
      const order = sortedResultRowOrder(
        hosted.result.displayedRows(first, request.page.length),
        request.sort,
      );
      rows = order.map((index) => rows?.[index] ?? []);
    }
    await this.post(editor, {
      type: "sql-result/inspected",
      requestId: request.requestId,
      resultId: request.resultId,
      cell: rows?.[request.row]?.[request.ordinal],
    });
  }

  dispose(): void {
    this.subscription.dispose();
    void this.closeAll();
  }

  private async handleRequest(
    editor: vscode.NotebookEditor,
    request: SqlNotebookResultRequest,
  ): Promise<void> {
    const hosted = this.sessions.get(request.sessionId);
    if (!hosted) {
      await this.post(editor, {
        type: "sql-result/error",
        sessionId: request.sessionId,
        message: "This result is no longer available. Run the SQL cell again.",
        closed: true,
      });
      return;
    }
    if (!hosted.paged) {
      await this.post(editor, {
        type: "sql-result/error",
        sessionId: request.sessionId,
        message: "This result is not paged. Run the SQL cell again to navigate it.",
        closed: true,
      });
      return;
    }
    if (request.action === "cancel") {
      await hosted.result.close().catch(() => {});
      hosted.paged = undefined;
      await this.post(editor, {
        type: "sql-result/error",
        sessionId: request.sessionId,
        message: "Result loading cancelled.",
        closed: true,
      });
      return;
    }
    if (hosted.busy) {
      await this.post(editor, {
        type: "sql-result/error",
        sessionId: request.sessionId,
        message: "A result operation is already running.",
        closed: false,
      });
      return;
    }

    hosted.busy = true;
    try {
      const paged = hosted.paged;
      let payload = await this.applyAction(editor, hosted, request);
      if (hosted.paged !== paged) return;
      if (!hasInteractiveNavigation(payload)) {
        payload = withoutNavigation(payload);
      }
      await this.post(editor, {
        type: "sql-result/update",
        sessionId: request.sessionId,
        payload,
      });
    } catch (error) {
      if (!this.sessions.has(request.sessionId)) return;
      if (!hosted.paged) return;
      const message = error instanceof Error ? error.message : String(error);
      await hosted.result.close().catch(() => {});
      hosted.paged = undefined;
      await this.post(editor, {
        type: "sql-result/error",
        sessionId: request.sessionId,
        message,
        closed: true,
      });
    } finally {
      hosted.busy = false;
    }
  }

  private async applyAction(
    editor: vscode.NotebookEditor,
    hosted: HostedResultSession,
    request: SqlNotebookResultRequest,
  ): Promise<SqlNotebookResultPayload> {
    const progressPosts: Promise<unknown>[] = [];
    if (!hosted.paged) throw new Error("This result is not paged.");
    const payload = await navigateResult(hosted.paged, request.action, (loadedRowCount) => {
      progressPosts.push(
        Promise.resolve(
          this.post(editor, {
            type: "sql-result/progress",
            sessionId: request.sessionId,
            loadedRowCount,
          }),
        ),
      );
    });
    await Promise.allSettled(progressPosts);
    return payload;
  }

  private async closeMatching(predicate: (hosted: HostedResultSession) => boolean): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const [sessionId, hosted] of this.sessions) {
      if (!predicate(hosted)) continue;
      this.sessions.delete(sessionId);
      closing.push(hosted.result.close());
    }
    await Promise.allSettled(closing);
  }

  private post(
    editor: vscode.NotebookEditor,
    response: SqlNotebookRendererResponse,
  ): Thenable<boolean> {
    return this.messaging.postMessage(response, editor);
  }
}

/** Whether a result still has a page to move to, and so a navigation the reader can act on. */
function hasInteractiveNavigation(payload: SqlNotebookResultPayload): boolean {
  const navigation = payload.navigation;
  return Boolean(
    navigation && (navigation.hasPrevious || navigation.hasNext || navigation.canLoadAll),
  );
}

function withoutNavigation(payload: SqlNotebookResultPayload): SqlNotebookResultPayload {
  const { navigation: _navigation, ...result } = payload;
  return result;
}

function isRendererRequest(value: unknown): value is SqlNotebookResultRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Partial<SqlNotebookRendererRequest>;
  return (
    message.type === "sql-result/request" &&
    typeof message.sessionId === "string" &&
    (message.action === "attach" ||
      message.action === "previous" ||
      message.action === "next" ||
      message.action === "load-all" ||
      message.action === "cancel")
  );
}

function isInspectRequest(value: unknown): value is SqlResultInspectRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Partial<SqlResultInspectRequest>;
  return (
    message.type === "sql-result/inspect" &&
    typeof message.requestId === "string" &&
    typeof message.resultId === "string" &&
    isExportPage(message.page) &&
    Number.isInteger(message.row) &&
    Number(message.row) >= 0 &&
    Number.isInteger(message.ordinal) &&
    Number(message.ordinal) >= 0 &&
    isOptionalSort(message.sort)
  );
}

function isExportRequest(value: unknown): value is SqlResultExportRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Partial<SqlResultExportRequest>;
  return (
    message.type === "sql-result/export" &&
    typeof message.resultId === "string" &&
    typeof message.title === "string" &&
    isExportChoice(message.choice) &&
    (message.scope === "selection" || message.scope === "loaded" || message.scope === "all") &&
    (message.scope === "all" || isExportPage(message.page)) &&
    (message.scope !== "selection" || isExportSelection(message.selection)) &&
    isOptionalSort(message.sort)
  );
}

function isPreviewRequest(value: unknown): value is SqlResultPreviewRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Partial<SqlResultPreviewRequest>;
  return (
    message.type === "sql-result/preview" &&
    Number.isInteger(message.requestId) &&
    typeof message.resultId === "string" &&
    isExportChoice(message.choice) &&
    (message.scope === "selection" || message.scope === "loaded" || message.scope === "all") &&
    (message.scope === "all" || isExportPage(message.page)) &&
    (message.scope !== "selection" || isExportSelection(message.selection)) &&
    isOptionalSort(message.sort)
  );
}

type HeldRequest = Pick<SqlResultExportRequest, "scope" | "page" | "selection" | "sort">;

/**
 * The sort a scope carries into the retained rows. Sorting a column is local to the result, so the
 * rows loaded answer in the order the reader put them in. The entire query does not: it runs the
 * statement again, and a re-run carries no local sort, so promising one would describe another file.
 */
function retainedSortFor(request: HeldRequest): HeldRequest["sort"] {
  return request.scope === "loaded" ? request.sort : undefined;
}

/**
 * Every retained row, in the order the reader put them in. A column sort is local to the result,
 * so it orders the whole retained set here and not only the page it was applied on.
 */
function allHeldValues(
  hosted: HostedResultSession,
  sort: HeldRequest["sort"],
): {
  columns: ExportColumn[];
  rows: (string | null)[][];
} {
  const retained = hosted.result.loadedResult();
  let rows = retained.rows;
  if (sort) {
    if (sort.columnIndex >= retained.columns.length) {
      throw new Error("The result sort column is outside the retained columns.");
    }
    const order = sortedResultRowOrder(hosted.result.displayedRows(0, rows.length), sort);
    rows = order.map((index) => rows[index] ?? []);
  }
  return {
    columns: retained.columns.map((column) => ({
      name: column.name,
      ...(column.typeName ? { type: column.typeName } : {}),
    })),
    rows: rows.map((row) => row.map((cell) => cell.value)),
  };
}

function heldValues(
  hosted: HostedResultSession,
  request: HeldRequest,
): { columns: ExportColumn[]; rows: (string | null)[][] } {
  if (!request.page) throw new Error("The displayed result page is missing.");
  const retained = hosted.result.loadedResult();
  if (
    request.page.start < 1 ||
    request.page.start - 1 + request.page.length > retained.rows.length
  ) {
    throw new Error("The displayed result page is outside the retained rows.");
  }
  const first = request.page.start - 1;
  let rows = retained.rows.slice(first, first + request.page.length);
  if (request.sort) {
    if (request.sort.columnIndex >= retained.columns.length) {
      throw new Error("The result sort column is outside the retained columns.");
    }
    const order = sortedResultRowOrder(
      hosted.result.displayedRows(first, request.page.length),
      request.sort,
    );
    rows = order.map((index) => rows[index] ?? []);
  }
  const selection = request.scope === "selection" ? request.selection : undefined;
  if (request.scope === "selection" && !selection) {
    throw new Error("The selected result rows are missing.");
  }
  if (selection) {
    if (selection.to >= rows.length)
      throw new Error("The selected result rows are outside the page.");
    rows = rows.slice(selection.from, selection.to + 1);
  }
  const ordinals = selection?.ordinals ?? retained.columns.map((_column, ordinal) => ordinal);
  if (
    new Set(ordinals).size !== ordinals.length ||
    ordinals.some((ordinal) => ordinal >= retained.columns.length)
  ) {
    throw new Error("The selected result columns are invalid.");
  }
  const columns = ordinals.map((ordinal) => {
    const column = retained.columns[ordinal];
    if (!column) throw new Error("The selected result column is missing.");
    return { name: column.name, ...(column.typeName ? { type: column.typeName } : {}) };
  });
  return {
    columns,
    rows: rows.map((row) => ordinals.map((ordinal) => row[ordinal]?.value ?? null)),
  };
}

function isOptionalSort(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const sort = value as { columnIndex?: unknown; direction?: unknown };
  return (
    Number.isInteger(sort.columnIndex) &&
    Number(sort.columnIndex) >= 0 &&
    (sort.direction === "ascending" || sort.direction === "descending")
  );
}

function isExportChoice(value: unknown): value is SqlResultExportRequest["choice"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const choice = value as Partial<SqlResultExportRequest["choice"]>;
  return (
    isSqlResultExportFormat(choice.format) &&
    typeof choice.header === "boolean" &&
    (choice.nullAs === "empty" || choice.nullAs === "null" || choice.nullAs === "backslash-n") &&
    typeof choice.delimiter === "string" &&
    typeof choice.createTable === "boolean" &&
    typeof choice.spreadsheetSafe === "boolean" &&
    typeof choice.finalNewline === "boolean"
  );
}

function isExportPage(value: unknown): value is NonNullable<SqlResultExportRequest["page"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const page = value as { start?: unknown; length?: unknown };
  return (
    Number.isInteger(page.start) &&
    Number(page.start) >= 0 &&
    Number.isInteger(page.length) &&
    Number(page.length) >= 0
  );
}

function isExportSelection(
  value: unknown,
): value is NonNullable<SqlResultExportRequest["selection"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const selection = value as { from?: unknown; to?: unknown; ordinals?: unknown };
  return (
    Number.isInteger(selection.from) &&
    Number(selection.from) >= 0 &&
    Number.isInteger(selection.to) &&
    Number(selection.to) >= Number(selection.from) &&
    Array.isArray(selection.ordinals) &&
    selection.ordinals.every((ordinal) => Number.isInteger(ordinal) && ordinal >= 0)
  );
}

function writeStreamChunk(
  stream: ReturnType<typeof createWriteStream>,
  chunk: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

function endStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolve) => stream.end(resolve));
}

function isOpenSettingsRequest(value: unknown): boolean {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Partial<SqlNotebookRendererRequest>).type === "sql-error/open-analysis-settings"
  );
}

function isIncreaseTimeoutRequest(value: unknown): boolean {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Partial<SqlNotebookRendererRequest>).type === "sql-error/increase-scratchpad-timeout"
  );
}
