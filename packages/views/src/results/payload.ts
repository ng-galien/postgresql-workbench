import type { FollowLinkRequest } from "../../../rows/src/followLink.js";
import type { ResultNavigationAction } from "../../../rows/src/navigation.js";
import type {
  ScratchpadAssociationSnapshot,
  SqlNotebookResultPayload,
} from "../../../rows/src/resultPayload.js";

/** What the result renderer and the Extension Host send each other. */

/** The renderer speaks the one navigation vocabulary; `attach` is its first read. */
export type SqlNotebookResultAction = ResultNavigationAction;

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
  | SqlResultDataViewRequest
  /* Following an address a cell holds; the same request every result surface sends. */
  | FollowLinkRequest;

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
