import { describe, expect, it } from "vitest";
import { matchFrom, matchingCells } from "./findInRows.js";

const ROWS: (string | null)[][] = [
  ["1", "Genève", null],
  ["2", "genf", "Genève"],
  ["3", "Lyon", "lyon"],
];

describe("finding what a reader is looking for, among the rows they can see", () => {
  it("gives every cell holding it, in reading order", () => {
    expect(matchingCells(ROWS, "gen")).toEqual([
      { row: 0, column: 1 },
      { row: 1, column: 1 },
      { row: 1, column: 2 },
    ]);
  });

  it("ignores case, because a reader does not know how a column spells it", () => {
    expect(matchingCells(ROWS, "LYON")).toEqual([
      { row: 2, column: 1 },
      { row: 2, column: 2 },
    ]);
  });

  it("finds nothing when there is nothing to look for", () => {
    expect(matchingCells(ROWS, "")).toEqual([]);
  });

  it("passes over a cell with no value at all", () => {
    // A NULL is drawn as the word NULL, but it holds nothing: looking for "null" must not find it
    // in every empty cell of the result.
    expect(matchingCells(ROWS, "null")).toEqual([]);
  });
});

describe("going from one match to the next", () => {
  const matches = matchingCells(ROWS, "gen");

  it("goes to the first match past the cursor", () => {
    expect(matchFrom(matches, { row: 0, column: 0 }, 1)).toBe(0);
    expect(matchFrom(matches, { row: 0, column: 1 }, 1)).toBe(1);
  });

  it("goes back to the last match before the cursor", () => {
    expect(matchFrom(matches, { row: 1, column: 2 }, -1)).toBe(1);
  });

  it("wraps round at either end, because pressing again means keep going", () => {
    expect(matchFrom(matches, { row: 9, column: 9 }, 1)).toBe(0);
    expect(matchFrom(matches, { row: 0, column: 0 }, -1)).toBe(2);
  });

  it("has nowhere to go when nothing matches", () => {
    expect(matchFrom([], { row: 0, column: 0 }, 1)).toBeUndefined();
  });
});
