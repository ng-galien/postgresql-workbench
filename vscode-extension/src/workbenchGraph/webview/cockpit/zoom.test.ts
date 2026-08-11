import { describe, expect, it } from "vitest";
import { cockpitZoomLevel, showCockpitEdgeLabel } from "./zoom.js";

describe("cockpit semantic zoom", () => {
  it("uses a compact named card at every reduced zoom level", () => {
    expect(cockpitZoomLevel(0.25)).toBe("compact");
    expect(cockpitZoomLevel(0.32)).toBe("compact");
    expect(cockpitZoomLevel(0.49)).toBe("compact");
  });

  it("switches to the detailed card at the single threshold", () => {
    expect(cockpitZoomLevel(0.5)).toBe("detail");
    expect(cockpitZoomLevel(0.55)).toBe("detail");
    expect(cockpitZoomLevel(0.7)).toBe("detail");
    expect(cockpitZoomLevel(1)).toBe("detail");
  });

  it("keeps edge labels independent from node geometry", () => {
    expect(showCockpitEdgeLabel(0.49)).toBe(false);
    expect(showCockpitEdgeLabel(0.5)).toBe(true);
  });
});
