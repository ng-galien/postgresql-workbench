import * as vscode from "vscode";
import type { SqlResultSession } from "../../../packages/rows/src/cursor.js";
import { isFollowLinkRequest } from "../../../packages/rows/src/followLink.js";
import { navigateResult } from "../../../packages/rows/src/navigation.js";
import type {
  ScratchpadAssociationSnapshot,
  SqlNotebookResultPayload,
} from "../../../packages/rows/src/resultPayload.js";
import type {
  SqlNotebookRendererRequest,
  SqlNotebookRendererResponse,
  SqlNotebookResultRequest,
} from "../../../packages/views/src/results/payload.js";
import { followLinkFromView } from "../followLink.js";
import { associationFingerprint, SQL_NOTEBOOK_RENDERER_ID } from "./notebookFile.js";

interface HostedResultSession {
  session: SqlResultSession;
  notebookUri: string;
  cellUri: string;
  associationFingerprint: string;
  idleTimeoutMs: number;
  timer?: ReturnType<typeof setTimeout>;
  busy: boolean;
}

export class SqlNotebookResultHost implements vscode.Disposable {
  private readonly messaging = vscode.notebooks.createRendererMessaging(SQL_NOTEBOOK_RENDERER_ID);
  private readonly sessions = new Map<string, HostedResultSession>();
  private readonly expiringSessions = new Set<string>();
  private readonly subscription: vscode.Disposable;

  constructor() {
    this.subscription = this.messaging.onDidReceiveMessage(({ editor, message }) => {
      if (isFollowLinkRequest(message)) {
        void followLinkFromView(message);
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
    session: SqlResultSession,
    cell: vscode.NotebookCell,
    idleTimeoutMs: number,
    association: ScratchpadAssociationSnapshot,
    isAssociationCurrent: () => boolean = () => true,
  ): Promise<SqlNotebookResultPayload> {
    await this.closeCell(cell.document.uri.toString());
    if (!isAssociationCurrent()) {
      await session.close().catch(() => {});
      throw new Error("The Scratchpad Association changed while the result session was opening.");
    }
    const payload = session.snapshot();
    if (!hasInteractiveNavigation(payload)) {
      await session.close();
      return withoutNavigation(payload);
    }
    const hosted: HostedResultSession = {
      session,
      notebookUri: cell.notebook.uri.toString(),
      cellUri: cell.document.uri.toString(),
      associationFingerprint: associationFingerprint(association),
      idleTimeoutMs,
      busy: false,
    };
    this.sessions.set(session.id, hosted);
    this.touch(hosted);
    return payload;
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
      if (this.expiringSessions.has(request.sessionId)) return;
      await this.post(editor, {
        type: "sql-result/error",
        sessionId: request.sessionId,
        message: "This result session has expired. Run the SQL cell again.",
        closed: true,
      });
      return;
    }
    if (request.action === "cancel") {
      this.sessions.delete(request.sessionId);
      this.clearTimer(hosted);
      await hosted.session.close().catch(() => {});
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
    this.clearTimer(hosted);
    try {
      let payload = await this.applyAction(editor, hosted, request);
      if (!hasInteractiveNavigation(payload)) {
        this.sessions.delete(request.sessionId);
        this.clearTimer(hosted);
        await hosted.session.close();
        payload = withoutNavigation(payload);
      }
      await this.post(editor, {
        type: "sql-result/update",
        sessionId: request.sessionId,
        payload,
      });
    } catch (error) {
      if (!this.sessions.has(request.sessionId)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.sessions.delete(request.sessionId);
      this.clearTimer(hosted);
      await hosted.session.close().catch(() => {});
      await this.post(editor, {
        type: "sql-result/error",
        sessionId: request.sessionId,
        message,
        closed: true,
      });
    } finally {
      hosted.busy = false;
      if (this.sessions.has(request.sessionId)) this.touch(hosted);
    }
  }

  private async applyAction(
    editor: vscode.NotebookEditor,
    hosted: HostedResultSession,
    request: SqlNotebookResultRequest,
  ): Promise<SqlNotebookResultPayload> {
    const progressPosts: Promise<unknown>[] = [];
    const payload = await navigateResult(hosted.session, request.action, (loadedRowCount) => {
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

  private touch(hosted: HostedResultSession): void {
    this.clearTimer(hosted);
    hosted.timer = setTimeout(() => {
      const sessionId = hosted.session.id;
      if (!this.sessions.delete(sessionId)) return;
      this.expiringSessions.add(sessionId);
      void this.expire(hosted);
    }, hosted.idleTimeoutMs);
  }

  private async expire(hosted: HostedResultSession): Promise<void> {
    const sessionId = hosted.session.id;
    const closing = hosted.session.close().catch(() => {});
    const idleSeconds = Math.max(1, Math.round(hosted.idleTimeoutMs / 1_000));
    await Promise.resolve(
      this.messaging.postMessage({
        type: "sql-result/error",
        sessionId,
        message: `This result session expired after ${idleSeconds} seconds without result navigation. Run the SQL cell again.`,
        closed: true,
      } satisfies SqlNotebookRendererResponse),
    ).catch(() => {});
    try {
      await closing;
    } finally {
      this.expiringSessions.delete(sessionId);
    }
  }

  private clearTimer(hosted: HostedResultSession): void {
    if (hosted.timer) clearTimeout(hosted.timer);
    hosted.timer = undefined;
  }

  private async closeMatching(predicate: (hosted: HostedResultSession) => boolean): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const [sessionId, hosted] of this.sessions) {
      if (!predicate(hosted)) continue;
      this.sessions.delete(sessionId);
      this.clearTimer(hosted);
      closing.push(hosted.session.close());
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

/**
 * PostgreSQL is a recovery guard, not the product deadline. Keeping its timeout
 * behind the host deadline prevents both clocks from racing at the same instant.
 */

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
