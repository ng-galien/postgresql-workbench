import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  Uri: {
    joinPath: (base: string, ...parts: string[]) => [base, ...parts].join("/"),
  },
}));

import { sqlEditorWebviewPage } from "./sqlEditorWebviewPage.js";

describe("the VS Code SQL editor webview projection", () => {
  it("injects the authenticated LSP endpoint and official Monaco worker under a bounded CSP", () => {
    const page = sqlEditorWebviewPage(
      {
        asWebviewUri: (uri: string) => `vscode-webview:${uri}`,
        cspSource: "vscode-webview:",
      } as never,
      "/extension" as never,
      "ws://127.0.0.1:3210/secret",
    );

    expect(page.extraCsp).toEqual([
      "connect-src ws://127.0.0.1:3210",
      "worker-src vscode-webview: blob:",
    ]);
    expect(page.globals).toEqual({
      __POSTGRESQL_WORKBENCH_SQL_EDITOR__: {
        languageServerUrl: "ws://127.0.0.1:3210/secret",
        editorWorkerUrl: "vscode-webview:/extension/dist/editor.worker.js",
      },
    });
  });
});
