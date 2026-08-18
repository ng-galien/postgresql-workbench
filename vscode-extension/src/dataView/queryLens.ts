import * as vscode from "vscode";
import { DATA_VIEW_QUERY_SCHEME } from "./queryFileSystem.js";

export const APPLY_DATA_VIEW_QUERY_COMMAND = "postgresql-workbench.applyDataViewQuery";

/** One lens on a Data View query document: saving applies the query to its grid. */
export function registerDataViewQueryLens(): vscode.Disposable {
  const provider: vscode.CodeLensProvider = {
    provideCodeLenses(document) {
      return [
        new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
          title: document.isDirty
            ? "$(table) Apply to Data View"
            : "$(table) Data View query · save to apply",
          command: APPLY_DATA_VIEW_QUERY_COMMAND,
          arguments: [document.uri],
          tooltip: "Reload the Data View grid with this query (Ctrl/Cmd+S does the same).",
        }),
      ];
    },
  };
  return vscode.Disposable.from(
    vscode.languages.registerCodeLensProvider(
      { scheme: DATA_VIEW_QUERY_SCHEME, language: "sql" },
      provider,
    ),
    vscode.commands.registerCommand(APPLY_DATA_VIEW_QUERY_COMMAND, async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.toString() === target?.toString(),
      );
      if (!document) return false;
      return document.isDirty ? document.save() : true;
    }),
  );
}
