import type { CockpitDirection, CockpitPerspectiveState } from "../protocol.js";
import { post } from "../vscodeApi.js";

let requestSequence = 0;

export function focusSymbol(symbolUri: string): void {
  post({ type: "focus", prefix: symbolUri });
}

export function inspectSymbol(symbolUri: string): void {
  post({ type: "inspect", symbolUri });
}

export function dismissSource(): void {
  post({ type: "dismissPreview" });
}

export function openSymbol(symbolUri: string): void {
  post({ type: "open", symbolUri });
}

export function debugSymbol(symbolUri: string): void {
  post({ type: "actions", symbolUri });
}

export function setPinnedSymbol(symbolUri: string, pinned: boolean): void {
  post({ type: "pin", symbolUri, pinned });
}

export function requestNeighborhood(
  symbolUri: string,
  intent: "expand" | "radius",
  direction?: CockpitDirection,
): number {
  const requestId = ++requestSequence;
  post({ type: "requestNeighborhood", requestId, symbolUri, intent, direction });
  return requestId;
}

export function savePerspective(state: CockpitPerspectiveState): void {
  post({ type: "savePerspective", state });
}
