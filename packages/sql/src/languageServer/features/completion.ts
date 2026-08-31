import {
  type CompletionItem,
  CompletionItemKind,
  type CompletionList,
  InsertTextFormat,
  TextEdit,
} from "vscode-languageserver";
import type {
  PostgresAuthoringProposal,
  PostgresCompletionPlan,
} from "../../authoring/completion.js";
import type { ProjectedSqlDocument } from "../documentProjection.js";

/**
 * Final LSP projection of an autonomous authoring plan. This adapter never derives language
 * expectations, scans SQL, or widens a failed plan; it only translates ranges and item kinds.
 */
export function postgresCompletionList(
  plan: PostgresCompletionPlan,
  document: ProjectedSqlDocument,
): CompletionList {
  if (plan.status !== "available") return { isIncomplete: false, items: [] };
  return {
    isIncomplete: plan.isIncomplete,
    items: plan.proposals.flatMap((proposal, index) => {
      const range = visibleReplacementRange(proposal, document);
      if (!range) return [];
      const insertion = completionInsertion(proposal);
      const item: CompletionItem = {
        label: proposal.label,
        kind: completionItemKind(proposal),
        ...(proposal.detail === undefined ? {} : { detail: proposal.detail }),
        insertTextFormat: insertion.snippet ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
        textEdit: TextEdit.replace(range, insertion.text),
        sortText: `${proposal.rankGroup}-${String(index).padStart(6, "0")}`,
        ...(proposal.triggerSuggestionsAfterInsert
          ? {
              command: {
                title: "Trigger Suggest",
                command: "editor.action.triggerSuggest",
              },
            }
          : {}),
      };
      return [item];
    }),
  };
}

function visibleReplacementRange(
  proposal: PostgresAuthoringProposal,
  document: ProjectedSqlDocument,
) {
  const { start, end } = proposal.documentReplacementRange;
  if (start < document.visibleStart || end > document.visibleEnd || end < start) return undefined;
  return {
    start: document.visible.positionAt(start - document.visibleStart),
    end: document.visible.positionAt(end - document.visibleStart),
  };
}

function completionInsertion(proposal: PostgresAuthoringProposal): {
  text: string;
  snippet: boolean;
} {
  if (proposal.insertion.kind === "text") {
    return { text: proposal.insertion.text, snippet: false };
  }
  const argumentsText = proposal.insertion.arguments
    .map((argument, index) => `\${${index + 1}:${escapeSnippetPlaceholder(argument.placeholder)}}`)
    .join(", ");
  return { text: `${proposal.insertion.callee}(${argumentsText})`, snippet: true };
}

function escapeSnippetPlaceholder(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("$", "\\$").replaceAll("}", "\\}");
}

function completionItemKind(proposal: PostgresAuthoringProposal): CompletionItemKind {
  switch (proposal.kind) {
    case "keyword":
      return CompletionItemKind.Keyword;
    case "schema":
      return CompletionItemKind.Module;
    case "relation":
      return proposal.source.kind === "catalog-object" && proposal.source.object.kind === "view"
        ? CompletionItemKind.Interface
        : CompletionItemKind.Class;
    case "column":
      return CompletionItemKind.Field;
    case "routine":
      return CompletionItemKind.Function;
    case "type":
      return CompletionItemKind.TypeParameter;
    case "cte":
      return CompletionItemKind.Struct;
    case "window":
    case "alias":
    case "binding":
    case "variable":
    case "parameter":
      return CompletionItemKind.Variable;
  }
}
