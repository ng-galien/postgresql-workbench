import type { SyntaxLanguage } from "../analysis/syntaxTree.js";
import type { SqlAuthoringSyntaxResult } from "./protocol.js";

export const SQL_AUTHORING_SYNTAX_SETTINGS =
  "postgresql-workbench.sqlAuthoring.syntaxMaxDepth / syntaxMaxNodes";

/** Returns the warning shown when Format Document is skipped, or undefined when it applies. */
export function formatSkippedMessage(syntax: SqlAuthoringSyntaxResult): string | undefined {
  if (syntax.truncated) {
    return `Format skipped: the SQL exceeds the configured syntax budget (${SQL_AUTHORING_SYNTAX_SETTINGS}).`;
  }
  if (!syntax.hasError) return undefined;
  if (syntax.plpgsqlBody) {
    return "Format skipped: bare PL/pgSQL blocks are not formatted. Wrap the body in CREATE FUNCTION or DO $$ … $$.";
  }
  return syntax.errorLine === undefined
    ? "Format skipped: the SQL contains a syntax error."
    : `Format skipped: the SQL contains a syntax error at line ${syntax.errorLine}.`;
}

/** The LSP document's root grammar. Virtual PostgreSQL sources are SQL wrappers with injections. */
export function postgresAuthoringDocumentLanguage(languageId: string): SyntaxLanguage {
  return languageId === "plpgsql" ? "plpgsql" : "sql";
}
