import type {
  DataViewAddition,
  DataViewCompletion,
  DataViewEdit,
  DataViewEditability,
  DataViewProjection,
  DataViewQueryInfo,
  DataViewRowInsertion,
  DataViewRowRemoval,
  DataViewSort,
  DataViewSource,
} from "../../../rows/src/dataView.js";
import type { ResultNavigationCommand } from "../../../rows/src/navigation.js";
import type { SqlNotebookResultPayload } from "../../../rows/src/resultPayload.js";

/** What the Data View webview and the Extension Host send each other. */

export type DataViewStatus = "loading" | "ready" | "error";

export interface DataViewState {
  source: DataViewSource;
  serverName: string;
  query: DataViewQueryInfo;
  projection: DataViewProjection;
  status: DataViewStatus;
  message?: string;
  payload?: SqlNotebookResultPayload;
  editability: DataViewEditability;
  edits: DataViewEdit[];
  /** Rows the reader took away, still in the database until the changes are applied. */
  removedRows: DataViewRowRemoval[];
  /** Rows the reader added, not in the database until the changes are applied. */
  addedRows: DataViewRowInsertion[];
  busy: boolean;
  applying: boolean;
}

export type DataViewRequest =
  | { type: "data-view/ready" }
  | { type: "data-view/navigate"; action: ResultNavigationCommand }
  | { type: "data-view/refresh" }
  /** Replaces the whole ORDER BY with these grid-column sorts (empty removes it). */
  | { type: "data-view/sort"; sorts: DataViewSort[] }
  | { type: "data-view/reorder"; from: number; to: number }
  /** Moves every column of one table (index in `projection.tables`) before another table's. */
  | { type: "data-view/reorder-table"; from: number; to: number }
  /**
   * Removes one table and everything that referenced it. The table is named, not numbered: the
   * reader can reorder the badges, so a position posted with the click may no longer be the one
   * they pointed at by the time the host reads it.
   */
  | { type: "data-view/remove-table"; schema: string; name: string }
  /** Asks for everything the composition engine can add, grouped by table in the query. */
  | { type: "data-view/additions" }
  /** Composes one addition into the query; `relationChoice` answers a previous choices response. */
  | { type: "data-view/compose"; addition: DataViewAddition; relationChoice?: number }
  | { type: "data-view/hide"; column: string }
  | { type: "data-view/unhide"; column?: string }
  /** Hides or shows every identity and relationship column at once; the host knows which they are. */
  | { type: "data-view/technical-columns"; hidden: boolean }
  | { type: "data-view/filter"; text: string }
  | { type: "data-view/complete"; requestId: number; text: string; offset: number }
  | { type: "data-view/edit-query"; clause?: "select" }
  | { type: "data-view/apply-query" }
  | { type: "data-view/edit"; edit: DataViewEdit }
  /** Takes a whole row away, or puts it back; provisioned like any other change. */
  | { type: "data-view/remove-row"; row: DataViewRowRemoval }
  /** Adds an empty row to fill in; it exists only in the grid until the changes are applied. */
  | { type: "data-view/add-row" }
  | { type: "data-view/drop-row"; localId: string }
  | { type: "data-view/fill-row"; localId: string; column: string; value: string | null }
  | { type: "data-view/discard" }
  | { type: "data-view/apply" }
  | { type: "data-view/copy"; text: string }
  /** A Workbench tree item was dropped on the view: compose it into the query. */
  | { type: "data-view/drop-tree" }
  | { type: "data-view/export"; format: "csv" | "tsv" | "json"; scope: "loaded" | "all" }
  | { type: "data-view/open-sql" };

export type DataViewResponse =
  | { type: "data-view/state"; state: DataViewState }
  | { type: "data-view/additions"; items: DataViewAddition[] }
  /** Several JOIN paths lead to the addition: the user picks one, in the view. */
  | {
      type: "data-view/choices";
      addition: DataViewAddition;
      title: string;
      choices: Array<{ index: number; label: string; description: string }>;
    }
  | { type: "data-view/completions"; requestId: number; items: DataViewCompletion[] }
  | { type: "data-view/progress"; loadedRowCount: number }
  | { type: "data-view/notice"; message: string; severity: "info" | "error" };
