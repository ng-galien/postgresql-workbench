import * as vscode from "vscode";
import { plpgsqlRoutineBodyStartLine } from "../../src/analysis/plpgsqlDocument.js";
import type { SyntaxParser } from "../../src/analysis/syntaxTree.js";
import { CODE_MONIKER_URI_SCHEME } from "./codeMonikerUri.js";
import type { ConnectionManager } from "./connectionManager.js";
import { mapPlpgsqlBodyLineToSource } from "./coverageMapping.js";
import type { WorkbenchIndexController } from "./workbenchIndexController.js";

export interface ManagedRoutineDivergence {
  workingCopyDiffersFromDeployed(uri: vscode.Uri): boolean;
}

/**
 * Runs plpgsql_check on canonical Code Moniker routine documents.
 * Graceful degradation: silently no-ops if plpgsql_check is not installed.
 * Skips documents whose working copy diverges from the deployed routine, since
 * plpgsql_check inspects the deployed OID and its lines would not match the buffer.
 */
export class PlpgsqlDiagnosticsProvider implements vscode.Disposable {
  private readonly diagnostics: vscode.DiagnosticCollection;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly plpgsqlCheckAvailable = new Map<string, boolean>();
  private readonly trackedDocuments = new Map<string, { uri: vscode.Uri; serverId: string }>();

  constructor(
    private readonly cm: ConnectionManager,
    private readonly syntaxParser: () => Promise<SyntaxParser>,
    private readonly index: WorkbenchIndexController,
    private readonly divergence?: ManagedRoutineDivergence,
  ) {
    this.diagnostics = vscode.languages.createDiagnosticCollection("postgresql-workbench-check");

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.scheme === CODE_MONIKER_URI_SCHEME) this.check(doc);
      }),
    );
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc.uri.scheme === CODE_MONIKER_URI_SCHEME) this.check(doc);
      }),
    );

    cm.onServerChanged((change) => {
      const changed = new Set(change.serverIds);
      for (const serverId of changed) this.plpgsqlCheckAvailable.delete(serverId);
      for (const [key, tracked] of this.trackedDocuments) {
        if (!changed.has(tracked.serverId)) continue;
        this.diagnostics.delete(tracked.uri);
        this.trackedDocuments.delete(key);
      }
    });
  }

  private async check(document: vscode.TextDocument): Promise<void> {
    const source = this.index.sourceDescriptorForDocumentUri(document.uri);
    if (!source?.plpgsql || !this.cm.isServerConnected(source.serverId)) return;
    this.trackedDocuments.set(document.uri.toString(), {
      uri: document.uri,
      serverId: source.serverId,
    });
    if (this.divergence?.workingCopyDiffersFromDeployed(document.uri)) {
      this.diagnostics.delete(document.uri);
      return;
    }
    const client = this.cm.getClient(source.serverId);
    if (!client) return;

    if (!this.plpgsqlCheckAvailable.has(source.serverId)) {
      try {
        const res = await client.query(
          "SELECT 1 FROM pg_extension WHERE extname = 'plpgsql_check'",
        );
        this.plpgsqlCheckAvailable.set(source.serverId, res.rowCount !== null && res.rowCount > 0);
      } catch {
        this.plpgsqlCheckAvailable.set(source.serverId, false);
      }
    }
    if (!this.plpgsqlCheckAvailable.get(source.serverId)) return;

    const oid = source.oid;

    const text = document.getText();

    try {
      const result = await client.query("SELECT * FROM plpgsql_check_function($1::oid)", [oid]);
      const bodyStartLine = await plpgsqlRoutineBodyStartLine(text, await this.syntaxParser());
      if (bodyStartLine === undefined) {
        this.diagnostics.delete(document.uri);
        return;
      }

      const diags: vscode.Diagnostic[] = [];
      for (const row of result.rows) {
        const bodyLine = Number(row.lineno ?? 1);
        const editorLine = mapPlpgsqlBodyLineToSource(bodyStartLine, bodyLine);
        const severity =
          row.level === "error"
            ? vscode.DiagnosticSeverity.Error
            : row.level === "warning"
              ? vscode.DiagnosticSeverity.Warning
              : vscode.DiagnosticSeverity.Information;

        const range = new vscode.Range(
          Math.max(0, editorLine),
          0,
          Math.max(0, editorLine),
          Number.MAX_SAFE_INTEGER,
        );
        const diag = new vscode.Diagnostic(range, String(row.message), severity);
        diag.source = "plpgsql_check";
        if (row.sqlstate) diag.code = String(row.sqlstate);
        diags.push(diag);
      }

      this.diagnostics.set(document.uri, diags);
    } catch {}
  }

  dispose(): void {
    this.diagnostics.dispose();
    this.trackedDocuments.clear();
    for (const d of this.disposables) d.dispose();
  }
}
