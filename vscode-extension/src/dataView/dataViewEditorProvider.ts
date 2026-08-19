import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { DataViewSource } from "../../../packages/rows/src/dataView.js";
import type { DataViewRequest } from "../../../packages/views/src/dataView/protocol.js";
import { DataViewDocument } from "./dataViewDocument.js";
import { DATA_VIEW_EDITOR_VIEW_TYPE, dataViewUri, parseDataViewUri } from "./dataViewUri.js";
import { type DataViewHostServices, errorMessage } from "./hostServices.js";

/**
 * VS Code integration of Data Views: the custom editor (one tab per source), its webview HTML,
 * and the routing of apply/discard to native save/revert. Native dirty tracking is used only
 * when VS Code will not save on its own — with auto save on, a dirty custom document would be
 * "saved" (applied to PostgreSQL) without the user asking.
 */
export class DataViewEditorProvider
  implements vscode.CustomEditorProvider<DataViewDocument>, vscode.Disposable
{
  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentEditEvent<DataViewDocument>
  >();
  readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;
  private readonly documents = new Map<string, DataViewDocument>();
  /** Edit subscriptions, released with their tab so a closed Data View keeps no rows alive. */
  private readonly edits = new Map<DataViewDocument, vscode.Disposable>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly services: DataViewHostServices) {
    const refresh = (uri: vscode.Uri) => {
      for (const document of this.documents.values()) {
        if (document.queryUri.toString() === uri.toString()) document.refreshQueryState();
      }
    };
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => refresh(event.document.uri)),
      vscode.workspace.onDidSaveTextDocument((document) => refresh(document.uri)),
      services.onConnectionsChanged((serverIds) => {
        for (const document of this.documents.values()) {
          if (serverIds.length === 0 || serverIds.includes(document.source.serverId)) {
            document.refreshQueryState();
          }
        }
      }),
    );
  }

  register(): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(DATA_VIEW_EDITOR_VIEW_TYPE, this, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  /** Opens (or reveals) the Data View of a source in an editor tab. */
  async open(source: DataViewSource, viewColumn?: vscode.ViewColumn): Promise<void> {
    await vscode.commands.executeCommand(
      "vscode.openWith",
      dataViewUri(source),
      DATA_VIEW_EDITOR_VIEW_TYPE,
      { viewColumn: viewColumn ?? vscode.ViewColumn.Active, preview: false },
    );
  }

  async openCustomDocument(uri: vscode.Uri): Promise<DataViewDocument> {
    const source = parseDataViewUri(uri);
    if (!source) throw new Error("This Data View link is not valid.");
    const document = new DataViewDocument(uri, source, this.services, usesNativeDirtyTracking);
    this.documents.set(uri.toString(), document);
    this.edits.set(
      document,
      document.onDidEdit((edit) => this._onDidChangeCustomDocument.fire({ document, ...edit })),
    );
    return document;
  }

  async resolveCustomEditor(document: DataViewDocument, panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.services.extensionUri, "dist")],
    };
    panel.title = document.title;
    // Same visual identity as the object's tab and tree node.
    const iconKind =
      document.source.kind === "relation" && document.source.relationKind === "view"
        ? "postgresql-view"
        : "postgresql-table";
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.services.extensionUri, "icons", `${iconKind}-light.svg`),
      dark: vscode.Uri.joinPath(this.services.extensionUri, "icons", `${iconKind}-dark.svg`),
    };
    panel.webview.html = dataViewHtml(panel.webview, this.services.extensionUri);
    const attachment = document.attach(panel.webview);
    const messages = panel.webview.onDidReceiveMessage((message: DataViewRequest) => {
      if (message.type === "data-view/apply") {
        if (usesNativeDirtyTracking()) {
          panel.reveal(panel.viewColumn, false);
          void vscode.commands.executeCommand("workbench.action.files.save");
        } else {
          void document.apply().catch((error) => {
            void vscode.window.showErrorMessage(errorMessage(error));
          });
        }
        return;
      }
      if (message.type === "data-view/discard") {
        if (usesNativeDirtyTracking()) {
          panel.reveal(panel.viewColumn, false);
          void vscode.commands.executeCommand("workbench.action.files.revert");
        } else {
          document.discard();
        }
        return;
      }
      void document.handle(message).catch((error) => {
        this.services.output.appendLine(`Data View request failed: ${errorMessage(error)}`);
      });
    });
    panel.onDidDispose(() => {
      attachment.dispose();
      messages.dispose();
      this.edits.get(document)?.dispose();
      this.edits.delete(document);
      if (this.documents.get(document.uri.toString()) === document) {
        this.documents.delete(document.uri.toString());
      }
      document.dispose();
    });
  }

  async saveCustomDocument(document: DataViewDocument): Promise<void> {
    await document.apply();
  }

  async saveCustomDocumentAs(): Promise<void> {
    throw new Error("A Data View applies its changes to PostgreSQL; it cannot be saved as a file.");
  }

  async revertCustomDocument(document: DataViewDocument): Promise<void> {
    document.discard();
  }

  async backupCustomDocument(
    _document: DataViewDocument,
    context: vscode.CustomDocumentBackupContext,
  ): Promise<vscode.CustomDocumentBackup> {
    // Data Views are temporary: pending edits are not persisted across restarts.
    return { id: context.destination.toString(), delete: () => {} };
  }

  dispose(): void {
    for (const document of this.documents.values()) document.dispose();
    this.documents.clear();
    for (const subscription of this.edits.values()) subscription.dispose();
    this.edits.clear();
    for (const disposable of this.disposables) disposable.dispose();
    this._onDidChangeCustomDocument.dispose();
  }
}

/** Native dirty/save integration is only safe when VS Code will not save on its own. */
function usesNativeDirtyTracking(): boolean {
  return vscode.workspace.getConfiguration("files").get<string>("autoSave", "off") === "off";
}

function dataViewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "data-view.js"));
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
  <title>Data View</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
