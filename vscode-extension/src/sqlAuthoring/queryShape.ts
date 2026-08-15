import { scanPostgresSql } from "./sqlLexing.js";

const UNSUPPORTED_COMPOSITION_WORDS = new Set([
  "except",
  "fetch",
  "for",
  "intersect",
  "into",
  "union",
  "window",
]);

export interface SqlQueryShape {
  hasNestedQuery: boolean;
  supportsComposition: boolean;
}

export function analyzeSqlQueryShape(source: string): SqlQueryShape {
  const { topLevelSource, words } = scanPostgresSql(source);
  const topLevel = words.filter(({ depth }) => depth === 0).map(({ value }) => value);
  const hasNestedQuery =
    topLevel[0] === "with" ||
    words.some(({ depth, value }) => depth > 0 && (value === "select" || value === "with"));
  const hasCommaJoin = topLevelFromClause(topLevelSource).includes(",");
  return {
    hasNestedQuery,
    supportsComposition:
      !hasNestedQuery &&
      !hasCommaJoin &&
      topLevel[0] === "select" &&
      !topLevel.some((word) => UNSUPPORTED_COMPOSITION_WORDS.has(word)),
  };
}

function topLevelFromClause(source: string): string {
  const from = /\bFROM\b/iu.exec(source);
  if (!from || from.index === undefined) return "";
  const start = from.index + from[0].length;
  const boundary =
    /\b(?:WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|UNION|INTERSECT|EXCEPT|WINDOW|FETCH|FOR)\b|;/iu.exec(
      source.slice(start),
    );
  return source.slice(start, boundary ? start + boundary.index : source.length);
}
