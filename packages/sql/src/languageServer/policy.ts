import type { SyntaxLanguage } from "../analysis/syntaxTree.js";
import { NOTEBOOK_CELL_URI_SCHEME } from "../text/documentLanguage.js";
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

/**
 * The LSP document's root grammar. Virtual PostgreSQL sources are SQL wrappers with injections.
 * A notebook cell executes as a SQL script whatever its editor language says, so it parses as
 * one: the PL/pgSQL inside it — a DO body, a routine body — comes back as parser injections. A
 * bare `plpgsql` document outside a notebook is a routine body and keeps the PL/pgSQL root.
 */
export function postgresAuthoringDocumentLanguage(
  languageId: string,
  uri?: string,
): SyntaxLanguage {
  if (uri?.startsWith(`${NOTEBOOK_CELL_URI_SCHEME}:`)) return "sql";
  return languageId === "plpgsql" ? "plpgsql" : "sql";
}
