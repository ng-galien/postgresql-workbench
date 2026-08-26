import { describe, expect, it } from "vitest";
import type { HighlightedPostgresSource } from "./highlight.js";
import { withSemanticTokens } from "./semanticTokens.js";

/** One line in three plain pieces: `shop.brand`, then ` AS `, then `brand`. */
const SOURCE: HighlightedPostgresSource = {
  lines: [
    {
      number: 1,
      tokens: [
        { text: "shop.brand", offset: 0 },
        { text: " AS ", offset: 10 },
        { text: "brand", offset: 14 },
      ],
    },
  ],
};

const texts = (source: HighlightedPostgresSource) =>
  source.lines[0]?.tokens.map((token) => `${token.text}:${token.className ?? "-"}`) ?? [];

describe("withSemanticTokens", () => {
  it("cuts a syntactic token where a name starts and ends", () => {
    const painted = withSemanticTokens(SOURCE, [
      { line: 0, character: 0, length: 4, type: "sqlSchema" },
      { line: 0, character: 5, length: 5, type: "sqlTable" },
      { line: 0, character: 14, length: 5, type: "sqlAlias" },
    ]);

    expect(texts(painted)).toEqual([
      "shop:postgres-token-sqlSchema",
      ".:-",
      "brand:postgres-token-sqlTable",
      " AS :-",
      "brand:postgres-token-sqlAlias",
    ]);
  });

  it("leaves what no name covers unpainted, for the plain colour to stand", () => {
    const painted = withSemanticTokens(SOURCE, [
      { line: 0, character: 5, length: 5, type: "sqlTable" },
    ]);

    const keyword = painted.lines[0]?.tokens.find((token) => token.text === " AS ");
    expect(keyword?.className).toBeUndefined();
  });

  it("leaves a source alone when nothing was named", () => {
    expect(withSemanticTokens(SOURCE, [])).toBe(SOURCE);
  });

  it("ignores a name that falls outside the line it was read against", () => {
    const painted = withSemanticTokens(SOURCE, [
      { line: 4, character: 0, length: 4, type: "sqlSchema" },
      { line: 0, character: 40, length: 5, type: "sqlTable" },
    ]);

    expect(texts(painted)).toEqual(["shop.brand:-", " AS :-", "brand:-"]);
  });
});
