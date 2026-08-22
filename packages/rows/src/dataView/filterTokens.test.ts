import { describe, expect, it } from "vitest";
import type { SqlQueryAnalysis } from "../../../sql/src/query/analysis.js";
import { positionAtOffset } from "../../../sql/src/text/positions.js";
import type { DataViewSqlToken } from "./dataViewProtocol.js";
import { type FilterDraft, filterDraft, tokensWithinFilter } from "./filterTokens.js";

const QUERY = "SELECT brand.name\nFROM shop.brand AS brand";

/** What the analysis says about the query above: a FROM clause that ends it, and no WHERE yet. */
const ANALYSIS = { fromEnd: QUERY.length, where: undefined } as unknown as SqlQueryAnalysis;

/** A token over the word at `at` in the draft, stated the way a language server states it. */
function token(draft: FilterDraft, at: number, word: string, type: string): DataViewSqlToken {
  return { ...positionAtOffset(draft.text, at), length: word.length, type };
}

function draftOf(condition: string): FilterDraft {
  const draft = filterDraft(QUERY, ANALYSIS, condition);
  if (!draft) throw new Error("the condition did not land in the query");
  return draft;
}

describe("the filter, asked about as part of its query", () => {
  it("lands the condition in the query, and says where", () => {
    const draft = draftOf("brand.name LIKE 'F%'");
    expect(draft.text).toContain("WHERE brand.name LIKE 'F%'");
    expect(draft.text.slice(draft.start)).toBe("brand.name LIKE 'F%'");
    // Nothing of the marker is left in what the server is asked about.
    expect(draft.text).not.toContain("\u0000");
  });

  it("carries back only what falls inside the condition, counted from its start", () => {
    const condition = "brand.name LIKE 'F%'";
    const draft = draftOf(condition);
    const carried = tokensWithinFilter(
      [
        token(draft, draft.text.indexOf("shop"), "shop", "sqlSchema"),
        token(draft, draft.start, "brand", "sqlAlias"),
        token(draft, draft.start + "brand.".length, "name", "sqlColumn"),
      ],
      draft,
      condition,
    );

    // The schema belongs to the query, not to what the reader typed.
    expect(carried).toEqual([
      { line: 0, character: 0, length: 5, type: "sqlAlias" },
      { line: 0, character: 6, length: 4, type: "sqlColumn" },
    ]);
  });

  it("counts a condition of several lines from its own first line", () => {
    const condition = "brand.name LIKE 'F%'\nAND brand.id > 1";
    const draft = draftOf(condition);
    const secondLine = draft.start + condition.indexOf("brand.id");

    expect(
      tokensWithinFilter([token(draft, secondLine, "brand", "sqlAlias")], draft, condition),
    ).toEqual([{ line: 1, character: 4, length: 5, type: "sqlAlias" }]);
  });
});
