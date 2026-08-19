import type { DebugResult } from "../../dap/src/debugger/launch/index.js";

/**
 * What a SQL result is: the rows PostgreSQL returned or the error it raised, the Connexion they
 * came from, and where the reader stands in a cursor. Produced by the Extension Host, rendered by
 * the result views.
 */

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
