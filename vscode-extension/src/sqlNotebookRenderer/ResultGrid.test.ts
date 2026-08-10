import { describe, expect, it } from "vitest";
import { resultScrollbarGeometry } from "./ResultGrid.js";

describe("result scrollbar geometry", () => {
  it("keeps a visible proportional thumb synchronized with the result scroll", () => {
    expect(resultScrollbarGeometry({ clientHeight: 360, scrollHeight: 1_800 }, 720)).toEqual({
      thumbHeight: 72,
      thumbTop: 144,
      maxScrollTop: 1_440,
      maxThumbTop: 288,
    });
  });

  it("fills the persistent track when the result does not overflow", () => {
    expect(resultScrollbarGeometry({ clientHeight: 180, scrollHeight: 180 }, 0)).toEqual({
      thumbHeight: 180,
      thumbTop: 0,
      maxScrollTop: 0,
      maxThumbTop: 0,
    });
  });
});
