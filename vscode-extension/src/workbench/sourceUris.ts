import type * as vscode from "vscode";
import type { WorkbenchIndexController } from "../../../packages/catalog/src/indexController.js";
import { codeMonikerDocumentUri, codeMonikerIdentityUri, codeMonikerUri } from "../sources/uri.js";

/**
 * Projects the symbols the Workbench Index holds onto the editor documents that show them. The
 * index itself knows nothing of VS Code URIs; this is where a symbol becomes a tab.
 */
export class WorkbenchSourceUris {
  constructor(private readonly index: WorkbenchIndexController) {}

  /**
   * Resolves the VS Code URI projection back to the exact symbol URI Code Moniker returned.
   * VS Code normalizes percent-encoding when it materializes a Uri, so its serialized form is
   * not usable as the identity registry key.
   */
  sourceDescriptorForDocumentUri(uri: vscode.Uri) {
    const documentKey = codeMonikerIdentityUri(uri).toString();
    for (const symbolUri of this.index.symbolUris()) {
      if (codeMonikerUri(symbolUri).toString() === documentKey) {
        return this.index.sourceDescriptor(symbolUri);
      }
    }
    return undefined;
  }

  sourceDocumentUris(): vscode.Uri[] {
    const uris: vscode.Uri[] = [];
    for (const symbolUri of this.index.symbolUris()) {
      const uri = this.documentUri(symbolUri);
      if (uri) uris.push(uri);
    }
    return uris;
  }

  documentUri(symbolUri: string): vscode.Uri | undefined {
    const descriptor = this.index.sourceDescriptor(symbolUri);
    return descriptor ? codeMonikerDocumentUri(descriptor.symbolUri, descriptor) : undefined;
  }

  /** Routine sources of a Connection, keyed by OID, as the debugger expects them. */
  routineSourceUris(serverId: string): Record<string, string> {
    return Object.fromEntries(
      Object.entries(this.index.routineSourceUris(serverId)).map(([oid, symbolUri]) => [
        oid,
        this.documentUri(symbolUri)?.toString() ?? symbolUri,
      ]),
    );
  }
}
