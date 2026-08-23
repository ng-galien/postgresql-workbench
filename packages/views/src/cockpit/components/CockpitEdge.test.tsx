import type { EdgeProps } from "@xyflow/react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@xyflow/react", () => ({
  BaseEdge: () => null,
  EdgeLabelRenderer: ({ children }: { children: ReactNode }) => children,
  getSmoothStepPath: () => ["M0 0L100 100", 50, 50],
  useStore: (selector: (state: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, 1] }),
}));

import { CockpitEdge } from "./CockpitEdge.js";

describe("Cockpit edge labels", () => {
  it("renders multiple relation kinds as separate vertically stacked badges", () => {
    const props = {
      id: "edge-1",
      source: "orders",
      target: "inventory",
      data: {
        sourceLabel: "orders",
        targetLabel: "inventory",
        kinds: ["reads", "writes"],
        count: 2,
        color: "blue",
        onSelect: vi.fn(),
      },
    } as unknown as EdgeProps;
    const html = renderToStaticMarkup(<CockpitEdge {...props} />);

    expect(html).toContain('class="cockpit-edge-kinds"');
    expect(html).toContain('class="cockpit-edge-kind relation-reads">reads</span>');
    expect(html).toContain('class="cockpit-edge-kind relation-writes">writes</span>');
    expect(html).toContain('class="cockpit-edge-count">×2</span>');
    expect(html).not.toContain("reads · writes");
  });
});
