// PostgreSQL 17 `pg_get_keywords()` entries in the reserved (`R`) category. These identifiers
// must be quoted when generated from catalog names, independently from the smaller grammar set
// that cannot be interpreted as an implicit relation alias.
const POSTGRES_RESERVED_KEYWORDS = new Set([
  "all",
  "analyse",
  "analyze",
  "and",
  "any",
  "array",
  "as",
  "asc",
  "asymmetric",
  "both",
  "case",
  "cast",
  "check",
  "collate",
  "column",
  "constraint",
  "create",
  "current_catalog",
  "current_date",
  "current_role",
  "current_time",
  "current_timestamp",
  "current_user",
  "default",
  "deferrable",
  "desc",
  "distinct",
  "do",
  "else",
  "end",
  "except",
  "false",
  "fetch",
  "for",
  "foreign",
  "from",
  "grant",
  "group",
  "having",
  "in",
  "initially",
  "intersect",
  "into",
  "lateral",
  "leading",
  "limit",
  "localtime",
  "localtimestamp",
  "not",
  "null",
  "offset",
  "on",
  "only",
  "or",
  "order",
  "placing",
  "primary",
  "references",
  "returning",
  "select",
  "session_user",
  "some",
  "symmetric",
  "system_user",
  "table",
  "then",
  "to",
  "trailing",
  "true",
  "union",
  "unique",
  "user",
  "using",
  "variadic",
  "when",
  "where",
  "window",
  "with",
]);

const SIMPLE_IDENTIFIER = /^[a-z_][a-z0-9_$]*$/u;

export const POSTGRES_IDENTIFIER_PATTERN = String.raw`(?:"(?:""|[^"\r\n])+"|[A-Za-z_][\w$]*)`;

/**
 * Quotes an identifier for SQL the Workbench executes itself. Always quoted, so a name that
 * happens to be a keyword or to carry capitals cannot be misread. For SQL a user reads, see
 * `quoteSqlIdentifierIfNeeded`.
 */
export function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Quotes only where PostgreSQL requires it, for the SQL a user reads in the editor. */
export function quoteSqlIdentifierIfNeeded(identifier: string): string {
  if (SIMPLE_IDENTIFIER.test(identifier) && !requiresQuotedPostgresIdentifier(identifier)) {
    return identifier;
  }
  return quoteSqlIdentifier(identifier);
}

export function requiresQuotedPostgresIdentifier(identifier: string): boolean {
  return POSTGRES_RESERVED_KEYWORDS.has(identifier.toLocaleLowerCase());
}

export function canonicalSqlIdentifier(identifier: string): string {
  return identifier.startsWith('"') && identifier.endsWith('"')
    ? unquoteSqlIdentifier(identifier)
    : identifier.toLocaleLowerCase();
}

export function splitSqlQualifiedIdentifier(identifier: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < identifier.length; index += 1) {
    if (identifier[index] === '"') {
      if (quoted && identifier[index + 1] === '"') {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (identifier[index] === "." && !quoted) {
      parts.push(identifier.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(identifier.slice(start));
  return parts;
}

export function unquoteSqlIdentifier(identifier: string): string {
  return identifier.startsWith('"') && identifier.endsWith('"')
    ? identifier.slice(1, -1).replaceAll('""', '"')
    : identifier;
}

export function unquoteSqlIdentifierFragment(identifier: string): string {
  if (!identifier.startsWith('"')) return identifier;
  const end = identifier.endsWith('"') ? -1 : undefined;
  return identifier.slice(1, end).replaceAll('""', '"');
}
