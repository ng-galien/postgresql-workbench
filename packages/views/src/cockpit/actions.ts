import type { CodeMonikerSymbol } from "../../../catalog/src/localCodeMoniker.js";
import { post } from "./vscodeApi.js";

export function postFocus(prefix: string): void {
  post({ type: "focus", prefix });
}

export function postOpen(symbol: CodeMonikerSymbol): void {
  post({ type: "open", symbolUri: symbol.uri });
}

export function postActions(symbol: CodeMonikerSymbol): void {
  post({ type: "actions", symbolUri: symbol.uri });
}

export function postInspect(symbol: CodeMonikerSymbol): void {
  post({ type: "inspect", symbolUri: symbol.uri });
}
