import { format } from "sql-formatter";

export function formatPostgresSql(source: string): string {
  const formatted = format(source, {
    language: "postgresql",
    keywordCase: "upper",
    dataTypeCase: "upper",
    functionCase: "preserve",
    identifierCase: "preserve",
    tabWidth: 2,
    useTabs: false,
    logicalOperatorNewline: "before",
    linesBetweenQueries: 1,
    denseOperators: false,
    newlineBeforeSemicolon: false,
  });
  return `${formatted.trimEnd()}\n`;
}
