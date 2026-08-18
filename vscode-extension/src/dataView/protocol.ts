import type { SqlNotebookResultPayload } from "../sqlNotebookModel.js";

/** Where the rows of a Data View come from. The Connexion Association never changes implicitly. */
export type DataViewSource =
  | {
      kind: "relation";
      serverId: string;
      database: string;
      schema: string;
      name: string;
      relationKind: "table" | "view" | "materialized-view";
    }
  | {
      kind: "sql";
      serverId: string;
      database: string;
      sql: string;
      /** Short label for the tab title. */
      label: string;
    };

export type DataViewSortDirection = "ascending" | "descending";

export interface DataViewSort {
  column: string;
  direction: DataViewSortDirection;
}

/** How a Data View column can be edited; derived from the projection and the catalog. */
export type DataViewValueEditor =
  | "text"
  | "number"
  | "boolean"
  | "json"
  | "date"
  | "time"
  | "timestamp";

export type DataViewColumnPolicy =
  | {
      editable: true;
      tableOid: number;
      column: string;
      dataType: string;
      editor: DataViewValueEditor;
    }
  | { editable: false; reason: string };

export interface DataViewEditableTable {
  tableOid: number;
  schema: string;
  name: string;
  /** Ordinals of the projected columns forming the row identity, in key order. */
  keyOrdinals: number[];
  keyColumns: string[];
  keyTypes: string[];
}

export interface DataViewEditability {
  tables: DataViewEditableTable[];
  columns: DataViewColumnPolicy[];
}

/** One local, unapplied change identified by the row it targets. */
export interface DataViewEdit {
  tableOid: number;
  key: (string | null)[];
  ordinal: number;
  column: string;
  original: string | null;
  value: string | null;
}

export type DataViewStatus = "loading" | "ready" | "error";

/** The SQL document behind a Data View and what the grid derived from it. */
export interface DataViewQueryInfo {
  /** URI of the writable SQL document (open it for completion, formatting, and free edits). */
  uri: string;
  /** Query text currently loaded in the grid. */
  text: string;
  /** WHERE expression of the loaded query, if any. */
  whereText?: string;
  /** ORDER BY items as written in the query, in order; `column` is set when it is a grid column. */
  orderBy: { text: string; direction: DataViewSortDirection; column?: string }[];
  /** Column keys (see dataViewColumnKey) hidden in the grid; they stay projected so rows remain identified. */
  hidden: string[];
  /** False when the query could not be analyzed: grid actions that rewrite SQL are disabled. */
  structured: boolean;
  problem?: string;
  /** An editor holds unsaved changes to the query. */
  editorDirty: boolean;
}

/** Which stored table each projected column comes from, for badges and column accents. */
export interface DataViewProjection {
  /** `accent` is a stable palette index per table for the life of the view. */
  tables: { tableOid: number; schema: string; name: string; accent: number }[];
  /** Per projected column, the index in `tables` (undefined for computed values). */
  columnTable: (number | undefined)[];
}

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
  busy: boolean;
  applying: boolean;
}

export type DataViewRequest =
  | { type: "data-view/ready" }
  | { type: "data-view/navigate"; action: "previous" | "next" | "load-all" | "cancel" }
  | { type: "data-view/refresh" }
  /** Replaces the whole ORDER BY with these grid-column sorts (empty removes it). */
  | { type: "data-view/sort"; sorts: DataViewSort[] }
  | { type: "data-view/reorder"; from: number; to: number }
  /** Moves every column of one table (index in `projection.tables`) before another table's. */
  | { type: "data-view/reorder-table"; from: number; to: number }
  /** Removes one table (index in `projection.tables`) and everything that referenced it. */
  | { type: "data-view/remove-table"; tableIndex: number }
  /** Asks for everything the composition engine can add, grouped by table in the query. */
  | { type: "data-view/additions" }
  /** Composes one addition into the query; `relationChoice` answers a previous choices response. */
  | { type: "data-view/compose"; addition: DataViewAddition; relationChoice?: number }
  | { type: "data-view/hide"; column: string }
  | { type: "data-view/unhide"; column?: string }
  | { type: "data-view/filter"; text: string }
  | { type: "data-view/complete"; requestId: number; text: string; offset: number }
  | { type: "data-view/edit-query"; clause?: "select" }
  | { type: "data-view/apply-query" }
  | { type: "data-view/edit"; edit: DataViewEdit }
  | { type: "data-view/discard" }
  | { type: "data-view/apply" }
  | { type: "data-view/copy"; text: string }
  /** A Workbench tree item was dropped on the view: compose it into the query. */
  | { type: "data-view/drop-tree" }
  | { type: "data-view/export"; format: "csv" | "tsv" | "json"; scope: "loaded" | "all" }
  | { type: "data-view/open-sql" };

/** One completion proposal for the filter input, computed by the SQL authoring server. */
export interface DataViewCompletion {
  label: string;
  insertText: string;
  detail?: string;
  kind?: string;
  /** Characters before the caret that the insertion replaces. */
  replaceLength: number;
}

/** One thing the composition engine can add to the query. */
export interface DataViewAddition {
  /** Index in `projection.tables` of the table it relates to. */
  tableIndex: number;
  kind: "column" | "table";
  label: string;
  detail: string;
  /** Opaque composition payload, echoed back on selection. */
  payload: unknown;
}

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

/** Identity of a projected column for visibility: table OID (0 for computed values) and label. */
export function dataViewColumnKey(tableOid: number | undefined, label: string): string {
  return `${tableOid ?? 0}:${label}`;
}

/** Column keys of a projection, in ordinal order. */
export function dataViewColumnKeys(
  projection: DataViewProjection,
  columnNames: readonly string[],
): string[] {
  return columnNames.map((name, ordinal) => {
    const index = projection.columnTable[ordinal];
    return dataViewColumnKey(
      index === undefined ? undefined : projection.tables[index]?.tableOid,
      name,
    );
  });
}

export function dataViewSourceTitle(source: DataViewSource): string {
  return source.kind === "relation" ? `${source.schema}.${source.name}` : source.label;
}

/** Same stored row: same table and same identity values. */
export function sameDataViewRow(a: DataViewEdit, b: DataViewEdit): boolean {
  return (
    a.tableOid === b.tableOid &&
    a.key.length === b.key.length &&
    a.key.every((value, index) => value === b.key[index])
  );
}
