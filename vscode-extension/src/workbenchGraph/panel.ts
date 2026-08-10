import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { WorkbenchGraphHostMessage, WorkbenchGraphWebviewMessage } from "./protocol.js";

export class WorkbenchGraphPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (message: WorkbenchGraphWebviewMessage) => void,
    private readonly onDispose: () => void,
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
    panel.webview.html = graphHtml(panel.webview, this.extensionUri, this.collectRenderEvidence);
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

function graphHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  collectRenderEvidence: boolean,
): string {
  const nonce = randomBytes(16).toString("base64");
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "workbench-graph.js"),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "workbench-graph.css"),
  );
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `connect-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link href="${styleUri}" rel="stylesheet">
  <title>PostgreSQL Graph</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">globalThis.__PLPGSQL_GRAPH_EVIDENCE__ = ${JSON.stringify(collectRenderEvidence)};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
