import { describe, expect, it } from "vitest";
import { cockpitZoomLevel, showCockpitEdgeLabel } from "./zoom.js";

describe("cockpit semantic zoom", () => {
  it("keeps labels around the former abrupt compact threshold", () => {
    expect(cockpitZoomLevel(0.54)).toBe("summary");
    expect(cockpitZoomLevel(0.55)).toBe("summary");
  });

  it("uses stable detail, summary and glyph bands", () => {
    expect(cockpitZoomLevel(0.7)).toBe("detail");
    expect(cockpitZoomLevel(0.69)).toBe("summary");
    expect(cockpitZoomLevel(0.32)).toBe("summary");
    expect(cockpitZoomLevel(0.31)).toBe("glyph");
  });

  it("keeps edge labels independent from node geometry", () => {
    expect(showCockpitEdgeLabel(0.49)).toBe(false);
    expect(showCockpitEdgeLabel(0.5)).toBe(true);
  });
});
