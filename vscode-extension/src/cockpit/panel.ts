import * as vscode from "vscode";
import type {
  WorkbenchGraphHostMessage,
  WorkbenchGraphWebviewMessage,
} from "../../../packages/views/src/cockpit/protocol.js";
import viewBundles from "../../../packages/views/viewBundles.json" with { type: "json" };
import { sqlEditorWebviewPage } from "../sqlEditorWebviewPage.js";
import { webviewShell } from "../webviewShell.js";

export class WorkbenchGraphPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (message: WorkbenchGraphWebviewMessage) => void,
    private readonly onDispose: () => void,
    private readonly sqlEditorLanguageServerUrl: () => string,
    private readonly collectRenderEvidence = false,
  ) {}

  get current(): vscode.WebviewPanel | undefined {
    return this.panel;
  }

  get visible(): boolean {
    return this.panel?.visible ?? false;
  }

  ensure(database: string): vscode.WebviewPanel {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active, false);
      return this.panel;
    }
    const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
    const panel = vscode.window.createWebviewPanel(
      "postgresql-workbench.graph",
      database,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [dist] },
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, "icons", "sql-cockpit-light.svg"),
      dark: vscode.Uri.joinPath(this.extensionUri, "icons", "sql-cockpit-dark.svg"),
    };
    panel.webview.html = graphHtml(
      panel.webview,
      this.extensionUri,
      this.collectRenderEvidence,
      this.sqlEditorLanguageServerUrl(),
    );
    panel.onDidDispose(() => {
      if (this.panel !== panel) return;
      this.panel = undefined;
      this.onDispose();
    });
    panel.webview.onDidReceiveMessage(this.onMessage);
    this.panel = panel;
    return panel;
  }

  reveal(): void {
    this.panel?.reveal(vscode.ViewColumn.Active, false);
  }

  post(message: WorkbenchGraphHostMessage): Thenable<boolean> | undefined {
    return this.panel?.webview.postMessage(message);
  }

  setTitle(title: string): void {
    if (this.panel) this.panel.title = title;
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }
}

/** The Cockpit graph page: a linked stylesheet, and the evidence flag the acceptance suite reads. */
function graphHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  collectRenderEvidence: boolean,
  languageServerUrl: string,
): string {
  const editor = sqlEditorWebviewPage(webview, extensionUri, languageServerUrl);
  return webviewShell({
    webview,
    extensionUri,
    title: "PostgreSQL Graph",
    script: viewBundles.cockpitGraph.script,
    stylesheet: viewBundles.cockpitGraph.stylesheet,
    extraCsp: editor.extraCsp,
    globals: {
      ...editor.globals,
      __PLPGSQL_GRAPH_EVIDENCE__: collectRenderEvidence,
    },
  });
}
