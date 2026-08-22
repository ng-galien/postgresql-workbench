/**
 * The words and phrases a PostgreSQL statement is written with.
 *
 * SQL as text is what this layer owns, and the language itself is part of it: the Workbench Index
 * knows everything a query *names* — relations, columns, routines — and nothing about what holds
 * those names together. A reader typing `an` into a condition was offered every column starting
 * with those letters and never `AND`, because nothing here said the word existed.
 *
 * This is not the reserved-keyword set of `identifiers.ts`, and neither can be derived from the
 * other. That set answers one question — must this catalog name be quoted — so it holds every
 * reserved word, including ones nobody writes by hand, and holds single words only. This one
 * answers a different question: what does a reader reach for while writing a statement. So it
 * carries `IS NOT NULL` and `ORDER BY` as one phrase each, because that is how they are typed,
 * and leaves out what the grammar reserves but a reader never writes.
 *
 * Uppercase, like every keyword the composition engine writes and the formatter normalizes to.
 *
 * Which phrases may stand at a given caret is a finer question than the roles the syntax tree
 * reports today, so a caller in an expression position is handed all of them and the reader's own
 * letters do the narrowing.
 */
export const POSTGRES_STATEMENT_PHRASES: readonly string[] = [
  // What a statement is made of.
  "SELECT",
  "FROM",
  "WHERE",
  "GROUP BY",
  "HAVING",
  "ORDER BY",
  "LIMIT",
  "OFFSET",
  "WITH",
  "AS",
  "DISTINCT",
  "DISTINCT ON",
  "UNION",
  "UNION ALL",
  "INTERSECT",
  "EXCEPT",
  // How another relation is brought in.
  "JOIN",
  "INNER JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "FULL JOIN",
  "CROSS JOIN",
  "LATERAL",
  "ON",
  "USING",
  // What a condition is made of.
  "AND",
  "OR",
  "NOT",
  "IS NULL",
  "IS NOT NULL",
  "IS TRUE",
  "IS FALSE",
  "IS DISTINCT FROM",
  "IS NOT DISTINCT FROM",
  "IN",
  "NOT IN",
  "EXISTS",
  "BETWEEN",
  "LIKE",
  "ILIKE",
  "NOT LIKE",
  "SIMILAR TO",
  "ANY",
  "ALL",
  // What a value can be, and how it is shaped.
  "NULL",
  "TRUE",
  "FALSE",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "CAST",
  "INTERVAL",
  "CURRENT_DATE",
  "CURRENT_TIMESTAMP",
  // Where a sort puts what it cannot compare.
  "ASC",
  "DESC",
  "NULLS FIRST",
  "NULLS LAST",
];
