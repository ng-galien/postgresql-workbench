import type { SqlAuthoringClient } from "../../../sql/src/languageServer/client.js";
import type { SqlQueryAnalysis } from "../../../sql/src/query/analysis.js";
import { scanPostgresSql } from "../../../sql/src/text/sqlLexing.js";
import type { DataViewCompletion } from "./dataView.js";
import { filterDraft } from "./filterTokens.js";

/**
 * What the WHERE input proposes.
 *
 * The condition a reader types is not a statement, so nothing could be proposed against it on its
 * own: it is placed in a draft of the real query, with the real FROM clause, and the server is
 * asked at that position — it then proposes against the relations the query actually names. Every
 * surface showing a Data View does this the same way, because the answer is the server's and the
 * draft is the engine's; what a surface supplies is the client that carries the question.
 */
export async function dataViewFilterProposals(options: {
  queryText: string;
  analysis: SqlQueryAnalysis;
  text: string;
  offset: number;
  /** Where the draft is put in front of the server. */
  uri: string;
  /** The client that asks it, when there is one to ask. */
  ask: SqlAuthoringClient | undefined;
}): Promise<DataViewCompletion[]> {
  const { analysis, text, offset } = options;
  const draft = filterDraft(options.queryText, analysis, text);
  if (!draft || !options.ask) return localFilterCompletions(analysis, text, offset);
  const caret = draft.start + Math.min(offset, text.length);
  if (insideLiteralOrComment(draft.text, caret)) return [];
  const proposals = await options.ask.complete(options.uri, draft.text, caret);
  return proposals.length > 0 ? proposals : localFilterCompletions(analysis, text, offset);
}

/**
 * Whether the caret sits in a string literal or a comment, where nothing can be proposed. Decided
 * before the round trip rather than after it, and decided by the lexer that already knows: what it
 * masks is exactly what is not code.
 */
function insideLiteralOrComment(candidate: string, caret: number): boolean {
  const masked = scanPostgresSql(candidate).maskedSource;
  let index = caret - 1;
  while (index >= 0 && candidate[index] === " ") index -= 1;
  return index >= 0 && masked[index] === " " && candidate[index] !== " ";
}

/**
 * What the WHERE input proposes when no language server answers: the columns the query already
 * projects. Pure, so a surface with no server proposes the same things the product falls back to.
 */
export function localFilterCompletions(
  analysis: SqlQueryAnalysis,
  text: string,
  offset: number,
  replaceLength = wordLengthBefore(text, offset),
): DataViewCompletion[] {
  const fragment = text.slice(Math.max(0, offset - replaceLength), offset).toLowerCase();
  const seen = new Set<string>();
  const items: DataViewCompletion[] = [];
  for (const target of analysis.targets) {
    for (const candidate of [target.label, target.expression]) {
      if (seen.has(candidate) || (fragment && !candidate.toLowerCase().includes(fragment))) {
        continue;
      }
      seen.add(candidate);
      items.push({
        label: candidate,
        insertText: candidate,
        kind: "Field",
        detail: candidate === target.label ? "column" : "projection",
        replaceLength,
      });
    }
  }
  return items;
}

/** How much of the typed text a proposal replaces: the identifier the caret sits at the end of. */
function wordLengthBefore(text: string, offset: number): number {
  const before = text.slice(0, offset);
  return /[\w$"]*$/u.exec(before)?.[0].length ?? 0;
}
