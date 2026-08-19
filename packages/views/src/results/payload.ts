import type { DebugResult } from "../../../dap/src/debugger/launch/index.js";

/**
 * What a result view renders: the rows PostgreSQL returned, or the error it raised, plus the
 * Connection they came from. This is the contract the Extension Host must satisfy.
 */
export interface ScratchpadAssociationSnapshot {
  serverId: string;
  serverName: string;
  database: string;
}

export interface SqlNotebookResultPayload {
  version: 2;
  binding: ScratchpadAssociationSnapshot;
  /** SQL Statement that produced the result, when the producer knows it. */
  statement?: string;
  command: string;
  columns: DebugResult["columns"];
  rows: DebugResult["rows"];
  /** Exact total when known. Cursor-backed results leave it undefined until exhausted. */
  rowCount?: number;
  capturedRowCount: number;
  durationMs: number;
  truncated: boolean;
  truncationReasons: DebugResult["truncationReasons"];
  navigation?: SqlNotebookResultNavigation;
}

export interface SqlNotebookErrorPayload {
  version: 1;
  type: "error";
  title: string;
  message: string;
  category: "syntax" | "postgresql" | "connection" | "execution";
  statement?: number;
  code?: string;
  detail?: string;
  hint?: string;
  line?: number;
  column?: number;
  position?: string;
  action?: {
    type: "open-sql-analysis-settings" | "increase-scratchpad-timeout";
    label: string;
  };
}

export interface SqlNotebookResultNavigation {
  sessionId: string;
  mode: "paged" | "all";
  pageIndex: number;
  pageSize: number;
  pageStart: number;
  pageEnd: number;
  loadedRowCount: number;
  cacheStart: number;
  hasPrevious: boolean;
  hasNext: boolean;
  canLoadAll: boolean;
}

export type SqlNotebookOutputPayload = SqlNotebookResultPayload | SqlNotebookErrorPayload;

export type SqlNotebookResultAction = "attach" | "previous" | "next" | "load-all" | "cancel";

export interface SqlNotebookResultRequest {
  type: "sql-result/request";
  sessionId: string;
  action: SqlNotebookResultAction;
}

export type SqlNotebookSettingsRequest =
  | { type: "sql-error/open-analysis-settings" }
  | { type: "sql-error/increase-scratchpad-timeout" };

export interface SqlResultDataViewRequest {
  type: "sql-result/open-data-view";
  sql: string;
  binding: ScratchpadAssociationSnapshot;
}

export type SqlNotebookRendererRequest =
  | SqlNotebookResultRequest
  | SqlNotebookSettingsRequest
  | SqlResultDataViewRequest;

export type SqlNotebookRendererResponse =
  | {
      type: "sql-result/update";
      sessionId: string;
      payload: SqlNotebookResultPayload;
    }
  | {
      type: "sql-result/progress";
      sessionId: string;
      loadedRowCount: number;
    }
  | {
      type: "sql-result/error";
      sessionId: string;
      message: string;
      closed: boolean;
    };
