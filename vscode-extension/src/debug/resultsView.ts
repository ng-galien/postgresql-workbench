import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { DebugResultStore } from "../../../packages/dap/src/debugger/launch/capturedResults.js";

export const DEBUG_RESULTS_VIEW_ID = "postgresql-workbench-results";
const DEBUG_RESULTS_CONTAINER_COMMAND =
  "workbench.view.extension.postgresql-workbench-results-container";

interface ResultsWebviewMessage {
  type?: string;
  id?: string;
  text?: string;
}

export class DebugResultsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly storeSubscription: { dispose(): void };

  constructor(
    private readonly store: DebugResultStore,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.storeSubscription = store.onDidChange(() => this.update());
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };
    view.webview.html = debugResultsHtml(view.webview, this.extensionUri);
    view.webview.onDidReceiveMessage(async (message: ResultsWebviewMessage) => {
      if (message.type === "ready") {
        this.update();
      } else if (message.type === "select" && message.id) {
        this.store.select(message.id);
      } else if (message.type === "copy" && typeof message.text === "string") {
        await vscode.env.clipboard.writeText(message.text);
        await view.webview.postMessage({ type: "copyResult", ok: true });
      } else if (message.type === "openSource") {
        await this.openSelectedSource();
      }
    });
    this.update();
  }

  reveal(preserveFocus = true): void {
    if (this.view) {
      this.view.show(preserveFocus);
      return;
    }
    void vscode.commands.executeCommand(DEBUG_RESULTS_CONTAINER_COMMAND).then(
      () => this.view?.show(preserveFocus),
      () => vscode.commands.executeCommand(`${DEBUG_RESULTS_VIEW_ID}.focus`),
    );
  }

  get visible(): boolean {
    return this.view?.visible ?? false;
  }

  dispose(): void {
    this.storeSubscription.dispose();
  }

  private update(): void {
    void this.view?.webview.postMessage({
      type: "state",
      state: this.store.viewState(),
    });
  }

  private async openSelectedSource(): Promise<void> {
    const source = this.store.selectedEntry?.source;
    if (!source?.uri) return;
    const uri = vscode.Uri.parse(source.uri);
    const line = Math.max(0, (source.line ?? 1) - 1);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, {
      preview: false,
      selection: new vscode.Range(line, 0, line, 0),
    });
  }
}

/** The shell that loads the shared result grid; everything it renders lives in packages/views. */
function debugResultsHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "debug-results.js"),
  );
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Debug results</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
