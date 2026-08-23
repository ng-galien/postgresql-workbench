import { sqlFunctionApplications, sqlRoutineBody } from "./analysis/sqlSyntax.js";
import { findSyntaxNode, syntaxNodeText } from "./analysis/syntaxNodes.js";
import type { SyntaxNode, SyntaxParser, SyntaxTree } from "./analysis/syntaxTree.js";

export interface FuncInfo {
  schema: string;
  name: string;
  lang: string;
  ddl: string;
  body?: string;
}

interface SqlFragment {
  source: string;
  completeStatement: boolean;
}

const COMPLETE_SQL_ANCESTORS = new Set([
  "stmt_execsql",
  "for_query",
  "stmt_return_query",
  "return_query",
]);

export async function extractFuncDeps(fn: FuncInfo, parser: SyntaxParser): Promise<Set<string>> {
  const calls = new Set<string>();
  const body = fn.body ?? (await extractRoutineBody(fn.ddl, parser));
  if (!body) return calls;

  if (fn.lang === "sql") {
    await collectSqlDependencies(body, parser, calls);
  } else if (fn.lang === "plpgsql") {
    const syntax = await parser.parse({
      language: "plpgsql",
      source: body,
      uri: "dependency.pgsql",
    });
    if (!syntax.hasError && !syntax.truncated) {
      for (const fragment of sqlFragments(body, syntax)) {
        const sql = fragment.completeStatement ? fragment.source : `SELECT ${fragment.source}`;
        await collectSqlDependencies(sql, parser, calls);
      }
    }
  }

  calls.delete(`${fn.schema}.${fn.name}`);
  return calls;
}

async function extractRoutineBody(ddl: string, parser: SyntaxParser): Promise<string | undefined> {
  const syntax = await parser.parse({ language: "sql", source: ddl, uri: "dependency.sql" });
  if (syntax.hasError) return undefined;
  const create = findSyntaxNode(syntax.root, "CreateFunctionStmt");
  return create ? sqlRoutineBody(ddl, create) : undefined;
}

function sqlFragments(source: string, syntax: SyntaxTree): SqlFragment[] {
  const fragments: SqlFragment[] = [];
  collectSqlFragments(source, syntax.root, [], fragments);
  return fragments;
}

function collectSqlFragments(
  source: string,
  node: SyntaxNode,
  ancestors: readonly SyntaxNode[],
  fragments: SqlFragment[],
): void {
  if (node.kind === "sql_expression") {
    fragments.push({
      source: syntaxNodeText(source, node),
      completeStatement: ancestors.some(
        (ancestor) =>
          COMPLETE_SQL_ANCESTORS.has(ancestor.kind) ||
          (ancestor.kind === "stmt_return" && findSyntaxNode(ancestor, "kw_query") !== undefined),
      ),
    });
    return;
  }
  const childAncestors = [...ancestors, node];
  for (const child of node.children) {
    collectSqlFragments(source, child, childAncestors, fragments);
  }
}

async function collectSqlDependencies(
  source: string,
  parser: SyntaxParser,
  calls: Set<string>,
): Promise<void> {
  const syntax = await parser.parse({ language: "sql", source, uri: "dependency-expression.sql" });
  if (syntax.hasError || syntax.truncated) return;
  for (const { nameParts } of sqlFunctionApplications(source, syntax.root)) {
    if (nameParts.length === 2) calls.add(`${nameParts[0]}.${nameParts[1]}`);
  }
}
