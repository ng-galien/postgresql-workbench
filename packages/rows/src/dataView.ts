import type { DataViewDeleteRule } from "./editability.js";
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
  /** Tables whose foreign keys point at this one, and what PostgreSQL does when a row goes. */
  referencedBy: { table: string; onDelete: DataViewDeleteRule }[];
}

/**
 * What taking a row away drags along with it, said before it is taken rather than discovered when
 * the transaction fails. Empty when nothing points at this table.
 */
export function describeDeleteConsequences(table: {
  referencedBy: readonly { table: string; onDelete: DataViewDeleteRule }[];
}): string[] {
  const byRule = new Map<DataViewDeleteRule, string[]>();
  for (const reference of table.referencedBy) {
    byRule.set(reference.onDelete, [...(byRule.get(reference.onDelete) ?? []), reference.table]);
  }
  const list = (tables: readonly string[]) => [...new Set(tables)].sort().join(", ");
  const said: string[] = [];
  const cascade = byRule.get("cascade");
  if (cascade) said.push(`Rows of ${list(cascade)} that point at it are deleted too.`);
  const cleared = [...(byRule.get("set-null") ?? []), ...(byRule.get("set-default") ?? [])];
  if (cleared.length > 0) said.push(`Rows of ${list(cleared)} keep their place, pointing nowhere.`);
  const blocking = [...(byRule.get("restrict") ?? []), ...(byRule.get("no-action") ?? [])];
  if (blocking.length > 0)
    said.push(`${list(blocking)} may point at it, and PostgreSQL then refuses the deletion.`);
  return said;
}

export interface DataViewEditability {
  tables: DataViewEditableTable[];
  columns: DataViewColumnPolicy[];
  /**
   * Projected columns a new row cannot be written without: not null, no default of their own, and
   * nothing PostgreSQL generates. Adding a row reveals them, because a reader cannot fill in a
   * column they cannot see.
   */
  requiredOrdinals: number[];
  /**
   * Projected columns that identify a row or tie it to another relation. What a reader who does
   * not write SQL has no use for, so they start hidden — a matter of what is worth showing, not
   * of what may be edited.
   */
  technicalOrdinals: number[];
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

/**
 * A whole row the reader took away. It stays in the database, and in the grid struck through,
 * until the changes are applied — a deletion is provisioned like any other change, not done on
 * the spot.
 */
export interface DataViewRowRemoval {
  tableOid: number;
  key: (string | null)[];
}

/**
 * A row the reader added. It exists only in the grid until the changes are applied, which is what
 * lets them fill it column by column — and change their mind — before anything is written.
 */
export interface DataViewRowInsertion {
  tableOid: number;
  /** Tells two new rows apart while neither of them has a key yet. */
  localId: string;
  /** Column name to value, for the columns the reader has filled in. */
  values: Record<string, string | null>;
  /**
   * The loaded row this one sits above, counted as the grid shows them. A reader adds a row where
   * they are looking, so a new row appears just over the row they had selected, and over the first
   * one when they had selected nothing. It is a place in the grid, not in the table: re-sorting the
   * result leaves the row where it sits rather than carrying it about.
   */
  above: number;
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
 * The one relation a Data View writes whole rows to, or why there is none. Cells can be edited
 * over a join; a whole row cannot, because no one table owns it. The reason completes a sentence
 * beginning "Rows can only be added" or "Rows can only be taken away", so the restriction is
 * worded once wherever it is met.
 */
export function dataViewWritableTable(
  editability: DataViewEditability,
): DataViewEditableTable | { reason: string } {
  const table = editability.tables[0];
  if (!table) return { reason: "once the query has a table to write them to." };
  if (editability.tables.length > 1)
    return { reason: "to one table, and this query joins several." };
  return table;
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
export interface DataViewChangeSummary {
  kind: "update" | "delete" | "insert";
  /** `schema.name` of the table the change is written to, when the projection still holds it. */
  table: string;
  /** The row it lands on, by its key: `id = 12`, or `region = 'FR', year = '2026'`. */
  row: string;
  /** What the update replaces with what; a deletion takes the whole row and names no column. */
  column?: string;
  original?: string | null;
  value?: string | null;
}

/**
 * What each provisioned change will do, in the order they will be written. A count alone says how
 * much is waiting but not what it is, and a reader about to write to a database should be able to
 * read the list before they commit to it.
 */
export function describeDataViewChanges(
  edits: readonly DataViewEdit[],
  removals: readonly DataViewRowRemoval[],
  insertions: readonly DataViewRowInsertion[],
  editability: DataViewEditability,
): DataViewChangeSummary[] {
  const describe = (row: { tableOid: number; key: readonly (string | null)[] }) => {
    const table = editability.tables.find((candidate) => candidate.tableOid === row.tableOid);
    return {
      table: table ? `${table.schema}.${table.name}` : "",
      row: row.key
        .map(
          (value, index) =>
            `${table?.keyColumns[index] ?? `key ${index + 1}`} = ${value ?? "NULL"}`,
        )
        .join(", "),
    };
  };
  // In the order they are written: rows away, then cells, then rows added.
  return [
    ...removals.map((removal) => ({ kind: "delete" as const, ...describe(removal) })),
    ...edits.map((edit) => ({
      kind: "update" as const,
      ...describe(edit),
      column: edit.column,
      original: edit.original,
      value: edit.value,
    })),
    ...insertions.map((insertion) => {
      const filled = Object.entries(insertion.values);
      return {
        kind: "insert" as const,
        table: describe({ tableOid: insertion.tableOid, key: [] }).table,
        // A row with nothing filled in is a row of defaults, which is worth saying out loud.
        row:
          filled.length === 0
            ? "every column left to PostgreSQL"
            : filled.map(([column, value]) => `${column} = ${value ?? "NULL"}`).join(", "),
      };
    }),
  ];
}

/**
 * The hidden columns, with every one a new row cannot go without brought back. A reader cannot
 * fill in a column they cannot see, and the identity and relationship columns a Data View hides
 * by default are exactly the ones an insertion tends to need.
 */
export function withRequiredColumnsRevealed(
  hidden: readonly string[],
  editability: DataViewEditability,
  projection: DataViewProjection,
  columnNames: readonly string[],
): string[] {
  const demanded = new Set(
    dataViewKeysAt(dataViewColumnKeys(projection, columnNames), editability.requiredOrdinals),
  );
  return hidden.filter((key) => !demanded.has(key));
}

/** An empty editability: nothing to write to, and nothing worth hiding. */
export const EMPTY_DATA_VIEW_EDITABILITY: DataViewEditability = {
  tables: [],
  columns: [],
  requiredOrdinals: [],
  technicalOrdinals: [],
};

/** The column keys at these ordinals, skipping any the projection no longer holds. */
export function dataViewKeysAt(
  columnKeys: readonly string[],
  ordinals: readonly number[],
): string[] {
  return ordinals.flatMap((ordinal) => {
    const key = columnKeys[ordinal];
    return key === undefined ? [] : [key];
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
