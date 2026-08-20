/**
 * What a Data View is: where its rows come from, how they are projected, sorted, and filtered,
 * which of them can be edited, and what the composition engine may add. The webview renders this
 * and the Extension Host produces it; neither owns it.
 */

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
  /**
   * Heading this addition belongs under when it relates to no table in the query: its schema.
   * A database has more relations than a reader can scan in one list, and the schema is how they
   * already think of them.
   */
  group?: string;
  /** Opaque composition payload, echoed back on selection. */
  payload: unknown;
}

/** Identity of a projected column for visibility: table OID (0 for computed values) and label. */
export function dataViewColumnKey(tableOid: number | undefined, label: string): string {
  return `${tableOid ?? 0}:${label}`;
}

/**
 * The relation a removal names, with the ordinals of the columns it owns — what the query model
 * needs to take it out. Undefined when the projection no longer holds it, which is what a second
 * click on a badge that has already gone looks like.
 */
export function dataViewRelationOwning(
  projection: DataViewProjection,
  schema: string,
  name: string,
): { table: DataViewProjection["tables"][number]; ownedOrdinals: number[] } | undefined {
  const index = projection.tables.findIndex(
    (candidate) => candidate.schema === schema && candidate.name === name,
  );
  const table = projection.tables[index];
  if (!table) return undefined;
  return {
    table,
    ownedOrdinals: projection.columnTable.flatMap((owner, ordinal) =>
      owner === index ? [ordinal] : [],
    ),
  };
}

/** One provisioned change, told the way a reader needs to read it back. */
export interface DataViewEditSummary {
  /** `schema.name` of the table the change is written to, when the projection still holds it. */
  table: string;
  /** The row it lands on, by its key: `id = 12`, or `region = 'FR', year = '2026'`. */
  row: string;
  column: string;
  original: string | null;
  value: string | null;
}

/**
 * What each provisioned change will do, in the order they were made. A count alone says how much
 * is waiting but not what it is, and a reader about to write to a database should be able to read
 * the list before they commit to it.
 */
export function describeDataViewEdits(
  edits: readonly DataViewEdit[],
  editability: DataViewEditability,
): DataViewEditSummary[] {
  return edits.map((edit) => {
    const table = editability.tables.find((candidate) => candidate.tableOid === edit.tableOid);
    return {
      table: table ? `${table.schema}.${table.name}` : "",
      row: edit.key
        .map(
          (value, index) =>
            `${table?.keyColumns[index] ?? `key ${index + 1}`} = ${value ?? "NULL"}`,
        )
        .join(", "),
      column: edit.column,
      original: edit.original,
      value: edit.value,
    };
  });
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
/** Identity of one row of one table: the key values of its projected unique index. */
export function dataViewRowKey(row: { tableOid: number; key: readonly (string | null)[] }): string {
  return `${row.tableOid}:${JSON.stringify(row.key)}`;
}

export function sameDataViewRow(a: DataViewEdit, b: DataViewEdit): boolean {
  return dataViewRowKey(a) === dataViewRowKey(b);
}
