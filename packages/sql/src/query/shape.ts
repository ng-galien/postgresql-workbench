import { findSyntaxNode, findSyntaxNodes } from "../analysis/syntaxNodes.js";
import type { SyntaxNode } from "../analysis/syntaxTree.js";

export interface SqlQueryShape {
  /** The statement declares a CTE or contains a sub-select. */
  hasNestedQuery: boolean;
  /** The composition engine can rewrite this statement's projection and FROM clause. */
  supportsComposition: boolean;
}

/** Clauses the composition engine does not rewrite; each is a node kind of the syntax tree. */
const UNSUPPORTED_COMPOSITION_KINDS = [
  "kw_union",
  "kw_intersect",
  "kw_except",
  "with_clause",
  "select_with_parens",
  "window_clause",
  "into_clause",
  "for_locking_clause",
  "select_limit",
];

/** Shape of a statement, read from its syntax tree. */
export function sqlQueryShape(root: SyntaxNode): SqlQueryShape {
  const hasNestedQuery =
    findSyntaxNode(root, "with_clause") !== undefined ||
    findSyntaxNode(root, "select_with_parens") !== undefined;
  const select = findSyntaxNode(root, "SelectStmt");
  const unsupported = UNSUPPORTED_COMPOSITION_KINDS.some(
    (kind) => findSyntaxNode(root, kind) !== undefined,
  );
  return {
    hasNestedQuery,
    supportsComposition: select !== undefined && !unsupported && !hasCommaJoin(root),
  };
}

/** `FROM a, b` lists several relations in one from_list, which the engine does not extend. */
function hasCommaJoin(root: SyntaxNode): boolean {
  return findSyntaxNodes(root, "from_list").some((list) =>
    list.children.some((child) => child.kind === "from_list"),
  );
}
