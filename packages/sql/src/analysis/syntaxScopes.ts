import { isPlpgsqlBlockScopeKind, isPostgresSqlStatementScopeKind } from "./postgresGrammar.js";
import type { SyntaxLanguage } from "./syntaxTree.js";

export type PostgresNestedScopeKind = "sql-query-scope" | "plpgsql-block";

/**
 * The one mapping from provider syntax nodes to Workbench lexical scopes. It is intentionally an
 * application taxonomy: grammar node names do not escape the syntax-facts reducer.
 */
export function postgresNestedScopeKind(
  language: SyntaxLanguage,
  nodeKind: string,
): PostgresNestedScopeKind | undefined {
  switch (language) {
    case "sql":
      return isPostgresSqlStatementScopeKind(nodeKind) ? "sql-query-scope" : undefined;
    case "plpgsql":
      return isPlpgsqlBlockScopeKind(nodeKind) ? "plpgsql-block" : undefined;
  }
}
