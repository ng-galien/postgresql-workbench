import { SQL_LEXICAL_TOKEN_TYPES } from "../analysis/postgresGrammar.js";
import { TOKEN_MODIFIERS, TOKEN_TYPES } from "../text/plpgsqlTokenLegend.js";

/**
 * The canonical semantic-token legend shared by the server and editor integrations. It imports no
 * server runtime, so a browser can verify its presentation mapping without pulling language
 * feature implementations into the editor bundle.
 */
export const SQL_SEMANTIC_TOKEN_TYPES = [
  ...TOKEN_TYPES,
  "sqlSchema",
  "sqlTable",
  "sqlView",
  "sqlCte",
  "sqlAlias",
  "sqlColumn",
  "sqlFunction",
  "sqlProcedure",
  "sqlParameter",
  "sqlType",
  "sqlWindow",
  ...SQL_LEXICAL_TOKEN_TYPES,
] as const;

export const SQL_SEMANTIC_TOKEN_MODIFIERS = TOKEN_MODIFIERS;

export type SqlSemanticTokenType = (typeof SQL_SEMANTIC_TOKEN_TYPES)[number];
