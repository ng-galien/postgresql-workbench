import { quoteIdentifier } from "../../../packages/sql/src/authoring/completion.js";

import type {
  DataViewEdit,
  DataViewEditability,
} from "../../../packages/views/src/dataView/protocol.js";
import { sameDataViewRow } from "../../../packages/views/src/dataView/protocol.js";

export interface DataViewRowUpdate {
  text: string;
  values: (string | null)[];
  /** Human description used in conflict messages: `shop.address (id = 42)`. */
  target: string;
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
    const table = editability.tables.find((candidate) => candidate.tableOid === first.tableOid);
    if (!table) throw new Error("The edited row no longer belongs to an editable table.");
    const values: (string | null)[] = [];
    const bind = (value: string | null, type: string) => {
      values.push(value);
      return `$${values.length}::${type}`;
    };
    const assignments = rowEdits.map((edit) => {
      const policy = editability.columns[edit.ordinal];
      if (!policy?.editable) throw new Error(`Column ${edit.column} is not editable.`);
      return `${quoteIdentifier(edit.column)} = ${bind(edit.value, policy.dataType)}`;
    });
    const identity = table.keyColumns.map((column, index) => {
      const value = first.key[index] ?? null;
      const type = table.keyTypes[index] ?? "text";
      return value === null
        ? `${quoteIdentifier(column)} IS NULL`
        : `${quoteIdentifier(column)} = ${bind(value, type)}`;
    });
    const guards = rowEdits.map((edit) => {
      const policy = editability.columns[edit.ordinal];
      if (!policy?.editable) throw new Error(`Column ${edit.column} is not editable.`);
      return `${quoteIdentifier(edit.column)} IS NOT DISTINCT FROM ${bind(edit.original, policy.dataType)}`;
    });
    const text = `UPDATE ${quoteIdentifier(table.schema)}.${quoteIdentifier(table.name)}\nSET ${assignments.join(", ")}\nWHERE ${[...identity, ...guards].join("\n  AND ")}`;
    const target = `${table.schema}.${table.name} (${table.keyColumns
      .map((column, index) => `${column} = ${first.key[index] ?? "NULL"}`)
      .join(", ")})`;
    return { text, values, target };
  });
}
