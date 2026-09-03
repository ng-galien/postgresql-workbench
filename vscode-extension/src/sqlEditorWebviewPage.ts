import * as vscode from "vscode";

const RUNTIME_GLOBAL = "__POSTGRESQL_WORKBENCH_SQL_EDITOR__";

/** Monaco runtime materialized by the VS Code host for one webview page. */
export function sqlEditorWebviewPage(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  languageServerUrl: string,
): {
  extraCsp: readonly string[];
  globals: Readonly<Record<string, unknown>>;
} {
  const endpoint = new URL(languageServerUrl);
  if ((endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") || endpoint.pathname === "/") {
    throw new Error("The SQL editor endpoint must be an authenticated WebSocket URL.");
  }
  const editorWorkerUrl = webview
    .asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "editor.worker.js"))
    .toString();
  return {
    extraCsp: [`connect-src ${endpoint.origin}`, `worker-src ${webview.cspSource} blob:`],
    globals: {
      [RUNTIME_GLOBAL]: { languageServerUrl, editorWorkerUrl },
    },
  };
}
