import { describe, expect, it } from "vitest";
import { offsetAtPosition, positionAtOffset } from "./positions.js";

const TEXT = "SELECT id\nFROM shop.brand\nWHERE id > 1";

describe("text positions", () => {
  it("counts a position the way a language server does", () => {
    expect(positionAtOffset(TEXT, 0)).toEqual({ line: 0, character: 0 });
    expect(positionAtOffset(TEXT, TEXT.indexOf("FROM"))).toEqual({ line: 1, character: 0 });
    expect(positionAtOffset(TEXT, TEXT.indexOf("shop"))).toEqual({ line: 1, character: 5 });
  });

  it("holds an offset that falls outside the text to its ends", () => {
    expect(positionAtOffset(TEXT, -10)).toEqual({ line: 0, character: 0 });
    expect(positionAtOffset(TEXT, TEXT.length + 10)).toEqual({ line: 2, character: 12 });
  });

  it("goes back the other way", () => {
    for (const offset of [0, 7, TEXT.indexOf("shop"), TEXT.length]) {
      expect(offsetAtPosition(TEXT, positionAtOffset(TEXT, offset))).toBe(offset);
    }
    expect(offsetAtPosition(TEXT, { line: 9, character: 0 })).toBe(TEXT.length);
    expect(offsetAtPosition(TEXT, { line: 0, character: 99 })).toBe("SELECT id".length);
  });
});
