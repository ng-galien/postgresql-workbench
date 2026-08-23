import * as vscode from "vscode";
import type { DebugResultStore } from "../../../packages/rows/src/capturedResults.js";
import type {
  DebugResultsRequest,
  DebugResultsResponse,
} from "../../../packages/views/src/debugResults/protocol.js";
import viewBundles from "../../../packages/views/viewBundles.json" with { type: "json" };
import { followLinkFromView } from "../followLink.js";
import { webviewPage } from "../webviewPage.js";

export const DEBUG_RESULTS_VIEW_ID = "postgresql-workbench-results";
const DEBUG_RESULTS_CONTAINER_COMMAND =
  "workbench.view.extension.postgresql-workbench-results-container";

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
    view.webview.html = webviewPage({
      webview: view.webview,
      extensionUri: this.extensionUri,
      title: "Debug results",
      script: viewBundles.debugResults.script,
    });
    view.webview.onDidReceiveMessage(async (message: DebugResultsRequest) => {
      if (message.type === "ready") this.update();
      else if (message.type === "select") this.store.select(message.id);
      else if (message.type === "copy") await this.copySelection(view.webview);
      else if (message.type === "openSource") await this.openSelectedSource();
      else await followLinkFromView(message);
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
    this.post({ type: "state", state: this.store.viewState() });
  }

  /** The Extension Host holds the selection, so it encodes the export the same way it exports. */
  private async copySelection(webview: vscode.Webview): Promise<void> {
    const tsv = this.store.selectedAsTsv();
    if (tsv === undefined) return;
    await vscode.env.clipboard.writeText(tsv);
    await webview.postMessage({ type: "copyResult", ok: true } satisfies DebugResultsResponse);
  }

  private post(message: DebugResultsResponse): void {
    void this.view?.webview.postMessage(message);
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
