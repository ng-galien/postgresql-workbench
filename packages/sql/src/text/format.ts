import { format } from "sql-formatter";

export function formatPostgresSql(source: string, tabWidth = 2): string {
  const formatted = format(source, {
    language: "postgresql",
    keywordCase: "upper",
    dataTypeCase: "upper",
    functionCase: "preserve",
    identifierCase: "preserve",
    tabWidth,
    useTabs: false,
    logicalOperatorNewline: "before",
    linesBetweenQueries: 1,
    denseOperators: false,
    newlineBeforeSemicolon: false,
  });
  return `${formatted.trimEnd()}\n`;
}
