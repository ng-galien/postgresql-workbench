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
import { type ProjectedSqlDocument, visibleRangeOf } from "../documentProjection.js";

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
      const range = visibleRangeOf(document, proposal.documentReplacementRange);
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

function completionInsertion(proposal: PostgresAuthoringProposal): {
  text: string;
  snippet: boolean;
} {
  if (proposal.insertion.kind === "text") {
    return { text: proposal.insertion.text, snippet: false };
  }
  if (proposal.insertion.kind === "scaffold") {
    return { text: proposal.insertion.snippet, snippet: true };
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
    case "scaffold":
      return CompletionItemKind.Snippet;
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
