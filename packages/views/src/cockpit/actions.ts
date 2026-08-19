import type { CodeMonikerSymbol } from "../../../catalog/src/localCodeMoniker.js";
import { vscode } from "./vscodeApi.js";

export function postFocus(prefix: string): void {
  vscode.postMessage({ type: "focus", prefix });
}

export function postOpen(symbol: CodeMonikerSymbol): void {
  vscode.postMessage({ type: "open", symbolUri: symbol.uri });
}

export function postActions(symbol: CodeMonikerSymbol): void {
  vscode.postMessage({ type: "actions", symbolUri: symbol.uri });
}

export function postInspect(symbol: CodeMonikerSymbol): void {
  vscode.postMessage({ type: "inspect", symbolUri: symbol.uri });
}
