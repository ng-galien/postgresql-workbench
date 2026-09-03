import { describe, expect, it } from "vitest";
import { type PostgresSyntaxScope, postgresScopeAt } from "./documentFacts.js";

const root: PostgresSyntaxScope = {
  id: "root",
  regionId: "sql:root",
  language: "sql",
  kind: "language-region",
  range: { start: 0, end: 20 },
};

const left: PostgresSyntaxScope = {
  id: "left",
  regionId: root.regionId,
  language: "sql",
  kind: "sql-query-scope",
  range: { start: 0, end: 10 },
  parentId: root.id,
};

const right: PostgresSyntaxScope = {
  id: "right",
  regionId: root.regionId,
  language: "sql",
  kind: "sql-query-scope",
  range: { start: 10, end: 20 },
  parentId: root.id,
};

describe("postgresScopeAt", () => {
  it("gives an exact start precedence over the previous sibling's exact end", () => {
    expect(postgresScopeAt([root, left, right], root.regionId, 10)?.id).toBe("right");
  });

  it("selects an empty scope at its only offset", () => {
    const empty: PostgresSyntaxScope = {
      ...right,
      id: "empty",
      range: { start: 10, end: 10 },
    };
    expect(postgresScopeAt([root, left, right, empty], root.regionId, 10)?.id).toBe("empty");
  });

  it("selects the deepest ending scope at the end of the document", () => {
    expect(postgresScopeAt([root, left, right], root.regionId, 20)?.id).toBe("right");
  });
});
