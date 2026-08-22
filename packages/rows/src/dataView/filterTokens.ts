import { type SqlQueryAnalysis, setWhere } from "../../../sql/src/query/analysis.js";
import { offsetAtPosition, positionAtOffset } from "../../../sql/src/text/positions.js";
import type { DataViewSqlToken } from "./dataViewProtocol.js";

/**
 * A condition on its own is not a statement: `brand.name LIKE 'F%'` names an alias no server can
 * resolve without the FROM clause it belongs to. So everything asked about the filter — what to
 * propose in it, and how to colour it — is asked about a copy of the query carrying it, and the
 * answer is carried back to where the reader typed.
 *
 * The condition is marked in that copy with a character SQL cannot hold, so where it landed is
 * found rather than guessed from what the WHERE looked like before.
 */
const MARK = "\u0000";

export interface FilterDraft {
  /** The query as it would be with this condition in its WHERE. */
  text: string;
  /** Where the condition starts in it. */
  start: number;
}

/** The query with a condition in its WHERE, and where that condition landed. */
export function filterDraft(
  queryText: string,
  analysis: SqlQueryAnalysis,
  condition: string,
): FilterDraft | undefined {
  const draft = setWhere(queryText, analysis, `${MARK}${condition || " "}`);
  const start = draft.indexOf(MARK);
  return start < 0 ? undefined : { text: draft.replace(MARK, ""), start };
}

/**
 * The tokens of a draft that fall inside the condition, counted from the condition's own start:
 * what the filter input needs to colour what a reader typed, and nothing about the query holding
 * it. A token straddling the edge belongs to the query, not to the condition, and is left there.
 */
export function tokensWithinFilter(
  tokens: readonly DataViewSqlToken[],
  draft: FilterDraft,
  condition: string,
): DataViewSqlToken[] {
  const end = draft.start + condition.length;
  return tokens.flatMap((token) => {
    const at = offsetAtPosition(draft.text, token);
    if (at < draft.start || at + token.length > end) return [];
    const { line, character } = positionAtOffset(condition, at - draft.start);
    return [{ line, character, length: token.length, type: token.type }];
  });
}

/**
 * The tokens of the condition being typed, asked of whoever can answer for a SQL text: the
 * extension asks a document it owns, the shell asks the language server directly. Everything
 * around that question — the draft, and carrying the answer back — is the same either way.
 */
export async function filterTokensOf(options: {
  queryText: string;
  analysis: SqlQueryAnalysis | undefined;
  text: string;
  ask(sql: string): Promise<readonly DataViewSqlToken[]>;
}): Promise<DataViewSqlToken[]> {
  if (!options.analysis) return [];
  const draft = filterDraft(options.queryText, options.analysis, options.text);
  if (!draft) return [];
  return tokensWithinFilter(await options.ask(draft.text), draft, options.text);
}
