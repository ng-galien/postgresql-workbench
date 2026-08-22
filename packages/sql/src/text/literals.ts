/**
 * A value, written where SQL expects a literal.
 *
 * PostgreSQL reads a single-quoted string as itself, a doubled quote as one quote, and — with
 * `standard_conforming_strings` on, which it is by default since 9.1 — a backslash as a backslash.
 * So doubling the quotes is the whole of it, and nothing here needs to know the type: the server
 * casts a literal to the column it is compared with.
 */
export function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
