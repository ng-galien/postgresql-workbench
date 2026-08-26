import {
  POSTGRES_SOURCE_LANGUAGE_IDS,
  type PostgresSourceLanguageId,
} from "../text/documentLanguage.js";
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
 * PL/pgSQL syntax-tree tokens complement indexed SQL tokens for the documents whose body IS
 * PL/pgSQL: `.pgsql` files, the virtual sources the catalog projects (their language ids say what
 * they are, whatever shell serves them), and the sources a debug session opens.
 */
export function wantsPlpgsqlSemanticTokens(uri: string, languageId: string): boolean {
  if (POSTGRES_SOURCE_LANGUAGE_IDS.includes(languageId as PostgresSourceLanguageId)) return true;
  return languageId === "plpgsql" && (uri.startsWith("file:") || uri.startsWith("debug:"));
}
