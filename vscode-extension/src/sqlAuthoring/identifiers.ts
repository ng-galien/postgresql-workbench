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

const IMPLICIT_ALIAS_BOUNDARY_KEYWORDS = new Set([
  ...POSTGRES_RESERVED_KEYWORDS,
  "by",
  "cross",
  "full",
  "inner",
  "join",
  "left",
  "natural",
  "outer",
  "right",
  "tablesample",
]);

export const POSTGRES_IDENTIFIER_PATTERN = String.raw`(?:"(?:""|[^"\r\n])+"|[A-Za-z_][\w$]*)`;

export function requiresQuotedPostgresIdentifier(identifier: string): boolean {
  return POSTGRES_RESERVED_KEYWORDS.has(identifier.toLocaleLowerCase());
}

export function isUsableSqlAlias(token: string): boolean {
  return (
    token.startsWith('"') || !IMPLICIT_ALIAS_BOUNDARY_KEYWORDS.has(canonicalSqlIdentifier(token))
  );
}

export function sqlAliasAfterRelation(
  source: string,
  maskedSource: string,
  relationEnd: number,
): string | undefined {
  const suffix = maskedSource.slice(relationEnd);
  const match = new RegExp(String.raw`^\s+(?:AS\s+)?(${POSTGRES_IDENTIFIER_PATTERN})`, "iu").exec(
    suffix,
  );
  if (!match || !isUsableSqlAlias(match[1])) return undefined;
  const aliasOffset = relationEnd + match[0].lastIndexOf(match[1]);
  const alias = source.slice(aliasOffset, aliasOffset + match[1].length);
  return /[\r\n]/u.test(alias) ? undefined : alias;
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
