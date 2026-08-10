import { describe, expect, it } from "vitest";
import { applySearchFacet, searchFacetSuggestions } from "./searchSuggestions.js";

const facets = {
  schemas: ["audit", "public", "shop"],
  kinds: ["table", "view", "function"],
};

describe("cockpit search facets", () => {
  it("suggests schemas after # and object kinds after @", () => {
    expect(searchFacetSuggestions("order #sh", facets)).toEqual([
      { kind: "schema", label: "shop", token: "#shop" },
    ]);
    expect(searchFacetSuggestions("@vi", facets)).toEqual([
      { kind: "type", label: "view", token: "@view" },
    ]);
  });

  it("replaces the active token and preserves preceding search terms", () => {
    expect(applySearchFacet("order #sh", "#shop")).toBe("order #shop ");
    expect(applySearchFacet("@ta", "@table")).toBe("@table ");
  });
});
