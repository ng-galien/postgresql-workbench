import type { CockpitDirection, CockpitPerspectiveState } from "../../protocol.js";
import { vscode } from "../vscodeApi.js";

let requestSequence = 0;

export function focusSymbol(symbolUri: string): void {
  vscode.postMessage({ type: "focus", prefix: symbolUri });
}

export function inspectSymbol(symbolUri: string): void {
  vscode.postMessage({ type: "inspect", symbolUri });
}

export function openSymbol(symbolUri: string): void {
  vscode.postMessage({ type: "open", symbolUri });
}

export function debugSymbol(symbolUri: string): void {
  vscode.postMessage({ type: "actions", symbolUri });
}

export function setPinnedSymbol(symbolUri: string, pinned: boolean): void {
  vscode.postMessage({ type: "pin", symbolUri, pinned });
}

export function requestNeighborhood(
  symbolUri: string,
  intent: "expand" | "radius",
  direction?: CockpitDirection,
): number {
  const requestId = ++requestSequence;
  vscode.postMessage({ type: "requestNeighborhood", requestId, symbolUri, intent, direction });
  return requestId;
}

export function savePerspective(state: CockpitPerspectiveState): void {
  vscode.postMessage({ type: "savePerspective", state });
}
