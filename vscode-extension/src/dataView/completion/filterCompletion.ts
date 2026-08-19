import * as vscode from "vscode";
import type { DataViewCompletion } from "../../../../packages/rows/src/dataView.js";
import { type SqlQueryAnalysis, setWhere } from "../../../../packages/sql/src/query/analysis.js";
import { scanPostgresSql } from "../../../../packages/sql/src/text/sqlLexing.js";

/**
 * Completions for the WHERE input: the typed condition is placed in a hidden copy of the query
 * (a real SQL document the SQL authoring server sees, with the real FROM clause), VS Code's
 * completion providers are asked at that position, and their proposals are mapped back to the
 * input. Nothing is proposed inside a string literal or a comment.
 */
export async function completeDataViewFilter(options: {
  queryText: string;
  analysis: SqlQueryAnalysis;
  completionUri: vscode.Uri;
  text: string;
  offset: number;
  log(message: string): void;
}): Promise<DataViewCompletion[]> {
  const { queryText, analysis, completionUri, text, offset } = options;
  // A sentinel marks where the typed condition lands, whatever the current WHERE looks like.
  const sentinel = "\u0000";
  const draft = setWhere(queryText, analysis, `${sentinel}${text || " "}`);
  const expressionStart = draft.indexOf(sentinel);
  if (expressionStart < 0) return [];
  const candidate = draft.replace(sentinel, "");
  const caret = expressionStart + Math.min(offset, text.length);
  // Inside a literal or a comment nothing can be proposed: decided before paying for the round-trip.
  const masked = scanPostgresSql(candidate).maskedSource;
  let probeIndex = caret - 1;
  while (probeIndex >= 0 && candidate[probeIndex] === " ") probeIndex -= 1;
  if (probeIndex >= 0 && masked[probeIndex] === " " && candidate[probeIndex] !== " ") return [];
  const document = await vscode.workspace.openTextDocument(completionUri);
  if (document.languageId !== "sql")
    await vscode.languages.setTextDocumentLanguage(document, "sql");
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    completionUri,
    new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
    candidate,
  );
  await vscode.workspace.applyEdit(edit);
  const position = document.positionAt(caret);
  const result = await vscode.commands.executeCommand<vscode.CompletionList | undefined>(
    "vscode.executeCompletionItemProvider",
    completionUri,
    position,
    undefined,
    40,
  );
  const wordRange = document.getWordRangeAtPosition(position, /[\w$"]+/u);
  const defaultReplace = wordRange
    ? document.offsetAt(position) - document.offsetAt(wordRange.start)
    : 0;
  const items = result?.items ?? [];
  options.log(`${items.length} completions at offset ${offset}`);
  if (items.length === 0 && defaultReplace > 0) {
    return localFilterCompletions(analysis, text, offset, defaultReplace);
  }
  return items.map((item) => {
    const label = typeof item.label === "string" ? item.label : item.label.label;
    const insert =
      typeof item.insertText === "string"
        ? item.insertText
        : item.insertText instanceof vscode.SnippetString
          ? item.insertText.value.replace(/\$\{?\d+[^}]*\}?/gu, "")
          : label;
    const range = item.range
      ? "inserting" in item.range
        ? item.range.inserting
        : item.range
      : undefined;
    const replaceLength = range
      ? document.offsetAt(position) - document.offsetAt(range.start)
      : defaultReplace;
    return {
      label,
      insertText: insert,
      ...(item.detail ? { detail: item.detail } : {}),
      ...(item.kind !== undefined ? { kind: vscode.CompletionItemKind[item.kind] } : {}),
      replaceLength: Math.max(0, replaceLength),
    };
  });
}

/** Fallback when the SQL authoring server has no context: the projection's own columns. */
export function localFilterCompletions(
  analysis: SqlQueryAnalysis,
  text: string,
  offset: number,
  replaceLength: number,
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
