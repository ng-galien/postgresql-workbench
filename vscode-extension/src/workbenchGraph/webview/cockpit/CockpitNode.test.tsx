import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const xyflow = vi.hoisted(() => ({ zoom: 1 }));

vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right" },
  useStore: (selector: (state: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, xyflow.zoom] }),
}));

import { CockpitNode, type CockpitNodeData } from "./CockpitNode.js";

function data(role: CockpitNodeData["role"], hasCockpitActions = false): CockpitNodeData {
  return {
    role,
    hidden: { incoming: 0, outgoing: 0 },
    node: {
      identity: "table:warehouse",
      symbol: {
        uri: "table:warehouse",
        file: "warehouse.sql",
        name: "warehouse",
        kind: "table",
        signature: "",
      },
      presentation: { label: "warehouse", kind: "table", hasCockpitActions },
      incoming: 3,
      outgoing: 2,
      score: 1,
      pinned: role === "pinned",
    },
    onFocus: vi.fn(),
    onInspect: vi.fn(),
    onOpen: vi.fn(),
    onActions: vi.fn(),
    onPin: vi.fn(),
    onExpand: vi.fn(),
  };
}

describe("SQL Cockpit node actions", () => {
  beforeEach(() => {
    xyflow.zoom = 1;
  });

  it("keeps a focused generic object limited to the explicit editor action", () => {
    const html = renderToStaticMarkup(<CockpitNode data={data("focus")} />);

    expect(html).toContain('aria-label="warehouse, PostgreSQL table"');
    expect(html).toContain('class="node-drag-handle" aria-hidden="true"');
    expect(html).toContain('title="Drag to reposition"');
    expect(html).toContain(">Editor</button>");
    expect(html).not.toContain(">Source</button>");
    expect(html).not.toContain(">Pin</button>");
    expect(html).not.toContain("More routine actions");
  });

  it("offers source, editor and pin controls on a generic neighbor without an overflow menu", () => {
    const html = renderToStaticMarkup(<CockpitNode data={data("neighbor")} />);

    expect(html).toContain('class="nodrag" title="Show indexed SQL in the Source Inspector"');
    expect(html).toContain('class="nodrag" title="Open indexed SQL in the editor"');
    expect(html).toContain('class="nodrag" title="Keep visible while navigating"');
    expect(html).not.toContain("More routine actions");
  });

  it("reserves the overflow menu for routines with secondary actions", () => {
    const html = renderToStaticMarkup(<CockpitNode data={data("neighbor", true)} />);

    expect(html).toContain('aria-label="More routine actions"');
  });

  it("exposes React Flow's dragging state for visible movement feedback", () => {
    const idle = renderToStaticMarkup(<CockpitNode data={data("neighbor")} />);
    const dragging = renderToStaticMarkup(<CockpitNode data={data("neighbor")} dragging />);

    expect(idle).not.toContain("is-dragging");
    expect(dragging).toContain("cockpit-node kind-table role-neighbor zoom-detail is-dragging");
  });

  it("keeps expansion controls out of the node drag surface", () => {
    const nodeData = data("neighbor");
    nodeData.hidden = { incoming: 2, outgoing: 4 };
    const html = renderToStaticMarkup(<CockpitNode data={nodeData} />);

    expect(html).toContain('class="nodrag expand-incoming"');
    expect(html).toContain('class="nodrag expand-outgoing"');
  });

  it("keeps a stable summary card around the former compact cutoff", () => {
    xyflow.zoom = 0.54;
    const html = renderToStaticMarkup(<CockpitNode data={data("neighbor")} />);

    expect(html).toContain("cockpit-node kind-table role-neighbor zoom-summary");
    expect(html).toContain("<strong>warehouse</strong>");
  });
});
