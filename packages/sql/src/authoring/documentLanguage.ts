export const POSTGRES_SOURCE_LANGUAGE_IDS = [
  "postgresql-table",
  "postgresql-view",
  "postgresql-function",
  "postgresql-procedure",
  "postgresql-trigger",
] as const;

export type PostgresSourceLanguageId = (typeof POSTGRES_SOURCE_LANGUAGE_IDS)[number];

const LANGUAGE_BY_KIND: Readonly<Record<string, PostgresSourceLanguageId>> = {
  table: "postgresql-table",
  view: "postgresql-view",
  function: "postgresql-function",
  procedure: "postgresql-procedure",
  trigger: "postgresql-trigger",
};

export function postgresSourceLanguageId(kind: string): PostgresSourceLanguageId | "sql" {
  return LANGUAGE_BY_KIND[kind] ?? "sql";
}

export function isPostgresSqlLanguage(languageId: string): boolean {
  return (
    languageId === "sql" ||
    languageId === "plpgsql" ||
    POSTGRES_SOURCE_LANGUAGE_IDS.includes(languageId as PostgresSourceLanguageId)
  );
}
