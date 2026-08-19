import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ExplorationModel, emptyExploration } from "./domain.js";

interface CockpitStoreMockState {
  exploration: ExplorationModel;
  relationFilters: Record<string, boolean>;
  positions: Record<string, { x: number; y: number }>;
  setPosition: ReturnType<typeof vi.fn>;
  reveal: ReturnType<typeof vi.fn>;
  pin: ReturnType<typeof vi.fn>;
  selectedEdgeId: string | null;
  selectEdge: ReturnType<typeof vi.fn>;
  hoveredIdentity: string | null;
  hover: ReturnType<typeof vi.fn>;
  pathIdentities: string[];
  treeDragPayload: null;
  clearTreeDrag: ReturnType<typeof vi.fn>;
  frameRequest: number;
}

const reactFlow = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
  onNodesChange: vi.fn(),
}));
const cockpitStore = vi.hoisted(() => ({
  state: {
    exploration: { focusIdentity: null, nodes: {}, edges: {}, neighborhoods: {} },
    relationFilters: {},
    positions: {},
    setPosition: vi.fn(),
    reveal: vi.fn(),
    pin: vi.fn(),
    selectedEdgeId: null,
    selectEdge: vi.fn(),
    hoveredIdentity: null,
    hover: vi.fn(),
    pathIdentities: [],
    treeDragPayload: null,
    clearTreeDrag: vi.fn(),
    frameRequest: 0,
  } as CockpitStoreMockState,
}));

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  BackgroundVariant: { Dots: "dots" },
  BaseEdge: () => null,
  EdgeLabelRenderer: ({ children }: { children: unknown }) => children,
  Handle: () => null,
  MarkerType: { ArrowClosed: "arrowclosed" },
  Position: { Left: "left", Right: "right" },
  ReactFlow: (props: Record<string, unknown>) => {
    reactFlow.props = props;
    return null;
  },
  getSmoothStepPath: () => ["", 0, 0],
  useNodesState: (nodes: unknown[]) => [nodes, vi.fn(), reactFlow.onNodesChange],
  useStore: (selector: (state: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, 1] }),
}));

vi.mock("./transport.js", () => ({
  debugSymbol: vi.fn(),
  focusSymbol: vi.fn(),
  inspectSymbol: vi.fn(),
  openSymbol: vi.fn(),
  requestNeighborhood: vi.fn(),
  setPinnedSymbol: vi.fn(),
}));

vi.mock("../vscodeApi.js", () => ({
  vscode: { postMessage: vi.fn() },
}));

vi.mock("./store.js", () => ({
  useCockpitStore: (selector: (state: typeof cockpitStore.state) => unknown) =>
    selector(cockpitStore.state),
}));

import { CockpitCanvas, hasWorkbenchTreeDrag } from "./CockpitCanvas.js";

afterEach(() => {
  reactFlow.props = null;
  reactFlow.onNodesChange.mockClear();
  cockpitStore.state.exploration = emptyExploration();
  cockpitStore.state.positions = {};
  cockpitStore.state.hoveredIdentity = null;
  cockpitStore.state.pathIdentities = [];
});

describe("Cockpit canvas node dragging", () => {
  it("wires controlled node changes so intermediate drag positions are rendered", () => {
    const identity = "sql:table:warehouse";
    cockpitStore.state.exploration = {
      focusIdentity: identity,
      nodes: {
        [identity]: {
          identity,
          symbol: {
            uri: identity,
            file: "warehouse.sql",
            name: "warehouse",
            kind: "table",
            signature: "",
          },
          presentation: { label: "warehouse", kind: "table" },
          incoming: 0,
          outgoing: 0,
          score: 1,
          pinned: false,
        },
      },
      edges: {},
      neighborhoods: {},
    };

    renderToStaticMarkup(<CockpitCanvas frameRequest="0:0" />);

    const nodes = reactFlow.props?.nodes as Array<{ dragHandle?: string }> | undefined;
    expect(nodes).toHaveLength(1);
    expect(nodes?.[0]?.dragHandle).toBe(".node-drag-handle");
    expect(reactFlow.props?.onNodesChange).toBe(reactFlow.onNodesChange);
  });

  it("recognizes the native VS Code TreeView transfer used by the host bridge", () => {
    expect(
      hasWorkbenchTreeDrag({
        types: ["application/vnd.code.tree.postgresql-workbench-connections"],
      } as unknown as DataTransfer),
    ).toBe(true);
    expect(hasWorkbenchTreeDrag({ types: ["text/plain"] } as unknown as DataTransfer)).toBe(false);
  });
});
