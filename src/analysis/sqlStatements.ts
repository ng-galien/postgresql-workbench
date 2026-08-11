import { syntaxNodeText, syntaxTreeHasKind } from "./syntaxNodes.js";
import type { SyntaxNode, SyntaxParser } from "./syntaxTree.js";

export type SqlStatementCount = "single-statement" | "multiple-statements" | "unclassifiable";
export type SqlResultExecutionKind =
  | "paged-query"
  | "non-paged"
  | "multiple-statements"
  | "unclassifiable";

export interface SqlExecutionStatement {
  sql: string;
  resultKind: "paged-query" | "non-paged";
  line: number;
}

export type SqlExecutionPlan =
  | { status: "ready"; statements: SqlExecutionStatement[] }
  | { status: "empty" }
  | { status: "syntax-error"; line?: number; column?: number }
  | { status: "analysis-error"; message: string };

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
  const plan = await planSqlResultExecution(sql, parser);
  if (plan.status !== "ready") return "unclassifiable";
  if (plan.statements.length !== 1) return "multiple-statements";
  return plan.statements[0]?.resultKind ?? "unclassifiable";
}

export async function planSqlResultExecution(
  sql: string,
  parser: SyntaxParser,
): Promise<SqlExecutionPlan> {
  if (!sql.trim()) return { status: "empty" };
  try {
    const syntax = await parser.parse({ language: "sql", source: sql, uri: "selection.sql" });
    if (syntax.truncated) {
      return {
        status: "analysis-error",
        message: "The SQL syntax tree exceeded the configured analysis limit.",
      };
    }
    if (syntax.hasError) {
      const problem = firstSyntaxProblem(syntax.root);
      return {
        status: "syntax-error",
        ...(problem ? { line: problem.start.line, column: problem.start.column } : {}),
      };
    }
    const statements = syntax.root.children.filter((child) => child.kind === "toplevel_stmt");
    if (statements.length === 0) return { status: "empty" };
    return {
      status: "ready",
      statements: statements.map((statement) => ({
        sql: syntaxNodeText(sql, statement).trim(),
        resultKind:
          !syntaxTreeHasKind(statement, MUTATING_STATEMENT_KINDS) &&
          topLevelStatementNode(statement)?.kind === "SelectStmt"
            ? "paged-query"
            : "non-paged",
        line: statement.start.line,
      })),
    };
  } catch (error) {
    return {
      status: "analysis-error",
      message: error instanceof Error ? error.message : String(error),
    };
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

function firstSyntaxProblem(node: SyntaxNode): SyntaxNode | undefined {
  if (node.error || node.missing || node.kind === "ERROR") return node;
  for (const child of node.children) {
    const problem = firstSyntaxProblem(child);
    if (problem) return problem;
  }
  return undefined;
}
