import { create } from "zustand";
import type { WorkbenchGraphDragPayload } from "../../dragAndDrop.js";
import {
  type CockpitDirection,
  type CockpitPerspective,
  type CockpitPerspectiveState,
  type CockpitSession,
  DEFAULT_WORKBENCH_GRAPH_APPEARANCE,
  type WorkbenchGraphAppearance,
  type WorkbenchGraphHostMessage,
  type WorkbenchGraphSearchResult,
  type WorkbenchGraphSourcePreview,
} from "../../protocol.js";
import {
  cloneExploration,
  type ExplorationModel,
  emptyExploration,
  installNeighborhood,
  installPinnedNodes,
  refreshExploration,
  restorePerspectiveExpansions,
  revealNeighbors,
  startExploration,
  togglePinned,
} from "./domain.js";

interface CockpitStore {
  appearance: WorkbenchGraphAppearance;
  session: CockpitSession | null;
  exploration: ExplorationModel;
  preview: WorkbenchGraphSourcePreview | null;
  sourceVisible: boolean;
  sourcePinned: boolean;
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
  treeDragPayload: WorkbenchGraphDragPayload | null;
  frameRequest: number;
  error: string | null;
  dropError: string | null;
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
  setSourcePinned(pinned: boolean): void;
  clearTreeDrag(): void;
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
  appearance: DEFAULT_WORKBENCH_GRAPH_APPEARANCE,
  session: null,
  exploration: emptyExploration(),
  preview: null,
  sourceVisible: false,
  sourcePinned: false,
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
  treeDragPayload: null,
  frameRequest: 0,
  error: null,
  dropError: null,
  expansionUndo: [],
  expansionRedo: [],
  receive(message) {
    if (message.type === "cockpitAppearance") {
      set({ appearance: message.appearance });
      return;
    }
    if (message.type === "cockpitContextInvalidated") {
      set({
        session: null,
        exploration: emptyExploration(),
        preview: null,
        sourceVisible: false,
        sourcePinned: false,
        searchQuery: "",
        searchRequestId: 0,
        searchResults: [],
        positions: {},
        restoredExpansions: {},
        selectedEdgeId: null,
        hoveredIdentity: null,
        pathIdentities: [],
        treeDragPayload: null,
        frameRequest: 0,
        error: message.message,
        dropError: null,
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
      set((state) => ({
        preview: message.preview,
        sourceVisible: true,
        sourcePinned: message.pinned ?? state.sourcePinned,
      }));
      return;
    }
    if (message.type === "cockpitDropRejected") {
      set({ dropError: message.message, treeDragPayload: null });
      return;
    }
    if (message.type === "cockpitTreeDragStatus") {
      set({ treeDragPayload: message.payload, dropError: null });
      return;
    }
    if (message.type === "cockpitRefresh") {
      set((state) => {
        const sourceVisible =
          (message.payload.sourceVisible ?? state.sourceVisible) &&
          message.payload.preview !== null;
        const sourcePinned = sourceVisible
          ? (message.payload.sourcePinned ?? state.sourcePinned)
          : false;
        const validIdentities = new Set(message.payload.validIdentities);
        const pinnedIdentities = new Set(message.payload.pinnedIdentities);
        const exploration = refreshExploration(
          state.exploration,
          message.payload.neighborhoods,
          message.payload.identityRemap,
          validIdentities,
          message.payload.focusIdentity,
          pinnedIdentities,
        );
        for (const [identity, presentation] of Object.entries(message.payload.presentations)) {
          if (exploration.nodes[identity]) exploration.nodes[identity].presentation = presentation;
        }
        const positions = Object.fromEntries(
          Object.entries(state.positions)
            .map(
              ([identity, position]) =>
                [message.payload.identityRemap[identity] ?? identity, position] as const,
            )
            .filter(([identity]) => validIdentities.has(identity)),
        );
        const pathIdentities = state.pathIdentities
          .map((identity) => message.payload.identityRemap[identity] ?? identity)
          .filter((identity) => validIdentities.has(identity));
        return {
          session: message.payload.session,
          exploration,
          preview: sourceVisible ? message.payload.preview : state.preview,
          sourceVisible,
          sourcePinned,
          searchQuery: "",
          searchResults: [],
          positions,
          restoredExpansions: {},
          selectedEdgeId:
            state.selectedEdgeId && exploration.edges[state.selectedEdgeId]
              ? state.selectedEdgeId
              : null,
          hoveredIdentity:
            state.hoveredIdentity && validIdentities.has(state.hoveredIdentity)
              ? state.hoveredIdentity
              : null,
          pathIdentities,
          treeDragPayload: null,
          expansionUndo: [],
          expansionRedo: [],
          error: null,
        };
      });
      return;
    }
    if (message.type === "cockpitSession") {
      set((state) => {
        const sourceVisible = message.sourceVisible ?? state.sourceVisible;
        return {
          session: message.session,
          exploration: emptyExploration(),
          sourceVisible,
          sourcePinned: sourceVisible ? (message.sourcePinned ?? state.sourcePinned) : false,
          restoredExpansions: {},
          error: null,
        };
      });
      return;
    }
    if (message.type === "cockpitFocus") {
      set((state) => {
        const sourceVisible = message.payload.sourceVisible ?? state.sourceVisible;
        const sourcePinned = sourceVisible
          ? (message.payload.sourcePinned ?? state.sourcePinned)
          : false;
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
          preview:
            sourceVisible && !sourcePinned ? (message.payload.preview ?? null) : state.preview,
          sourceVisible,
          sourcePinned,
          relationFilters: perspective?.state.relationFilters ?? state.relationFilters,
          radius: perspective?.state.radius ?? state.radius,
          restoredExpansions,
          positions: perspective?.state.positions ?? {},
          selectedEdgeId: null,
          hoveredIdentity: null,
          pathIdentities: [],
          treeDragPayload: null,
          frameRequest: state.frameRequest + 1,
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
    set({ sourceVisible: false, sourcePinned: false });
  },
  setSourcePinned(sourcePinned) {
    set({ sourcePinned });
  },
  clearTreeDrag() {
    set({ treeDragPayload: null, dropError: null });
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
