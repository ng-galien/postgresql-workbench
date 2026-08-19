import type { DebugResult, DebugResultEntry } from "../../dap/src/debugger/launch/index.js";

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

/**
 * What it takes to render a result as a table: its columns, its rows, and where the reader stands
 * in them. Every result view shows this much; the debugger output shows only this much.
 */
export interface ResultTable {
  columns: DebugResult["columns"];
  rows: DebugResult["rows"];
  /** Exact total when known. Cursor-backed results leave it undefined until exhausted. */
  rowCount?: number;
  capturedRowCount: number;
  truncated: boolean;
  truncationReasons: DebugResult["truncationReasons"];
  navigation?: SqlNotebookResultNavigation;
}

export interface SqlNotebookResultPayload extends ResultTable {
  version: 2;
  binding: ScratchpadAssociationSnapshot;
  /** SQL Statement that produced the result, when the producer knows it. */
  statement?: string;
  command: string;
  durationMs: number;
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

/** One captured debug result as a history lists it: enough to name it and to say how it ended. */
export interface DebugResultSummary {
  id: string;
  status: "pending" | "success" | "error";
  label: string;
  query: string;
  command: string;
  rowCount: number;
  columnCount: number;
  capturedRowCount: number;
  truncated: boolean;
  durationMs: number;
  timestamp: string;
  message?: string;
  connection?: string;
}

export interface DebugResultViewState {
  results: DebugResultSummary[];
  selected?: DebugResultEntry;
}
