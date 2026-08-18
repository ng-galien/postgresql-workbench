import { describe, expect, it } from "vitest";
import { emptyExploration } from "./domain.js";
import { useCockpitStore } from "./store.js";

describe("Workbench graph cockpit invalidation", () => {
  it("clears retained graph state when the Cockpit Connexion changes", () => {
    useCockpitStore.setState({
      session: {
        renderId: 1,
        serverId: "old-server",
        database: "old-database",
        revision: "old-revision",
        generation: 1,
        breadcrumbs: [],
        canBack: false,
        canForward: false,
        perspectives: [],
        searchFacets: { schemas: ["public"], kinds: ["table"] },
      },
      exploration: {
        ...emptyExploration(),
        focusIdentity: "sql:table:old",
      },
      preview: {
        symbolUri: "sql:table:old",
        title: "old",
        kind: "table",
        file: "old.sql",
        firstLine: 1,
        lastLine: 1,
        lines: [{ number: 1, text: "select 1" }],
      },
      searchQuery: "old",
      searchResults: [
        {
          symbolUri: "sql:table:old",
          label: "old",
          schema: "public",
          kind: "table",
          detail: "old",
          resultType: "object",
          countStatus: "available",
        },
      ],
      positions: { "sql:table:old": { x: 1, y: 1 } },
      selectedEdgeId: "edge-old",
      hoveredIdentity: "sql:table:old",
      pathIdentities: ["sql:table:old"],
    });

    useCockpitStore.getState().receive({
      type: "cockpitContextInvalidated",
      message: "Cockpit Connexion changed.",
    });

    const state = useCockpitStore.getState();
    expect(state.session).toBeNull();
    expect(state.exploration).toEqual(emptyExploration());
    expect(state.preview).toBeNull();
    expect(state.searchQuery).toBe("");
    expect(state.searchResults).toEqual([]);
    expect(state.positions).toEqual({});
    expect(state.selectedEdgeId).toBeNull();
    expect(state.hoveredIdentity).toBeNull();
    expect(state.pathIdentities).toEqual([]);
    expect(state.error).toBe("Cockpit Connexion changed.");
  });
});

describe("Workbench graph cockpit perspectives", () => {
  it("persists and restores the revealed breadth of every loaded neighborhood", () => {
    const candidates = Array.from({ length: 6 }, (_, index) => ({
      symbol: {
        uri: `sql:table:dependency-${index}`,
        file: `dependency-${index}.sql`,
        name: `dependency_${index}`,
        kind: "table",
        signature: "",
      },
      score: 1,
      count: 1,
      kinds: ["references"],
      direction: "outgoing" as const,
    }));
    const neighborhood = {
      focus: {
        uri: "sql:table:orders",
        file: "orders.sql",
        name: "orders",
        kind: "table",
        signature: "",
      },
      incoming: [],
      outgoing: candidates,
      totals: { incoming: 0, outgoing: candidates.length },
      unresolved: 0,
      limited: false,
    };
    const session = {
      renderId: 2,
      serverId: "server",
      database: "database",
      revision: "revision",
      generation: 2,
      breadcrumbs: [],
      canBack: false,
      canForward: false,
      perspectives: [],
      searchFacets: { schemas: ["public"], kinds: ["table"] },
    };

    useCockpitStore.getState().receive({
      type: "cockpitFocus",
      payload: {
        session,
        neighborhood,
        presentations: {},
        perspective: {
          name: "wide",
          state: {
            focusIdentity: neighborhood.focus.uri,
            pinnedIdentities: [],
            radius: { incoming: 1, outgoing: 2 },
            expansions: {
              [neighborhood.focus.uri]: { incoming: 0, outgoing: 6 },
              "sql:table:dependency-0": { incoming: 0, outgoing: 2 },
            },
            relationFilters: { references: true },
            positions: {},
          },
        },
      },
    });

    let state = useCockpitStore.getState();
    expect(state.exploration.neighborhoods[neighborhood.focus.uri].revealed.outgoing).toBe(6);
    expect(state.restoredExpansions["sql:table:dependency-0"]).toEqual({
      incoming: 0,
      outgoing: 2,
    });

    state.receive({
      type: "cockpitNeighborhood",
      requestId: 1,
      intent: "radius",
      direction: "outgoing",
      neighborhood: {
        focus: candidates[0].symbol,
        incoming: [],
        outgoing: candidates.slice(1, 4),
        totals: { incoming: 0, outgoing: 3 },
        unresolved: 0,
        limited: false,
      },
      presentations: {},
    });

    state = useCockpitStore.getState();
    expect(state.exploration.neighborhoods["sql:table:dependency-0"].revealed.outgoing).toBe(2);
    expect(state.perspectiveState()?.expansions?.[neighborhood.focus.uri]).toEqual({
      incoming: 0,
      outgoing: 6,
    });
  });

  it("removes pinned nodes from the previous view when loading another perspective", () => {
    const session = {
      renderId: 3,
      serverId: "server",
      database: "database",
      revision: "revision",
      generation: 3,
      breadcrumbs: [],
      canBack: false,
      canForward: false,
      perspectives: [],
      searchFacets: { schemas: ["public"], kinds: ["table"] },
    };
    const oldFocus = {
      uri: "sql:table:old-focus",
      file: "old-focus.sql",
      name: "old_focus",
      kind: "table",
      signature: "",
    };
    const orphanedPin = {
      uri: "sql:table:old-pin",
      file: "old-pin.sql",
      name: "old_pin",
      kind: "table",
      signature: "",
    };
    const newFocus = {
      uri: "sql:table:new-focus",
      file: "new-focus.sql",
      name: "new_focus",
      kind: "table",
      signature: "",
    };
    const neighborhood = (focus: typeof oldFocus) => ({
      focus,
      incoming: [],
      outgoing: [],
      totals: { incoming: 0, outgoing: 0 },
      unresolved: 0,
      limited: false,
    });

    useCockpitStore.setState({ exploration: emptyExploration() });
    useCockpitStore.getState().receive({
      type: "cockpitFocus",
      payload: {
        session,
        neighborhood: neighborhood(oldFocus),
        presentations: {},
        pinned: [
          {
            symbol: orphanedPin,
            presentation: { label: "old_pin", kind: "table" },
          },
        ],
      },
    });
    expect(useCockpitStore.getState().exploration.nodes[orphanedPin.uri]?.pinned).toBe(true);

    useCockpitStore.getState().receive({
      type: "cockpitFocus",
      payload: {
        session: { ...session, renderId: 4 },
        neighborhood: neighborhood(newFocus),
        presentations: {},
        pinned: [],
        perspective: {
          name: "new perspective",
          state: {
            focusIdentity: newFocus.uri,
            pinnedIdentities: [],
            radius: { incoming: 1, outgoing: 1 },
            relationFilters: { references: true },
            positions: {},
          },
        },
      },
    });

    const exploration = useCockpitStore.getState().exploration;
    expect(exploration.focusIdentity).toBe(newFocus.uri);
    expect(exploration.nodes[orphanedPin.uri]).toBeUndefined();
  });
});

describe("Workbench graph Source panel", () => {
  const session = {
    renderId: 20,
    serverId: "server",
    database: "demo",
    revision: "revision",
    generation: 1,
    breadcrumbs: [],
    canBack: false,
    canForward: false,
    perspectives: [],
    searchFacets: { schemas: ["shop"], kinds: ["table"] },
  };
  const symbol = (name: string) => ({
    uri: `sql:table:${name}`,
    file: `${name}.sql`,
    name,
    kind: "table",
    signature: "",
  });
  const neighborhood = (name: string) => ({
    focus: symbol(name),
    incoming: [],
    outgoing: [],
    totals: { incoming: 0, outgoing: 0 },
    unresolved: 0,
    limited: false,
  });
  const preview = (name: string) => ({
    symbolUri: `sql:table:${name}`,
    title: name,
    kind: "table",
    file: `${name}.sql`,
    firstLine: 1,
    lastLine: 1,
    lines: [{ number: 1, text: `create table ${name} ();` }],
  });

  it("opens only on explicit inspection, follows focus while unpinned, and locks while pinned", () => {
    useCockpitStore.setState({
      session: null,
      exploration: emptyExploration(),
      preview: null,
      sourceVisible: false,
      sourcePinned: false,
    });

    useCockpitStore.getState().receive({
      type: "cockpitFocus",
      payload: {
        session,
        neighborhood: neighborhood("address"),
        presentations: {},
        preview: preview("address"),
      },
    });
    expect(useCockpitStore.getState().sourceVisible).toBe(false);

    useCockpitStore.getState().receive({ type: "cockpitPreview", preview: preview("address") });
    expect(useCockpitStore.getState().sourceVisible).toBe(true);
    expect(useCockpitStore.getState().preview?.title).toBe("address");

    useCockpitStore.getState().receive({
      type: "cockpitFocus",
      payload: {
        session: { ...session, renderId: 21 },
        neighborhood: neighborhood("product"),
        presentations: {},
        preview: preview("product"),
      },
    });
    expect(useCockpitStore.getState().preview?.title).toBe("product");

    useCockpitStore.getState().setSourcePinned(true);
    useCockpitStore.getState().receive({
      type: "cockpitFocus",
      payload: {
        session: { ...session, renderId: 22 },
        neighborhood: neighborhood("warehouse"),
        presentations: {},
        preview: preview("warehouse"),
      },
    });
    expect(useCockpitStore.getState().preview?.title).toBe("product");

    useCockpitStore.getState().dismissPreview();
    expect(useCockpitStore.getState().sourceVisible).toBe(false);
    expect(useCockpitStore.getState().sourcePinned).toBe(false);
  });

  it("preserves Source on a landing and clears a pin whose DDL was invalidated", () => {
    useCockpitStore.setState({
      session,
      exploration: emptyExploration(),
      preview: preview("address"),
      sourceVisible: true,
      sourcePinned: true,
    });

    useCockpitStore.getState().receive({
      type: "cockpitSession",
      session: { ...session, renderId: 23 },
      sourceVisible: true,
      sourcePinned: true,
    });
    expect(useCockpitStore.getState().sourceVisible).toBe(true);
    expect(useCockpitStore.getState().sourcePinned).toBe(true);
    expect(useCockpitStore.getState().preview?.title).toBe("address");

    useCockpitStore.getState().receive({
      type: "cockpitRefresh",
      payload: {
        session: { ...session, renderId: 24 },
        focusIdentity: null,
        neighborhoods: [],
        identityRemap: {},
        presentations: {},
        validIdentities: [],
        pinnedIdentities: [],
        preview: null,
        sourceVisible: false,
        sourcePinned: false,
      },
    });
    expect(useCockpitStore.getState().sourceVisible).toBe(false);
    expect(useCockpitStore.getState().sourcePinned).toBe(false);
  });
});
