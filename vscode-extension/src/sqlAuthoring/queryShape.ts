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
  const { words } = scanPostgresSql(source);
  const topLevel = words.filter(({ depth }) => depth === 0).map(({ value }) => value);
  const hasNestedQuery =
    topLevel[0] === "with" ||
    words.some(({ depth, value }) => depth > 0 && (value === "select" || value === "with"));
  return {
    hasNestedQuery,
    supportsComposition:
      !hasNestedQuery &&
      topLevel[0] === "select" &&
      !topLevel.some((word) => UNSUPPORTED_COMPOSITION_WORDS.has(word)),
  };
}
