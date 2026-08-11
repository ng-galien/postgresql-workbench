export type CockpitZoomLevel = "detail" | "compact";

export function cockpitZoomLevel(zoom: number): CockpitZoomLevel {
  return zoom < 0.5 ? "compact" : "detail";
}

export function showCockpitEdgeLabel(zoom: number): boolean {
  return zoom >= 0.5;
}
