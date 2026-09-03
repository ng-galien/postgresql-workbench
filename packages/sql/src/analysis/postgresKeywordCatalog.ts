import {
  GENERATED_PLPGSQL_KEYWORDS,
  GENERATED_POSTGRES_SQL_KEYWORDS,
  PLPGSQL_KEYWORD_SOURCES,
  POSTGRES_SQL_KEYWORD_SOURCE,
} from "./generated/postgresKeywords.js";

export type PostgresSqlKeywordCategory = "U" | "C" | "T" | "R";
export type PlpgsqlKeywordCategory = "U" | "R";

export type PostgresSqlKeyword = (typeof GENERATED_POSTGRES_SQL_KEYWORDS)[number];
export type PostgresSqlKeywordWord = PostgresSqlKeyword["word"];
export type PostgresSqlKeywordLabel = PostgresSqlKeyword["label"];

export type PlpgsqlKeyword = (typeof GENERATED_PLPGSQL_KEYWORDS)[number];
export type PlpgsqlKeywordWord = PlpgsqlKeyword["word"];
export type PlpgsqlKeywordLabel = PlpgsqlKeyword["label"];

export { PLPGSQL_KEYWORD_SOURCES, POSTGRES_SQL_KEYWORD_SOURCE };

/** Complete PostgreSQL SQL catalog generated from the locked `kwlist.h`. */
export const POSTGRES_SQL_KEYWORDS = GENERATED_POSTGRES_SQL_KEYWORDS;

/** Complete PL/pgSQL catalog; deliberately never merged with the SQL catalog. */
export const PLPGSQL_KEYWORDS = GENERATED_PLPGSQL_KEYWORDS;

const POSTGRES_SQL_KEYWORD_BY_WORD = new Map<string, PostgresSqlKeyword>(
  POSTGRES_SQL_KEYWORDS.map((keyword) => [keyword.word, keyword] as const),
);
const PLPGSQL_KEYWORD_BY_WORD = new Map<string, PlpgsqlKeyword>(
  PLPGSQL_KEYWORDS.map((keyword) => [keyword.word, keyword] as const),
);

export function postgresSqlKeyword(word: string): PostgresSqlKeyword | undefined {
  return POSTGRES_SQL_KEYWORD_BY_WORD.get(word.toLocaleLowerCase());
}

export function plpgsqlKeyword(word: string): PlpgsqlKeyword | undefined {
  return PLPGSQL_KEYWORD_BY_WORD.get(word.toLocaleLowerCase());
}

export function isReservedPostgresSqlKeyword(word: string): boolean {
  return postgresSqlKeyword(word)?.category === "R";
}
