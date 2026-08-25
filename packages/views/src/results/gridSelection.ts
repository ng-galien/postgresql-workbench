/**
 * What a reader has selected in the grid: a rectangle of cells, or whole rows. Both are held the
 * same way — an anchor where the selection started and a head where it now reaches — so extending
 * with the keyboard, extending with a shifted click, and reading the range back are one mechanism.
 *
 * Positions are kept by column ordinal, like every other position in this grid, so hiding a column
 * never shifts a selection sideways.
 */
export interface GridSelection {
  kind: "rows" | "cells";
  anchor: { row: number; ordinal: number };
  head: { row: number; ordinal: number };
}

/** Whether two selections say the same thing, which is how a held one is told from a fresh one. */
export function sameSelection(left: GridSelection | undefined, right: GridSelection): boolean {
  return (
    left?.kind === right.kind &&
    left.anchor.row === right.anchor.row &&
    left.anchor.ordinal === right.anchor.ordinal &&
    left.head.row === right.head.row &&
    left.head.ordinal === right.head.ordinal
  );
}

/** A selection of one cell, which is what a plain click leaves behind. */
export function cellSelection(row: number, ordinal: number): GridSelection {
  return { kind: "cells", anchor: { row, ordinal }, head: { row, ordinal } };
}

/** A selection of one row, which is what a click in the gutter leaves behind. */
export function rowSelection(row: number, ordinal: number): GridSelection {
  return { kind: "rows", anchor: { row, ordinal }, head: { row, ordinal } };
}

/** The selection reaching to a new head, keeping where it was anchored. */
export function extendedTo(
  selection: GridSelection,
  head: { row: number; ordinal: number },
  kind?: GridSelection["kind"],
): GridSelection {
  return { kind: kind ?? selection.kind, anchor: selection.anchor, head };
}

/** The rows a selection covers, first to last whichever way it was drawn. */
export function selectedRows(selection: GridSelection): { first: number; last: number } {
  return {
    first: Math.min(selection.anchor.row, selection.head.row),
    last: Math.max(selection.anchor.row, selection.head.row),
  };
}

/** How many rows a selection covers. */
export function selectedRowCount(selection: GridSelection): number {
  const { first, last } = selectedRows(selection);
  return last - first + 1;
}

/**
 * The column ordinals a selection covers, in the order they are shown. A row selection covers
 * every visible column; a cell selection covers the run between anchor and head.
 */
export function selectedOrdinals(
  selection: GridSelection,
  visibleOrdinals: readonly number[],
): number[] {
  if (selection.kind === "rows") return [...visibleOrdinals];
  const anchor = visibleOrdinals.indexOf(selection.anchor.ordinal);
  const head = visibleOrdinals.indexOf(selection.head.ordinal);
  if (anchor < 0 || head < 0) return [];
  return visibleOrdinals.slice(Math.min(anchor, head), Math.max(anchor, head) + 1);
}

/** Whether a whole row is selected — true only for a row selection. */
export function rowIsSelected(selection: GridSelection | undefined, row: number): boolean {
  if (selection?.kind !== "rows") return false;
  const { first, last } = selectedRows(selection);
  return row >= first && row <= last;
}

/** Whether one cell falls inside the selection, whichever kind it is. */
export function cellIsSelected(
  selection: GridSelection | undefined,
  row: number,
  ordinal: number,
  visibleOrdinals: readonly number[],
): boolean {
  if (!selection) return false;
  const { first, last } = selectedRows(selection);
  if (row < first || row > last) return false;
  return selectedOrdinals(selection, visibleOrdinals).includes(ordinal);
}

/** Whether a cell is the anchor — the one a paste lands on and a typed value replaces. */
export function isAnchor(
  selection: GridSelection | undefined,
  row: number,
  ordinal: number,
): boolean {
  return selection?.anchor.row === row && selection.anchor.ordinal === ordinal;
}

/** Whether the selection covers more than the single cell it started on. */
export function isRange(selection: GridSelection, visibleOrdinals: readonly number[]): boolean {
  return selectedRowCount(selection) > 1 || selectedOrdinals(selection, visibleOrdinals).length > 1;
}

/**
 * The selection after a move by so many rows and columns. Shift extends it; otherwise it collapses
 * onto the cell moved to, which is what every grid a reader has used already does.
 *
 * The gutter is a place the cursor can stand, one step left of the first column, and standing there
 * is what selecting a whole row means — the same selection a click in the gutter leaves behind. One
 * step right comes back to the first column. Moving up and down from the gutter stays on it, so the
 * reader walks whole rows, and a held shift extends the run of them.
 */
export function movedSelection(
  selection: GridSelection,
  rowDelta: number,
  columnDelta: number,
  extend: boolean,
  bounds: { rows: number; visibleOrdinals: readonly number[] },
): GridSelection {
  const { visibleOrdinals } = bounds;
  const from = extend ? selection.head : selection.anchor;
  // Where the cursor stands along the row, counting the gutter as the column before the first.
  const column =
    selection.kind === "rows" ? -1 : Math.max(0, visibleOrdinals.indexOf(from.ordinal));
  const next = Math.max(-1, Math.min(column + columnDelta, visibleOrdinals.length - 1));
  const kind: GridSelection["kind"] = next < 0 ? "rows" : "cells";
  const head = {
    row: clampIndex(from.row + rowDelta, bounds.rows),
    ordinal: visibleOrdinals[Math.max(0, next)] ?? from.ordinal,
  };
  if (extend) return extendedTo(selection, head, kind);
  return { kind, anchor: head, head };
}

function clampIndex(value: number, length: number): number {
  return Math.max(0, Math.min(value, length - 1));
}
