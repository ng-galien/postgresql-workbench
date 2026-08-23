import { describe, expect, it } from "vitest";
import type { DataViewRowInsertion } from "./dataView.js";
import { rowOrder } from "./rowOrder.js";

function added(...above: number[]): DataViewRowInsertion[] {
  return above.map((over, index) => ({
    tableOid: 1,
    localId: `new-${index + 1}`,
    values: {},
    above: over,
  }));
}

describe("the order the grid shows its rows in", () => {
  it("counts through both kinds of row", () => {
    expect(rowOrder(added(0, 3), 8).count).toBe(10);
    expect(rowOrder([], 8).count).toBe(8);
  });

  it("shows a row the reader added just over the row it was added on", () => {
    const order = rowOrder(added(0, 3), 8);

    // Added over the first row, then over the fourth: one place at the top, one after three rows.
    expect(order.ofAdded(0)).toBe(0);
    expect(order.ofLoaded(0)).toBe(1);
    expect(order.ofLoaded(2)).toBe(3);
    expect(order.ofAdded(1)).toBe(4);
    expect(order.ofLoaded(3)).toBe(5);
    expect(order.ofLoaded(7)).toBe(9);
  });

  it("stacks rows added over the same one, in the order they were added", () => {
    const order = rowOrder(added(2, 2, 2), 4);

    expect([order.ofAdded(0), order.ofAdded(1), order.ofAdded(2)]).toEqual([2, 3, 4]);
    expect(order.ofLoaded(1)).toBe(1);
    expect(order.ofLoaded(2)).toBe(5);
  });

  it("says which row each place holds", () => {
    const order = rowOrder(added(0, 3), 8);

    expect(order.at(0)).toEqual({
      added: expect.objectContaining({ localId: "new-1" }),
      position: 0,
    });
    expect(order.at(1)).toEqual({ loaded: 0 });
    expect(order.at(4)).toEqual({
      added: expect.objectContaining({ localId: "new-2" }),
      position: 1,
    });
    expect(order.at(5)).toEqual({ loaded: 3 });
    expect(order.at(9)).toEqual({ loaded: 7 });
  });

  it("reads back every place it hands out, with nothing shown twice", () => {
    const order = rowOrder(added(0, 0, 4, 7, 7), 9);
    const places = [
      ...[0, 1, 2, 3, 4].map((position) => order.ofAdded(position)),
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((loaded) => order.ofLoaded(loaded)),
    ];

    expect([...places].sort((left, right) => left - right)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
    for (const [position] of [0, 1, 2, 3, 4].entries()) {
      expect(order.at(order.ofAdded(position))).toMatchObject({ position });
    }
    for (let loaded = 0; loaded < 9; loaded += 1) {
      expect(order.at(order.ofLoaded(loaded))).toEqual({ loaded });
    }
  });

  it("leaves the loaded rows alone when nothing is waiting to be added", () => {
    const order = rowOrder([], 3);

    expect(order.ofLoaded(2)).toBe(2);
    expect(order.at(2)).toEqual({ loaded: 2 });
    expect(order.addedAbove(2)).toBe(0);
  });
});
