import { create } from "zustand";
import type {
  CockpitDirection,
  CockpitPerspective,
  CockpitPerspectiveState,
  CockpitSession,
  WorkbenchGraphHostMessage,
  WorkbenchGraphSearchResult,
  WorkbenchGraphSourcePreview,
} from "../../protocol.js";
import {
  cloneExploration,
  type ExplorationModel,
  emptyExploration,
  installNeighborhood,
  installPinnedNodes,
  restorePerspectiveExpansions,
  revealNeighbors,
  startExploration,
  togglePinned,
} from "./domain.js";

interface CockpitStore {
  session: CockpitSession | null;
  exploration: ExplorationModel;
  preview: WorkbenchGraphSourcePreview | null;
  searchQuery: string;
  searchRequestId: number;
  searchResults: WorkbenchGraphSearchResult[];
  relationFilters: Record<string, boolean>;
  radius: { incoming: number; outgoing: number };
  restoredExpansions: Record<string, { incoming: number; outgoing: number }>;
  positions: Record<string, { x: number; y: number }>;
  selectedEdgeId: string | null;
  hoveredIdentity: string | null;
  pathIdentities: string[];
  error: string | null;
  expansionUndo: ExplorationModel[];
  expansionRedo: ExplorationModel[];
  receive(message: WorkbenchGraphHostMessage): void;
  reveal(identity: string, direction: CockpitDirection): void;
  undoExpansion(): void;
  redoExpansion(): void;
  pin(identity: string): void;
  setRadius(direction: CockpitDirection, value: number): void;
  toggleRelation(relation: string): void;
  setPosition(identity: string, position: { x: number; y: number }): void;
  selectEdge(identity: string | null): void;
  hover(identity: string | null): void;
  setPath(identities: string[]): void;
  dismissPreview(): void;
  perspectiveState(): CockpitPerspectiveState | null;
}

const DEFAULT_RELATIONS = {
  calls: true,
  reads: true,
  writes: true,
  references: true,
  uses_type: false,
};

export const useCockpitStore = create<CockpitStore>((set, get) => ({
  session: null,
  exploration: emptyExploration(),
  preview: null,
  searchQuery: "",
  searchRequestId: 0,
  searchResults: [],
  relationFilters: DEFAULT_RELATIONS,
  radius: { incoming: 1, outgoing: 1 },
  restoredExpansions: {},
  positions: {},
  selectedEdgeId: null,
  hoveredIdentity: null,
  pathIdentities: [],
  error: null,
  expansionUndo: [],
  expansionRedo: [],
  receive(message) {
    if (message.type === "databaseContextInvalidated") {
      set({
        session: null,
        exploration: emptyExploration(),
        preview: null,
        searchQuery: "",
        searchRequestId: 0,
        searchResults: [],
        positions: {},
        restoredExpansions: {},
        selectedEdgeId: null,
        hoveredIdentity: null,
        pathIdentities: [],
        error: message.message,
        expansionUndo: [],
        expansionRedo: [],
      });
      return;
    }
    if (message.type === "scopeError") {
      set({ error: message.message });
      return;
    }
    if (message.type === "searchResults") {
      set((state) =>
        message.requestId < state.searchRequestId
          ? state
          : {
              searchRequestId: message.requestId,
              searchQuery: message.query,
              searchResults: message.results,
            },
      );
      return;
    }
    if (message.type === "cockpitPerspectives") {
      set((state) => ({
        session: state.session ? { ...state.session, perspectives: message.perspectives } : null,
      }));
      return;
    }
    if (message.type === "cockpitPreview") {
      set({ preview: message.preview });
      return;
    }
    if (message.type === "cockpitSession") {
      set({
        session: message.session,
        exploration: emptyExploration(),
        preview: null,
        restoredExpansions: {},
        error: null,
      });
      return;
    }
    if (message.type === "cockpitFocus") {
      set((state) => {
        const perspective = message.payload.perspective;
        let exploration = startExploration(
          perspective ? emptyExploration() : state.exploration,
          message.payload.neighborhood,
          message.payload.presentations,
        );
        exploration = installPinnedNodes(exploration, message.payload.pinned ?? []);
        const restoredExpansions = perspective?.state.expansions ?? {};
        exploration = restorePerspectiveExpansions(exploration, restoredExpansions);
        if (perspective) hydratePerspective(exploration, perspective);
        return {
          session: message.payload.session,
          exploration,
          preview: message.payload.preview ?? null,
          relationFilters: perspective?.state.relationFilters ?? state.relationFilters,
          radius: perspective?.state.radius ?? state.radius,
          restoredExpansions,
          positions: perspective?.state.positions ?? {},
          selectedEdgeId: null,
          hoveredIdentity: null,
          pathIdentities: [],
          expansionUndo: [],
          expansionRedo: [],
          error: null,
        };
      });
      return;
    }
    set((state) => {
      let exploration = installNeighborhood(
        state.exploration,
        message.neighborhood,
        message.presentations,
      );
      const restored = state.restoredExpansions[message.neighborhood.focus.uri];
      if (restored) {
        exploration = restorePerspectiveExpansions(exploration, {
          [message.neighborhood.focus.uri]: restored,
        });
      } else if (message.intent === "expand" || message.intent === "radius") {
        const direction = message.direction ?? "outgoing";
        exploration = revealNeighbors(exploration, message.neighborhood.focus.uri, direction);
      }
      return {
        exploration,
        expansionUndo:
          message.intent === "expand"
            ? [...state.expansionUndo, cloneExploration(state.exploration)]
            : state.expansionUndo,
        expansionRedo: message.intent === "expand" ? [] : state.expansionRedo,
      };
    });
  },
  reveal(identity, direction) {
    set((state) => ({
      expansionUndo: [...state.expansionUndo, cloneExploration(state.exploration)],
      expansionRedo: [],
      exploration: revealNeighbors(state.exploration, identity, direction),
    }));
  },
  undoExpansion() {
    set((state) => {
      const previous = state.expansionUndo.at(-1);
      if (!previous) return state;
      return {
        exploration: previous,
        expansionUndo: state.expansionUndo.slice(0, -1),
        expansionRedo: [cloneExploration(state.exploration), ...state.expansionRedo],
      };
    });
  },
  redoExpansion() {
    set((state) => {
      const next = state.expansionRedo[0];
      if (!next) return state;
      return {
        exploration: next,
        expansionUndo: [...state.expansionUndo, cloneExploration(state.exploration)],
        expansionRedo: state.expansionRedo.slice(1),
      };
    });
  },
  pin(identity) {
    set((state) => ({ exploration: togglePinned(state.exploration, identity) }));
  },
  setRadius(direction, value) {
    set((state) => ({ radius: { ...state.radius, [direction]: Math.max(0, Math.min(4, value)) } }));
  },
  toggleRelation(relation) {
    set((state) => ({
      relationFilters: {
        ...state.relationFilters,
        [relation]: state.relationFilters[relation] === false,
      },
    }));
  },
  setPosition(identity, position) {
    set((state) => ({ positions: { ...state.positions, [identity]: position } }));
  },
  selectEdge(selectedEdgeId) {
    set({ selectedEdgeId });
  },
  hover(hoveredIdentity) {
    set({ hoveredIdentity });
  },
  setPath(pathIdentities) {
    set({ pathIdentities });
  },
  dismissPreview() {
    set({ preview: null });
  },
  perspectiveState() {
    const state = get();
    const focusIdentity = state.exploration.focusIdentity;
    if (!focusIdentity) return null;
    return {
      focusIdentity,
      pinnedIdentities: Object.values(state.exploration.nodes)
        .filter((node) => node.pinned)
        .map((node) => node.identity),
      radius: state.radius,
      relationFilters: state.relationFilters,
      positions: state.positions,
      expansions: Object.fromEntries(
        Object.entries(state.exploration.neighborhoods).map(([identity, neighborhood]) => [
          identity,
          { ...neighborhood.revealed },
        ]),
      ),
    };
  },
}));

function hydratePerspective(exploration: ExplorationModel, perspective: CockpitPerspective): void {
  const pinned = new Set(perspective.state.pinnedIdentities);
  for (const node of Object.values(exploration.nodes)) node.pinned = pinned.has(node.identity);
}
