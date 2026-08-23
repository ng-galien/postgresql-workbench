import type { SqlQueryAnalysis } from "../../../sql/src/query/analysis.js";
import type { DataViewCompletion } from "./dataView.js";

/**
 * What the WHERE input proposes when no language server answers: the columns the query already
 * projects. Pure, so a harness with no VS Code proposes the same things the product falls back to.
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
