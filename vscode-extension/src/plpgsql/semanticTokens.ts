import * as vscode from "vscode";
import type { SyntaxParser } from "../../../packages/sql/src/analysis/syntaxTree.js";
import { analyzePlpgsqlDocument } from "../../../packages/sql/src/routines/documentAnalysis.js";
import { plpgsqlSemanticTokens } from "../../../packages/sql/src/routines/semanticTokens.js";
import { TOKEN_MODIFIERS, TOKEN_TYPES } from "../../../packages/sql/src/text/plpgsqlTokenLegend.js";

export const LEGEND = new vscode.SemanticTokensLegend([...TOKEN_TYPES], [...TOKEN_MODIFIERS]);

/**
 * VS Code's way of asking for a PL/pgSQL body's own names. What the names are is answered by the
 * row of tokens the engine returns; this adapts that row to the shape VS Code takes them in, and
 * holds nothing else — the same answer serves a host that has no VS Code to register with.
 */
export class PlpgsqlSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeSemanticTokens = this._onDidChange.event;

  constructor(private readonly syntaxParser: () => Promise<SyntaxParser>) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  async provideDocumentSemanticTokens(
    document: vscode.TextDocument,
  ): Promise<vscode.SemanticTokens> {
    const builder = new vscode.SemanticTokensBuilder(LEGEND);
    for (const token of await this.tokens(document)) {
      builder.push(
        token.line,
        token.character,
        token.length,
        token.tokenType,
        token.tokenModifiers,
      );
    }
    return builder.build();
  }

  /** The names of every routine in this document, as the engine reads them. */
  async tokens(document: vscode.TextDocument) {
    const routines = await analyzePlpgsqlDocument(document, await this.syntaxParser());
    return plpgsqlSemanticTokens(document.getText(), routines);
  }
}
