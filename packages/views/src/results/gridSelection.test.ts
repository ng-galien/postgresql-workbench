import { describe, expect, it } from "vitest";
import {
  cellIsSelected,
  cellSelection,
  extendedTo,
  isRange,
  movedSelection,
  rowIsSelected,
  rowSelection,
  selectedOrdinals,
  selectedRowCount,
  selectedRows,
} from "./gridSelection.js";

// A projection whose second column is hidden: the visible ordinals are not 0,1,2,3.
const visible = [0, 2, 3, 4];

describe("grid selection", () => {
  it("starts on the cell that was clicked", () => {
    const selection = cellSelection(3, 2);

    expect(selectedRows(selection)).toEqual({ first: 3, last: 3 });
    expect(selectedOrdinals(selection, visible)).toEqual([2]);
    expect(isRange(selection, visible)).toBe(false);
  });

  it("reads a range the same whichever way it was drawn", () => {
    const downward = extendedTo(cellSelection(1, 0), { row: 3, ordinal: 3 });
    const upward = extendedTo(cellSelection(3, 3), { row: 1, ordinal: 0 });

    expect(selectedRows(downward)).toEqual({ first: 1, last: 3 });
    expect(selectedRows(upward)).toEqual({ first: 1, last: 3 });
    expect(selectedOrdinals(downward, visible)).toEqual([0, 2, 3]);
    expect(selectedOrdinals(upward, visible)).toEqual([0, 2, 3]);
  });

  it("covers every visible column when whole rows are selected", () => {
    const selection = extendedTo(rowSelection(0, 0), { row: 2, ordinal: 0 });

    expect(selectedOrdinals(selection, visible)).toEqual(visible);
    expect(selectedRowCount(selection)).toBe(3);
    expect(rowIsSelected(selection, 1)).toBe(true);
    expect(rowIsSelected(selection, 3)).toBe(false);
  });

  it("does not call a row selected when only its cells are", () => {
    // The delete control acts on rows; a rectangle across three rows is not three rows.
    const selection = extendedTo(cellSelection(0, 0), { row: 2, ordinal: 2 });

    expect(rowIsSelected(selection, 1)).toBe(false);
    expect(cellIsSelected(selection, 1, 2, visible)).toBe(true);
    expect(cellIsSelected(selection, 1, 3, visible)).toBe(false);
  });

  it("skips the hidden column when a range crosses it", () => {
    const selection = extendedTo(cellSelection(0, 0), { row: 0, ordinal: 3 });

    // Ordinal 1 is hidden, so the run is 0, 2, 3 — never 0, 1, 2, 3.
    expect(selectedOrdinals(selection, visible)).toEqual([0, 2, 3]);
    expect(cellIsSelected(selection, 0, 1, visible)).toBe(false);
  });

  it("collapses onto the cell moved to, and extends only with shift", () => {
    const start = cellSelection(1, 2);

    const moved = movedSelection(start, 1, 0, false, { rows: 8, visibleOrdinals: visible });
    expect(moved.anchor).toEqual({ row: 2, ordinal: 2 });
    expect(selectedRowCount(moved)).toBe(1);

    const extended = movedSelection(start, 2, 0, true, { rows: 8, visibleOrdinals: visible });
    expect(extended.anchor).toEqual({ row: 1, ordinal: 2 });
    expect(selectedRows(extended)).toEqual({ first: 1, last: 3 });
  });

  it("moves by visible column, not by ordinal", () => {
    const selection = movedSelection(cellSelection(0, 0), 0, 1, false, {
      rows: 8,
      visibleOrdinals: visible,
    });

    expect(selection.anchor.ordinal).toBe(2);
  });

  it("stops at the edges instead of running past them", () => {
    const bounds = { rows: 3, visibleOrdinals: visible };

    expect(movedSelection(cellSelection(0, 0), -1, -1, false, bounds).anchor).toEqual({
      row: 0,
      ordinal: 0,
    });
    expect(movedSelection(cellSelection(2, 4), 5, 5, false, bounds).anchor).toEqual({
      row: 2,
      ordinal: 4,
    });
  });

  /* The gutter is a place along the row, so these all ask about the same three columns. */
  const bounds = { rows: 8, visibleOrdinals: [0, 1, 2] };

  it("steps left of the first column onto the gutter, where the whole row is selected", () => {
    const onGutter = movedSelection(cellSelection(2, 0), 0, -1, false, bounds);
    expect(onGutter.kind).toBe("rows");
    expect(onGutter.anchor).toEqual({ row: 2, ordinal: 0 });
    expect(selectedOrdinals(onGutter, bounds.visibleOrdinals)).toEqual([0, 1, 2]);
    expect(rowIsSelected(onGutter, 2)).toBe(true);
  });

  it("walks whole rows along the gutter, and comes back to the first column", () => {
    const gutter = rowSelection(2, 0);
    const down = movedSelection(gutter, 1, 0, false, bounds);
    expect(down.kind).toBe("rows");
    expect(down.anchor.row).toBe(3);
    const back = movedSelection(gutter, 0, 1, false, bounds);
    expect(back.kind).toBe("cells");
    expect(back.anchor).toEqual({ row: 2, ordinal: 0 });
  });

  it("extends a run of whole rows from the gutter with shift held", () => {
    const extended = movedSelection(rowSelection(1, 0), 2, 0, true, bounds);
    expect(extended.kind).toBe("rows");
    expect(selectedRows(extended)).toEqual({ first: 1, last: 3 });
  });

  it("stays on the gutter when the reader keeps pressing left", () => {
    const still = movedSelection(rowSelection(2, 0), 0, -1, false, bounds);
    expect(still.kind).toBe("rows");
    expect(still.anchor).toEqual({ row: 2, ordinal: 0 });
  });

  it("keeps the kind when extending, and takes a new one when told", () => {
    const cells = cellSelection(0, 2);

    expect(extendedTo(cells, { row: 2, ordinal: 2 }).kind).toBe("cells");
    // Shift-clicking the gutter turns a rectangle into whole rows.
    expect(extendedTo(cells, { row: 2, ordinal: 2 }, "rows").kind).toBe("rows");
  });
});
