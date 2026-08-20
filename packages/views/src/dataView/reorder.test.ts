import { describe, expect, it } from "vitest";
import { positionAtPointer, reorderedIndex } from "./reorder.js";

/**
 * The Data View reorders the tables of its FROM clause and the terms of its ORDER BY by dragging.
 * Neither gesture is covered end to end, so what decides where a drag lands is tested here.
 */
describe("where a drag lands", () => {
  const anywhere = () => true;

  it("moves an item onto another position", () => {
    expect(reorderedIndex(0, 2, anywhere)).toBe(2);
    expect(reorderedIndex(3, 1, anywhere)).toBe(1);
  });

  it("does not move an item onto itself", () => {
    expect(reorderedIndex(2, 2, anywhere)).toBeUndefined();
  });

  it("does nothing when no drag started", () => {
    expect(reorderedIndex(undefined, 1, anywhere)).toBeUndefined();
  });

  it("refuses a position that may not move, whichever end it is", () => {
    // The ORDER BY list holds terms that are not grid columns; they stay where they are.
    const movable = (index: number) => index >= 0;
    expect(reorderedIndex(-1, 1, movable)).toBeUndefined();
    expect(reorderedIndex(1, -1, movable)).toBeUndefined();
    expect(reorderedIndex(1, 0, movable)).toBe(0);
  });

  it("refuses every position when the query is not structured", () => {
    expect(reorderedIndex(0, 1, () => false)).toBeUndefined();
  });
});

describe("the position a pointer sits at", () => {
  // Three badges, each 100 wide, laid out from x=0: midpoints at 50, 150, 250.
  const midpoints = [50, 150, 250];

  it("is the first item the pointer is left of", () => {
    expect(positionAtPointer(10, midpoints)).toBe(0);
    expect(positionAtPointer(120, midpoints)).toBe(1);
    expect(positionAtPointer(200, midpoints)).toBe(2);
  });

  it("is the last position when the pointer is past every midpoint", () => {
    expect(positionAtPointer(400, midpoints)).toBe(2);
  });

  it("is the first position on an empty row, so a drop can never land nowhere", () => {
    expect(positionAtPointer(120, [])).toBe(0);
  });

  it("takes the exact midpoint as the item after it", () => {
    expect(positionAtPointer(50, midpoints)).toBe(1);
  });
});
