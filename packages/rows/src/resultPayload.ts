import type {
  DebugResult,
  DebugResultEntry,
  DebugResultError,
} from "../../dap/src/debugger/launch/index.js";

/**
 * What a SQL result is: the rows PostgreSQL returned or the error it raised, the Connection they
 * came from, and where the reader stands in a paged result. Produced by the Extension Host, rendered by
 * the result views.
 */

/**
 * What a result view renders: the rows PostgreSQL returned, or the error it raised, plus the
 * Connection they came from. This is the contract the Extension Host must satisfy.
 */
/** The Connection a result came from, as every result surface presents it. */
export interface ResultBinding {
  connectionId: string;
  connectionName: string;
  database: string;
}

/**
 * What it takes to render a result as a table: its columns, its rows, and where the reader stands
 * in them. Every result view shows this much; the debugger output shows only this much.
 */
export interface ResultTable {
  columns: DebugResult["columns"];
  rows: DebugResult["rows"];
  /** Exact total when known. Paged results leave it undefined until the final page. */
  rowCount?: number;
  capturedRowCount: number;
  truncated: boolean;
  truncationReasons: DebugResult["truncationReasons"];
  navigation?: SqlNotebookResultNavigation;
}

interface SqlStatementResultBase {
  version: 3;
  /** Absent when the producer no longer knows the Connection; the view then shows no binding. */
  binding?: ResultBinding;
  durationMs: number;
}

/** A genuine row set returned by PostgreSQL. */
export interface SqlNotebookResultPayload extends SqlStatementResultBase, ResultTable {
  kind: "rowset";
  /** Stable identity of a paged result. */
  resultId?: string;
  /** SQL Statement that produced the result, when the producer knows it. */
  statement?: string;
  command: string;
}

export type SqlCommandReportOperation = "INSERT" | "UPDATE" | "DELETE";

export interface SqlCommandReportEntry {
  operation: SqlCommandReportOperation;
  affectedRows: number;
}

/** Successful DML that produced a command tag rather than a PostgreSQL row set. */
export interface SqlCommandReportPayload extends SqlStatementResultBase {
  kind: "command-report";
  entries: readonly SqlCommandReportEntry[];
}

/** The closed set of successful statement results a Scratchpad can render. */
export type SqlStatementResultPayload = SqlNotebookResultPayload | SqlCommandReportPayload;

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
  hasPrevious: boolean;
  hasNext: boolean;
  canLoadAll: boolean;
}

export type SqlNotebookOutputPayload = SqlStatementResultPayload | SqlNotebookErrorPayload;

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
  /** The Connection the selected result came from, when the host still knows it. */
  selectedBinding?: ResultBinding;
}

/**
 * A rowset as the shared result view renders it. `resultId` is given only when a host answers
 * inspect and export for it — an id on an unhosted payload would draw buttons nobody serves.
 */
export function sqlRowsetPayload(
  result: DebugResult,
  options: { binding?: ResultBinding; statement?: string; resultId?: string } = {},
): SqlNotebookResultPayload {
  const { binding, statement, resultId } = options;
  return {
    version: 3,
    kind: "rowset",
    ...(resultId !== undefined ? { resultId } : {}),
    ...(binding ? { binding } : {}),
    ...(statement !== undefined ? { statement } : {}),
    durationMs: result.durationMs,
    command: result.command,
    columns: result.columns,
    rows: result.rows,
    rowCount: result.rowCount,
    capturedRowCount: result.capturedRowCount,
    truncated: result.truncated,
    truncationReasons: result.truncationReasons,
  };
}

/** An error a surface shows as a result: a title, a message, and whatever PostgreSQL said. */
export function notebookErrorPayload(
  category: SqlNotebookErrorPayload["category"],
  title: string,
  message: string,
): SqlNotebookErrorPayload {
  return { version: 1, type: "error", category, title, message };
}

/** What a failed query tells a reader, however the failure reached the host. */
export type SqlFailure = Pick<
  DebugResultError,
  "message" | "code" | "detail" | "hint" | "position"
>;

/**
 * A failed query as a result view shows it. One conversion, so a failure raised as a thrown
 * object and the same failure carried as a debug result agree on their category, their title,
 * and everything PostgreSQL said — code, detail, hint and position included.
 */
export function sqlFailurePayload(error: SqlFailure, statement?: number): SqlNotebookErrorPayload {
  const isPostgres = Boolean(error.code && /^[0-9A-Z]{5}$/u.test(error.code));
  return {
    ...notebookErrorPayload(
      isPostgres ? "postgresql" : "execution",
      isPostgres ? "PostgreSQL error" : "SQL execution error",
      error.message,
    ),
    ...(statement ? { statement } : {}),
    ...(error.code ? { code: error.code } : {}),
    ...(error.detail ? { detail: error.detail } : {}),
    ...(error.hint ? { hint: error.hint } : {}),
    ...(error.position ? { position: error.position } : {}),
  };
}
