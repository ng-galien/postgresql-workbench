import { describe, expect, it } from "vitest";
import type { SyntaxNode } from "../analysis/syntaxTree.js";
import { namedRelationSourcesOnly } from "./analysis.js";

function node(kind: string, children: SyntaxNode[] = []): SyntaxNode {
  return {
    kind,
    language: "sql",
    named: true,
    error: false,
    missing: false,
    byteRange: [0, 0],
    start: { line: 1, column: 0 },
    end: { line: 1, column: 0 },
    text: null,
    children,
  };
}

function relation(): SyntaxNode {
  return node("table_ref", [node("relation_expr", [node("qualified_name")])]);
}

describe("FROM source classification", () => {
  it("accepts one named relation and a join of named relations", () => {
    expect(namedRelationSourcesOnly(node("from_list", [relation()]))).toBe(true);
    expect(
      namedRelationSourcesOnly(
        node("from_list", [node("table_ref", [node("joined_table", [relation(), relation()])])]),
      ),
    ).toBe(true);
  });

  it("rejects generate_series and VALUES as non-catalog row sources", () => {
    expect(
      namedRelationSourcesOnly(
        node("from_list", [relation(), node("table_ref", [node("func_table")])]),
      ),
    ).toBe(false);
    expect(
      namedRelationSourcesOnly(
        node("from_list", [relation(), node("table_ref", [node("select_with_parens")])]),
      ),
    ).toBe(false);
  });
});
