import * as vscode from "vscode";
import { mapPlpgsqlBodyLineToSource } from "../../../packages/coverage/src/index.js";
import { plpgsqlRoutineBodyStartLine } from "../../../packages/sql/src/analysis/plpgsqlDocument.js";
import type { SyntaxParser } from "../../../packages/sql/src/analysis/syntaxTree.js";
import type { ConnectionManager } from "../connection/index.js";
import { CODE_MONIKER_URI_SCHEME } from "../sources/index.js";
import type { WorkbenchSourceUris } from "../workbench/sourceUris.js";

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
  private readonly trackedDocuments = new Map<string, { uri: vscode.Uri; connectionId: string }>();

  constructor(
    private readonly cm: ConnectionManager,
    private readonly syntaxParser: () => Promise<SyntaxParser>,
    private readonly sourceUris: WorkbenchSourceUris,
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

    cm.onConnectionChanged((change) => {
      const changed = new Set(change.connectionIds);
      for (const connectionId of changed) this.plpgsqlCheckAvailable.delete(connectionId);
      for (const [key, tracked] of this.trackedDocuments) {
        if (!changed.has(tracked.connectionId)) continue;
        this.diagnostics.delete(tracked.uri);
        this.trackedDocuments.delete(key);
      }
    });
  }

  private async check(document: vscode.TextDocument): Promise<void> {
    const source = this.sourceUris.sourceDescriptorForDocumentUri(document.uri);
    if (!source?.plpgsql || !this.cm.isConnectionConnected(source.connectionId)) return;
    this.trackedDocuments.set(document.uri.toString(), {
      uri: document.uri,
      connectionId: source.connectionId,
    });
    if (this.divergence?.workingCopyDiffersFromDeployed(document.uri)) {
      this.diagnostics.delete(document.uri);
      return;
    }
    const client = this.cm.getClient(source.connectionId);
    if (!client) return;

    if (!this.plpgsqlCheckAvailable.has(source.connectionId)) {
      try {
        const res = await client.query(
          "SELECT 1 FROM pg_extension WHERE extname = 'plpgsql_check'",
        );
        this.plpgsqlCheckAvailable.set(
          source.connectionId,
          res.rowCount !== null && res.rowCount > 0,
        );
      } catch {
        this.plpgsqlCheckAvailable.set(source.connectionId, false);
      }
    }
    if (!this.plpgsqlCheckAvailable.get(source.connectionId)) return;

    try {
      const result = await client.query("SELECT * FROM plpgsql_check_function($1::oid)", [
        source.oid,
      ]);
      const bodyStartLine = await plpgsqlRoutineBodyStartLine(
        document.getText(),
        await this.syntaxParser(),
      );
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
