import type { DebugResultCell } from "../../../dap/src/debugger/launch/index.js";
import type { ExportColumn } from "../export.js";
import type { DataViewEdit } from "./dataView.js";
import type { RowOrder } from "./rowOrder.js";

/** Columns and the values under them, ready to be written out. */
export interface ShownValues {
  columns: ExportColumn[];
  rows: (string | null)[][];
}

/**
 * What the grid shows, for a run of its rows and a run of its columns. This is what a copy puts on
 * the clipboard and what an export writes, so both take what is on screen rather than what is in
 * the database: a row waiting to be added gives what it has been filled with, and a loaded row
 * gives its pending edit where it has one.
 */
export function shownValues(source: {
  /** Every column of the result, in result order; the ordinals index into this. */
  columns: readonly { name: string }[];
  /** The loaded rows, in the order they are shown. */
  rows: readonly (readonly DebugResultCell[])[];
  /** Where each row sits, which is what `from` and `to` count in. */
  order: RowOrder;
  /** The columns to take, in the order they are shown. */
  ordinals: readonly number[];
  /** The first and last rows to take, counted as they are shown. */
  from: number;
  to: number;
  /** The type a column was declared with, where the surface knows it; only a CREATE TABLE reads it. */
  typeFor?: (ordinal: number) => string | undefined;
  /** A pending edit on a loaded cell, where the surface holds any. */
  editFor?: (
    row: readonly DebugResultCell[],
    rowIndex: number,
    ordinal: number,
  ) => DataViewEdit | undefined;
}): ShownValues {
  const columns = source.ordinals.map((ordinal) => ({
    name: source.columns[ordinal]?.name ?? "",
    ...(source.typeFor?.(ordinal) ? { type: source.typeFor(ordinal) } : {}),
  }));
  const rows: (string | null)[][] = [];
  for (let index = source.from; index <= source.to; index += 1) {
    const shown = source.order.at(index);
    if ("added" in shown) {
      rows.push(
        source.ordinals.map(
          (ordinal) => shown.added.values[source.columns[ordinal]?.name ?? ""] ?? null,
        ),
      );
      continue;
    }
    const row = source.rows[shown.loaded];
    if (!row) continue;
    rows.push(
      source.ordinals.map((ordinal) => {
        const edit = source.editFor?.(row, shown.loaded, ordinal);
        return (edit ? edit.value : (row[ordinal]?.value ?? null)) ?? null;
      }),
    );
  }
  return { columns, rows };
}
