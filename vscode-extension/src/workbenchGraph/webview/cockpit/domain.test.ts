import { describe, expect, it } from "vitest";
import type { CodeMonikerSymbol } from "../../../../../src/workbench/localCodeMoniker.js";
import type { CockpitNeighborhood } from "../../protocol.js";
import {
  hiddenCount,
  installNeighborhood,
  installPinnedNodes,
  refreshExploration,
  revealNeighbors,
  shortestPath,
  startExploration,
  togglePinned,
} from "./domain.js";
import { layoutCockpit } from "./layout.js";

function symbol(name: string, kind = "function"): CodeMonikerSymbol {
  return {
    uri: `code+moniker://./lang:sql/${kind}:${name}`,
    name,
    kind,
    file: `${name}.sql`,
    signature: "",
  };
}

function neighborhood(name: string, incoming = 5, outgoing = 7): CockpitNeighborhood {
  const focus = symbol(name);
  const neighbors = (count: number, direction: "incoming" | "outgoing") =>
    Array.from({ length: count }, (_, index) => ({
      direction,
      symbol: symbol(
        `${name}_${direction}_${index}`,
        direction === "outgoing" ? "table" : "function",
      ),
      count: count - index,
      kinds: [direction === "incoming" ? "calls" : "reads"],
      score: count - index,
    }));
  return {
    focus,
    incoming: neighbors(incoming, "incoming"),
    outgoing: neighbors(outgoing, "outgoing"),
    totals: { incoming, outgoing },
    unresolved: 0,
    limited: false,
  };
}

function presentations(value: CockpitNeighborhood) {
  return Object.fromEntries(
    [
      value.focus,
      ...value.incoming.map((item) => item.symbol),
      ...value.outgoing.map((item) => item.symbol),
    ].map((item) => [item.uri, { label: item.name, kind: item.kind }]),
  );
}

describe("cockpit exploration domain", () => {
  it("starts small and reveals exactly three more neighbors per action", () => {
    const source = neighborhood("process_order");
    const initial = startExploration(
      { focusIdentity: null, nodes: {}, edges: {}, neighborhoods: {} },
      source,
      presentations(source),
    );
    expect(Object.keys(initial.nodes)).toHaveLength(7);
    expect(hiddenCount(initial, source.focus.uri, "incoming")).toBe(2);
    expect(hiddenCount(initial, source.focus.uri, "outgoing")).toBe(4);

    const expanded = revealNeighbors(initial, source.focus.uri, "outgoing");
    expect(Object.keys(expanded.nodes)).toHaveLength(10);
    expect(hiddenCount(expanded, source.focus.uri, "outgoing")).toBe(1);
    expect(Object.keys(initial.nodes)).toHaveLength(7);
  });

  it("keeps pinned nodes when the focus changes", () => {
    const first = neighborhood("process_order", 1, 1);
    let exploration = startExploration(
      { focusIdentity: null, nodes: {}, edges: {}, neighborhoods: {} },
      first,
      presentations(first),
    );
    const pinned = first.outgoing[0].symbol.uri;
    exploration = togglePinned(exploration, pinned);
    const second = neighborhood("refund_order", 1, 1);
    exploration = startExploration(exploration, second, presentations(second));

    expect(exploration.nodes[pinned]?.pinned).toBe(true);
    expect(exploration.focusIdentity).toBe(second.focus.uri);
  });

  it("restores saved pinned nodes that are outside the initial neighborhood", () => {
    const source = neighborhood("process_order", 1, 1);
    const initial = startExploration(
      { focusIdentity: null, nodes: {}, edges: {}, neighborhoods: {} },
      source,
      presentations(source),
    );
    const remote = symbol("refund_order");
    const restored = installPinnedNodes(initial, [
      { symbol: remote, presentation: { label: "refund_order", kind: "function" } },
    ]);
    expect(restored.nodes[remote.uri]?.pinned).toBe(true);
  });

  it("never moves existing positions when a new node is laid out", () => {
    const source = neighborhood("process_order", 0, 4);
    const initial = startExploration(
      { focusIdentity: null, nodes: {}, edges: {}, neighborhoods: {} },
      source,
      presentations(source),
    );
    const firstLayout = layoutCockpit(
      Object.values(initial.nodes),
      Object.values(initial.edges),
      initial.focusIdentity,
      {},
    );
    const expanded = revealNeighbors(initial, source.focus.uri, "outgoing");
    const secondLayout = layoutCockpit(
      Object.values(expanded.nodes),
      Object.values(expanded.edges),
      expanded.focusIdentity,
      firstLayout,
    );
    for (const identity of Object.keys(initial.nodes)) {
      expect(secondLayout[identity]).toEqual(firstLayout[identity]);
    }
  });

  it("lays out a refocused neighborhood relative to the persisted focus position", () => {
    const source = neighborhood("product", 1, 1);
    const exploration = startExploration(
      { focusIdentity: null, nodes: {}, edges: {}, neighborhoods: {} },
      source,
      presentations(source),
    );
    const layout = layoutCockpit(
      Object.values(exploration.nodes),
      Object.values(exploration.edges),
      exploration.focusIdentity,
      { [source.focus.uri]: { x: 220, y: 40 } },
    );
    expect(layout[source.incoming[0].symbol.uri].x).toBe(-120);
    expect(layout[source.outgoing[0].symbol.uri].x).toBe(560);
  });

  it("finds a shortest visible path and can traverse a reversed visible relation", () => {
    const edges = [
      { id: "a-b", source: "a", target: "b", count: 1, kinds: ["calls"] },
      { id: "b-c", source: "b", target: "c", count: 1, kinds: ["reads"] },
    ];
    expect(shortestPath(edges, "a", "c")).toEqual(["a", "b", "c"]);
    expect(shortestPath(edges, "c", "a")).toEqual(["c", "b", "a"]);
  });

  it("refreshes loaded neighborhoods while retaining their revealed breadth and pins", () => {
    const source = neighborhood("orders", 0, 5);
    let current = startExploration(emptyExplorationForTest(), source, presentations(source));
    current = togglePinned(current, source.outgoing[0].symbol.uri);
    const refreshed = neighborhood("orders", 0, 4);
    const next = refreshExploration(
      current,
      [
        {
          previousIdentity: source.focus.uri,
          neighborhood: refreshed,
          presentations: presentations(refreshed),
        },
      ],
      {},
      new Set([refreshed.focus.uri, ...refreshed.outgoing.map(({ symbol }) => symbol.uri)]),
      refreshed.focus.uri,
      new Set([source.outgoing[0].symbol.uri]),
    );

    expect(next.neighborhoods[refreshed.focus.uri].revealed.outgoing).toBe(3);
    expect(next.nodes[source.outgoing[0].symbol.uri]?.pinned).toBe(true);
    expect(hiddenCount(next, refreshed.focus.uri, "outgoing")).toBe(1);
  });

  it("rebuilds shared edges after every refreshed catalog has been installed", () => {
    const upstream = neighborhood("orders", 0, 1);
    const downstream = neighborhood("invoice", 1, 0);
    downstream.focus = upstream.outgoing[0].symbol;
    downstream.incoming[0].symbol = upstream.focus;
    let current = startExploration(emptyExplorationForTest(), upstream, presentations(upstream));
    current = installNeighborhood(current, downstream, presentations(downstream));
    current.neighborhoods[downstream.focus.uri].revealed = { incoming: 0, outgoing: 0 };

    const next = refreshExploration(
      current,
      [
        {
          previousIdentity: upstream.focus.uri,
          neighborhood: upstream,
          presentations: presentations(upstream),
        },
        {
          previousIdentity: downstream.focus.uri,
          neighborhood: downstream,
          presentations: presentations(downstream),
        },
      ],
      {},
      new Set([upstream.focus.uri, downstream.focus.uri]),
      upstream.focus.uri,
      new Set([downstream.focus.uri]),
    );

    expect(next.edges[`${upstream.focus.uri}->${downstream.focus.uri}`]).toBeDefined();
  });
});

function emptyExplorationForTest() {
  return { focusIdentity: null, nodes: {}, edges: {}, neighborhoods: {} };
}
