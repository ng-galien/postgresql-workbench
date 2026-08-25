import type { DebugResultCell } from "../../../dap/src/debugger/launch/index.js";
import type { DataViewExportChoice, DataViewExportScope } from "../../../rows/src/export.js";
import type { FollowLinkRequest } from "../../../rows/src/followLink.js";
import type { ResultNavigationAction } from "../../../rows/src/navigation.js";
import type { SqlNotebookResultPayload } from "../../../rows/src/resultPayload.js";

/** What the result renderer and the Extension Host send each other. */

/** The renderer speaks the one navigation vocabulary; `attach` is its first read. */
export type SqlNotebookResultAction = ResultNavigationAction;

export interface SqlNotebookResultRequest {
  type: "sql-result/request";
  sessionId: string;
  action: SqlNotebookResultAction;
}

/** A renderer has shaped rows it already holds and asks the Extension Host where to write them. */
export const SQL_RESULT_EXPORT_FORMATS = ["csv", "tsv", "json", "markdown"] as const;
export type SqlResultExportFormat = (typeof SQL_RESULT_EXPORT_FORMATS)[number];

export function isSqlResultExportFormat(value: unknown): value is SqlResultExportFormat {
  return SQL_RESULT_EXPORT_FORMATS.some((format) => format === value);
}

export interface SqlResultExportRequest {
  type: "sql-result/export";
  resultId: string;
  title: string;
  choice: Omit<DataViewExportChoice, "format" | "table"> & { format: SqlResultExportFormat };
  scope: DataViewExportScope;
  /** The displayed page whose full retained values Selection and Loaded rows address. */
  page?: { start: number; length: number };
  /** Inclusive positions within the locally sorted displayed page. */
  selection?: { from: number; to: number; ordinals: number[] };
  /** Loaded-row sorting is local to the result and must also order its full retained values. */
  sort?: { columnIndex: number; direction: "ascending" | "descending" };
}

export interface SqlResultPreviewRequest extends Omit<SqlResultExportRequest, "type" | "title"> {
  type: "sql-result/preview";
  requestId: number;
}

export interface SqlResultInspectRequest {
  type: "sql-result/inspect";
  requestId: string;
  resultId: string;
  page: { start: number; length: number };
  row: number;
  ordinal: number;
  sort?: { columnIndex: number; direction: "ascending" | "descending" };
}

export type SqlNotebookSettingsRequest =
  | { type: "sql-error/open-analysis-settings" }
  | { type: "sql-error/increase-scratchpad-timeout" };

export type SqlNotebookRendererRequest =
  | SqlNotebookResultRequest
  | SqlResultExportRequest
  | SqlResultPreviewRequest
  | SqlResultInspectRequest
  | SqlNotebookSettingsRequest
  /* Following an address a cell holds; the same request every result surface sends. */
  | FollowLinkRequest;

export type SqlNotebookRendererResponse =
  | {
      type: "sql-result/previewed";
      requestId: number;
      resultId: string;
      text: string;
      error?: true;
    }
  | {
      type: "sql-result/inspected";
      requestId: string;
      resultId: string;
      cell?: DebugResultCell;
    }
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
