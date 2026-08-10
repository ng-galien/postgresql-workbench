import { syntaxTreeHasKind } from "./syntaxNodes.js";
import type { SyntaxNode, SyntaxParser } from "./syntaxTree.js";

export type SqlStatementCount = "single-statement" | "multiple-statements" | "unclassifiable";
export type SqlResultExecutionKind =
  | "paged-query"
  | "non-paged"
  | "multiple-statements"
  | "unclassifiable";

const MUTATING_STATEMENT_KINDS = new Set(["InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt"]);

export async function classifySqlStatementCount(
  sql: string,
  parser: SyntaxParser,
): Promise<SqlStatementCount> {
  const classification = await classifySqlResultExecution(sql, parser);
  return classification === "paged-query" || classification === "non-paged"
    ? "single-statement"
    : classification;
}

export async function classifySqlResultExecution(
  sql: string,
  parser: SyntaxParser,
): Promise<SqlResultExecutionKind> {
  try {
    const syntax = await parser.parse({ language: "sql", source: sql, uri: "selection.sql" });
    if (syntax.hasError || syntax.truncated) return "unclassifiable";
    const statements = syntax.root.children.filter((child) => child.kind === "toplevel_stmt");
    if (statements.length !== 1) {
      return statements.length > 1 ? "multiple-statements" : "unclassifiable";
    }
    const statement = statements[0];
    if (syntaxTreeHasKind(statement, MUTATING_STATEMENT_KINDS)) return "non-paged";
    return topLevelStatementNode(statement)?.kind === "SelectStmt" ? "paged-query" : "non-paged";
  } catch {
    return "unclassifiable";
  }
}

function topLevelStatementNode(statement: SyntaxNode): SyntaxNode | undefined {
  let level = statement.children;
  while (level.length > 0) {
    const statementNode = level.find((node) => node.kind.endsWith("Stmt"));
    if (statementNode) return statementNode;
    level = level.flatMap((node) => node.children);
  }
  return undefined;
}
