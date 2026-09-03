import { PLPGSQL_KEYWORDS } from "../analysis/postgresKeywordCatalog.js";
import {
  type PostgresPredictorScan,
  scanPostgresPredictorSource,
} from "./postgresPredictorScanner.js";

const PLPGSQL_KEYWORD_BY_WORD = new Map<string, (typeof PLPGSQL_KEYWORDS)[number]>(
  PLPGSQL_KEYWORDS.map((keyword) => [keyword.word, keyword]),
);

/** PL/pgSQL-only vocabulary and lexical entry point for the procedural grammar predictor. */
export const PLPGSQL_PREDICTOR_KEYWORDS = PLPGSQL_KEYWORDS;

export function scanPlpgsqlPredictorSource(
  source: string,
  maxTokens: number,
): PostgresPredictorScan {
  return scanPostgresPredictorSource(
    source,
    {
      identifierTerminal: "T_WORD",
      keywords: PLPGSQL_KEYWORD_BY_WORD,
      remapLookahead: false,
    },
    maxTokens,
  );
}
