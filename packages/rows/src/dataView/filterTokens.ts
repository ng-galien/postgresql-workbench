import { type SqlQueryAnalysis, setWhere } from "../../../sql/src/query/analysis.js";

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
const END_MARK = "\u0001";

export interface FilterDocumentProjection {
  prefix: string;
  suffix: string;
}

/**
 * Surrounding SQL for a filter document whose visible text is only the condition. Both boundaries
 * are found in one engine rewrite, so the language server never guesses where the fragment lands.
 */
export function filterDocumentProjection(
  queryText: string,
  analysis: SqlQueryAnalysis,
): FilterDocumentProjection | undefined {
  const marked = setWhere(queryText, analysis, `${MARK}${END_MARK}`);
  const start = marked.indexOf(MARK);
  const end = marked.indexOf(END_MARK);
  if (start < 0 || end < start) return undefined;
  return {
    prefix: marked.slice(0, start),
    suffix: marked.slice(end + END_MARK.length),
  };
}
