import * as vscode from "vscode";
import type { SyntaxParser } from "../../src/analysis/syntaxTree.js";
import { analyzePlpgsqlDocument, findIdentifierColumns } from "./plpgsqlDocumentAnalysis.js";

export const TOKEN_TYPES = ["variable", "parameter", "type", "function"] as const;
export const TOKEN_MODIFIERS = ["declaration", "readonly"] as const;

export const LEGEND = new vscode.SemanticTokensLegend([...TOKEN_TYPES], [...TOKEN_MODIFIERS]);

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
    const text = document.getText();
    const lines = text.split("\n");

    for (const routine of await analyzePlpgsqlDocument(document, await this.syntaxParser())) {
      const vars = routine.variables;
      if (vars.length === 0) continue;

      const varNames = new Set(vars.map((v) => v.name));

      const varMap = new Map(vars.map((v) => [v.name, v]));

      for (const v of vars) {
        if (v.isParam || v.declareLine === 0) continue;
        const absLine = routine.bodyStartLine + v.declareLine - 1;
        if (absLine >= lines.length) continue;
        const line = lines[absLine];

        const cols = findIdentifierColumns(line, v.name);
        for (const col of cols) {
          const typeIdx = TOKEN_TYPES.indexOf("variable");
          const modIdx = [
            TOKEN_MODIFIERS.indexOf("declaration"),
            ...(v.isConst ? [TOKEN_MODIFIERS.indexOf("readonly")] : []),
          ].reduce((acc, i) => acc | (1 << i), 0);
          builder.push(absLine, col, v.name.length, typeIdx, modIdx);
        }

        if (v.typeName) {
          const typeCols = findIdentifierColumns(line, v.typeName.split(".").pop()!);
          for (const col of typeCols) {
            builder.push(absLine, col, v.typeName.length, TOKEN_TYPES.indexOf("type"), 0);
          }
        }
      }

      const bodyStart = routine.bodyStartLine;
      const bodyEnd = routine.bodyEndLine;

      for (let lineIdx = bodyStart; lineIdx <= bodyEnd && lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        if (/^\s*--/.test(line)) continue;

        for (const name of varNames) {
          const info = varMap.get(name)!;
          const cols = findIdentifierColumns(line, name);
          for (const col of cols) {
            const tokenType = info.isParam
              ? TOKEN_TYPES.indexOf("parameter")
              : TOKEN_TYPES.indexOf("variable");
            builder.push(lineIdx, col, name.length, tokenType, 0);
          }
        }
      }
    }

    return builder.build();
  }
}
