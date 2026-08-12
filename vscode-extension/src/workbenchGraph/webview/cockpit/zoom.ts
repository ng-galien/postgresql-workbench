import { DEFAULT_WORKBENCH_GRAPH_APPEARANCE } from "../../protocol.js";

export type CockpitZoomLevel = "detail" | "compact";

export function cockpitZoomLevel(
  zoom: number,
  compactThreshold = DEFAULT_WORKBENCH_GRAPH_APPEARANCE.compactZoomThreshold,
): CockpitZoomLevel {
  return zoom < compactThreshold ? "compact" : "detail";
}

export function showCockpitEdgeLabel(zoom: number): boolean {
  return zoom >= 0.5;
}
