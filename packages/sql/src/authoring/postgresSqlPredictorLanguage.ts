import { POSTGRES_SQL_KEYWORDS } from "../analysis/postgresKeywordCatalog.js";
import {
  type PostgresPredictorScan,
  scanPostgresPredictorSource,
} from "./postgresPredictorScanner.js";

const POSTGRES_SQL_KEYWORD_BY_WORD = new Map<string, (typeof POSTGRES_SQL_KEYWORDS)[number]>(
  POSTGRES_SQL_KEYWORDS.map((keyword) => [keyword.word, keyword]),
);

/** SQL-only vocabulary and lexical entry point for the PostgreSQL grammar predictor. */
export const POSTGRES_SQL_PREDICTOR_KEYWORDS = POSTGRES_SQL_KEYWORDS;

export function scanPostgresSqlPredictorSource(
  source: string,
  maxTokens: number,
): PostgresPredictorScan {
  return scanPostgresPredictorSource(
    source,
    {
      identifierTerminal: "IDENT",
      keywords: POSTGRES_SQL_KEYWORD_BY_WORD,
      remapLookahead: true,
    },
    maxTokens,
  );
}
