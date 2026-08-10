import * as vscode from "vscode";
import { plpgsqlRoutineBodyStartLine } from "../../src/analysis/plpgsqlDocument.js";
import type { SyntaxParser } from "../../src/analysis/syntaxTree.js";
import { CODE_MONIKER_URI_SCHEME } from "./codeMonikerUri.js";
import type { ConnectionManager } from "./connectionManager.js";
import { mapPlpgsqlBodyLineToSource } from "./coverageMapping.js";
import type { WorkbenchIndexController } from "./workbenchIndexController.js";

/**
 * Runs plpgsql_check on canonical Code Moniker routine documents.
 * Graceful degradation: silently no-ops if plpgsql_check is not installed.
 */
export class PlpgsqlDiagnosticsProvider implements vscode.Disposable {
  private readonly diagnostics: vscode.DiagnosticCollection;
  private readonly disposables: vscode.Disposable[] = [];
  private plpgsqlCheckAvailable: boolean | undefined;

  constructor(
    private readonly cm: ConnectionManager,
    private readonly syntaxParser: () => Promise<SyntaxParser>,
    private readonly index: WorkbenchIndexController,
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

    cm.onServerChanged(() => {
      this.diagnostics.clear();
      this.plpgsqlCheckAvailable = undefined;
    });
  }

  private async check(document: vscode.TextDocument): Promise<void> {
    const source = this.index.sourceDescriptorForDocumentUri(document.uri);
    if (!source?.plpgsql || source.serverId !== this.cm.activeServer?.id) return;
    const client = this.cm.getClient();
    if (!client) return;

    if (this.plpgsqlCheckAvailable === undefined) {
      try {
        const res = await client.query(
          "SELECT 1 FROM pg_extension WHERE extname = 'plpgsql_check'",
        );
        this.plpgsqlCheckAvailable = res.rowCount !== null && res.rowCount > 0;
      } catch {
        this.plpgsqlCheckAvailable = false;
      }
    }
    if (!this.plpgsqlCheckAvailable) return;

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
    for (const d of this.disposables) d.dispose();
  }
}
