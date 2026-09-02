import type { Client } from "pg";
import * as vscode from "vscode";
import { isFollowLinkRequest } from "../../../packages/rows/src/followLink.js";
import { navigateResult } from "../../../packages/rows/src/navigation.js";
import type { OffsetResultSession } from "../../../packages/rows/src/offsetQuery.js";
import type {
  ResultBinding,
  SqlNotebookResultPayload,
} from "../../../packages/rows/src/resultPayload.js";
import {
  associationFingerprint,
  SQL_NOTEBOOK_RENDERER_ID,
} from "../../../packages/scratchpad/src/notebookFile.js";
import {
  inspectedResponse,
  isSqlResultExportRequest,
  isSqlResultIncreaseTimeoutRequest,
  isSqlResultInspectRequest,
  isSqlResultOpenSettingsRequest,
  isSqlResultPreviewRequest,
  previewedResponse,
} from "../../../packages/views/src/results/heldResult.js";
import type {
  SqlNotebookRendererRequest,
  SqlNotebookRendererResponse,
  SqlNotebookResultRequest,
  SqlResultExportRequest,
  SqlResultInspectRequest,
  SqlResultPreviewRequest,
} from "../../../packages/views/src/results/payload.js";
import { exportAllRows } from "../dataView/exportResult.js";
import { followLinkFromView } from "../followLink.js";
import { answerExport } from "../results/heldResult.js";

interface HostedResultSession {
  resultId: string;
  result: Pick<OffsetResultSession, "loadedResult" | "displayedRows" | "close">;
  paged?: OffsetResultSession;
  notebookUri: string;
  cellUri: string;
  associationFingerprint: string;
  binding: ResultBinding;
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
  association: ResultBinding;
  /** The SQL that produced it, where running it again is a scope the reader may ask for. */
  statement?: string;
  exportLimits?: { maxCellBytes?: number; statementTimeoutMs?: number };
}

const MISSING_RESULT = "This result is no longer available. Run the SQL cell again.";

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
      if (isSqlResultExportRequest(message)) {
        void this.export(editor, message);
        return;
      }
      if (isSqlResultPreviewRequest(message)) {
        void this.preview(editor, message);
        return;
      }
      if (isSqlResultInspectRequest(message)) {
        void this.inspect(editor, message);
        return;
      }
      if (isSqlResultOpenSettingsRequest(message)) {
        void vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "@ext:ng-galien.postgresql-workbench postgresql-workbench.sqlAuthoring.syntaxMax",
        );
        return;
      }
      if (isSqlResultIncreaseTimeoutRequest(message)) {
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
    association: ResultBinding,
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
    association?: ResultBinding,
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

  private export(_editor: vscode.NotebookEditor, request: SqlResultExportRequest): Promise<void> {
    const hosted = this.sessions.get(request.resultId);
    return answerExport(request, hosted?.result, {
      missingMessage: MISSING_RESULT,
      ...(hosted
        ? { exportEntireQuery: (target) => this.exportEntireQuery(hosted, target, request) }
        : {}),
    });
  }

  private async preview(
    editor: vscode.NotebookEditor,
    request: SqlResultPreviewRequest,
  ): Promise<void> {
    const hosted = this.sessions.get(request.resultId);
    await this.post(editor, previewedResponse(hosted?.result, request, MISSING_RESULT));
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
    await this.post(editor, inspectedResponse(hosted?.result, request));
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
