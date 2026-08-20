import { quoteSqlIdentifierIfNeeded } from "../../sql/src/text/identifiers.js";

import type {
  DataViewEdit,
  DataViewEditability,
  DataViewEditableTable,
  DataViewRowInsertion,
  DataViewRowRemoval,
} from "./dataView.js";
import { sameDataViewRow } from "./dataView.js";

export interface DataViewRowUpdate {
  text: string;
  values: (string | null)[];
  /** Human description used in conflict messages: `shop.address (id = 42)`. */
  target: string;
}

/** The table a change is written to, or why it can no longer be written. */
function writableTable(
  editability: DataViewEditability,
  tableOid: number,
  what: string,
): DataViewEditableTable {
  const table = editability.tables.find((candidate) => candidate.tableOid === tableOid);
  if (!table) throw new Error(`The ${what} row no longer belongs to an editable table.`);
  return table;
}

/** `schema.name`, each part quoted only where PostgreSQL needs it. */
function qualifiedName(table: DataViewEditableTable): string {
  return `${quoteSqlIdentifierIfNeeded(table.schema)}.${quoteSqlIdentifierIfNeeded(table.name)}`;
}

/** How a row is named to a reader when a write finds it changed, gone, or ambiguous. */
function rowTarget(table: DataViewEditableTable, key: readonly (string | null)[]): string {
  return `${table.schema}.${table.name} (${table.keyColumns
    .map((column, index) => `${column} = ${key[index] ?? "NULL"}`)
    .join(", ")})`;
}

/**
 * The `WHERE` that picks out exactly one row by its key. A null part of a key is matched, not
 * bound: `= NULL` is never true.
 */
function keyPredicates(
  table: DataViewEditableTable,
  key: readonly (string | null)[],
  bind: (value: string, type: string) => string,
): string[] {
  return table.keyColumns.map((column, index) => {
    const value = key[index] ?? null;
    return value === null
      ? `${quoteSqlIdentifierIfNeeded(column)} IS NULL`
      : `${quoteSqlIdentifierIfNeeded(column)} = ${bind(value, table.keyTypes[index] ?? "text")}`;
  });
}

/**
 * One parameterized UPDATE per edited row. Every value is bound as text and cast to the column
 * type by PostgreSQL, and the original values of the edited columns guard against stale rows.
 */
export function buildRowUpdates(
  edits: readonly DataViewEdit[],
  editability: DataViewEditability,
): DataViewRowUpdate[] {
  const rows: DataViewEdit[][] = [];
  for (const edit of edits) {
    const row = rows.find((group) => group[0] && sameDataViewRow(group[0], edit));
    if (row) row.push(edit);
    else rows.push([edit]);
  }
  return rows.map((rowEdits) => {
    const first = rowEdits[0];
    if (!first) throw new Error("Empty edit group");
    const table = writableTable(editability, first.tableOid, "edited");
    const values: (string | null)[] = [];
    const bind = (value: string | null, type: string) => {
      values.push(value);
      return `$${values.length}::${type}`;
    };
    const assignments = rowEdits.map((edit) => {
      const policy = editability.columns[edit.ordinal];
      if (!policy?.editable) throw new Error(`Column ${edit.column} is not editable.`);
      return `${quoteSqlIdentifierIfNeeded(edit.column)} = ${bind(edit.value, policy.dataType)}`;
    });
    const identity = keyPredicates(table, first.key, bind);
    const guards = rowEdits.map((edit) => {
      const policy = editability.columns[edit.ordinal];
      if (!policy?.editable) throw new Error(`Column ${edit.column} is not editable.`);
      return `${quoteSqlIdentifierIfNeeded(edit.column)} IS NOT DISTINCT FROM ${bind(edit.original, policy.dataType)}`;
    });
    const text = `UPDATE ${qualifiedName(table)}\nSET ${assignments.join(", ")}\nWHERE ${[...identity, ...guards].join("\n  AND ")}`;
    return { text, values, target: rowTarget(table, first.key) };
  });
}

/**
 * One parameterized DELETE per removed row, identified by its key. Unlike an update, which guards
 * the columns it touches against a stale read, a deletion guards only identity: the reader asked
 * for that row to go, whatever it holds now. A row that has already gone leaves no match, and the
 * transaction is rolled back rather than reporting a deletion that did not happen.
 */
export function buildRowDeletes(
  removals: readonly DataViewRowRemoval[],
  editability: DataViewEditability,
): DataViewRowUpdate[] {
  return removals.map((removal) => {
    const table = writableTable(editability, removal.tableOid, "removed");
    const values: (string | null)[] = [];
    const identity = keyPredicates(table, removal.key, (value, type) => {
      values.push(value);
      return `$${values.length}::${type}`;
    });
    return {
      text: `DELETE FROM ${qualifiedName(table)}\nWHERE ${identity.join("\n  AND ")}`,
      values,
      target: rowTarget(table, removal.key),
    };
  });
}

/**
 * One parameterized INSERT per added row, carrying only the columns the reader filled in. What
 * they left alone is left to PostgreSQL: a default, a sequence, or a refusal if the column
 * demands a value. A row they added and never touched is inserted with defaults throughout.
 */
export function buildRowInserts(
  insertions: readonly DataViewRowInsertion[],
  editability: DataViewEditability,
): DataViewRowUpdate[] {
  return insertions.map((insertion) => {
    const table = writableTable(editability, insertion.tableOid, "added");
    const typeOf = (column: string) => {
      const policy = editability.columns.find(
        (candidate) =>
          candidate.editable &&
          candidate.tableOid === insertion.tableOid &&
          candidate.column === column,
      );
      return policy?.editable ? policy.dataType : "text";
    };
    const filled = Object.entries(insertion.values);
    const qualified = qualifiedName(table);
    const target = `${table.schema}.${table.name} (a new row)`;
    if (filled.length === 0) {
      return { text: `INSERT INTO ${qualified} DEFAULT VALUES`, values: [], target };
    }
    const values = filled.map(([, value]) => value);
    const columns = filled.map(([column]) => quoteSqlIdentifierIfNeeded(column)).join(", ");
    const placeholders = filled
      .map(([column], index) => `$${index + 1}::${typeOf(column)}`)
      .join(", ");
    return {
      text: `INSERT INTO ${qualified} (${columns})\nVALUES (${placeholders})`,
      values,
      target,
    };
  });
}
