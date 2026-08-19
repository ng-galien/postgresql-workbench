import { describe, expect, it } from "vitest";
import { findIdentifierColumns } from "./documentAnalysis.js";

describe("findIdentifierColumns", () => {
  it("matches complete identifiers without parser-specific compatibility behavior", () => {
    expect(
      findIdentifierColumns(
        "select counter::integer into result from metrics where limit_value > 0",
        "counter",
      ),
    ).toEqual([7]);
    expect(
      findIdentifierColumns(
        "select counter::integer into result from metrics where limit_value > 0",
        "integer",
      ),
    ).toEqual([16]);
    expect(findIdentifierColumns("foo_counter counter", "counter")).toEqual([12]);
  });
});
