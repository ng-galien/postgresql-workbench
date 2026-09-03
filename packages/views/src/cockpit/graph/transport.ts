import type { CockpitDirection, CockpitMessaging, CockpitPerspectiveState } from "../protocol.js";

let requestSequence = 0;

export function focusSymbol(messaging: CockpitMessaging, symbolUri: string): void {
  messaging.post({ type: "focus", prefix: symbolUri });
}

export function inspectSymbol(messaging: CockpitMessaging, symbolUri: string): void {
  messaging.post({ type: "inspect", symbolUri });
}

export function dismissSource(messaging: CockpitMessaging): void {
  messaging.post({ type: "dismissPreview" });
}

export function openSymbol(messaging: CockpitMessaging, symbolUri: string): void {
  messaging.post({ type: "open", symbolUri });
}

export function debugSymbol(messaging: CockpitMessaging, symbolUri: string): void {
  messaging.post({ type: "actions", symbolUri });
}

export function setPinnedSymbol(
  messaging: CockpitMessaging,
  symbolUri: string,
  pinned: boolean,
): void {
  messaging.post({ type: "pin", symbolUri, pinned });
}

export function requestNeighborhood(
  messaging: CockpitMessaging,
  symbolUri: string,
  intent: "expand" | "radius",
  direction?: CockpitDirection,
): number {
  const requestId = ++requestSequence;
  messaging.post({ type: "requestNeighborhood", requestId, symbolUri, intent, direction });
  return requestId;
}

export function savePerspective(messaging: CockpitMessaging, state: CockpitPerspectiveState): void {
  messaging.post({ type: "savePerspective", state });
}
