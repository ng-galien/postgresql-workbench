import type {
  CockpitDirection,
  CockpitNeighbor,
  CockpitNeighborhood,
  WorkbenchGraphBreadcrumb,
  WorkbenchGraphIdentityPresentation,
  WorkbenchGraphSearchResult,
  WorkbenchGraphSourcePreview,
} from "../../../catalog/src/cockpitGraph.js";
import type { CodeMonikerSymbol } from "../../../catalog/src/localCodeMoniker.js";
import type { WorkbenchGraphDragPayload } from "./dragAndDrop.js";

/**
 * What the Cockpit webview and the Extension Host exchange. The graph itself — a neighbourhood,
 * its breadcrumbs, a search result, a source preview — is what the catalog produces, and is
 * re-exported here so a view names one import for the whole contract.
 */
export type {
  CockpitDirection,
  CockpitNeighbor,
  CockpitNeighborhood,
  WorkbenchGraphBreadcrumb,
  WorkbenchGraphIdentityPresentation,
  WorkbenchGraphSearchResult,
  WorkbenchGraphSourcePreview,
};

export interface CockpitPerspectiveState {
  focusIdentity: string;
  pinnedIdentities: string[];
  radius: { incoming: number; outgoing: number };
  /** Revealed direct neighbors per object, so a saved perspective can rebuild its exact breadth. */
  expansions?: Record<string, { incoming: number; outgoing: number }>;
  relationFilters: Record<string, boolean>;
  positions: Record<string, { x: number; y: number }>;
}

export interface CockpitPerspective {
  name: string;
  state: CockpitPerspectiveState;
}

export interface CockpitSession {
  renderId: number;
  connectionId: string;
  database: string;
  revision: string;
  generation: number | null;
  breadcrumbs: WorkbenchGraphBreadcrumb[];
  canBack: boolean;
  canForward: boolean;
  perspectives: CockpitPerspective[];
  searchFacets: { schemas: string[]; kinds: string[] };
  schemaHint?: string;
}

export interface CockpitFocusPayload {
  session: CockpitSession;
  neighborhood: CockpitNeighborhood;
  presentations: Record<string, WorkbenchGraphIdentityPresentation>;
  pinned?: Array<{
    symbol: CodeMonikerSymbol;
    presentation: WorkbenchGraphIdentityPresentation;
  }>;
  preview?: WorkbenchGraphSourcePreview;
  sourceVisible?: boolean;
  sourcePinned?: boolean;
  perspective?: CockpitPerspective;
}

export interface CockpitRefreshPayload {
  session: CockpitSession;
  focusIdentity: string | null;
  neighborhoods: Array<{
    previousIdentity: string;
    neighborhood: CockpitNeighborhood;
    presentations: Record<string, WorkbenchGraphIdentityPresentation>;
  }>;
  identityRemap: Record<string, string>;
  presentations: Record<string, WorkbenchGraphIdentityPresentation>;
  validIdentities: string[];
  pinnedIdentities: string[];
  preview: WorkbenchGraphSourcePreview | null;
  sourceVisible?: boolean;
  sourcePinned?: boolean;
}

export interface WorkbenchGraphRenderedCard {
  identity: string;
  label: string;
  kind: string;
  role: "focus" | "neighbor" | "pinned";
}

export interface WorkbenchGraphRenderedEdge {
  identity: string;
  sourceIdentity: string;
  targetIdentity: string;
  sourceLabel: string;
  targetLabel: string;
  kinds: string[];
}

export interface WorkbenchGraphRenderEvidence {
  cards: WorkbenchGraphRenderedCard[];
  edges: WorkbenchGraphRenderedEdge[];
  search?: { placeholder: string; value: string };
  preview?: {
    symbolUri: string;
    title: string;
    lines: number;
    text: string;
    highlightedTokens: number;
    renderedLines: number;
    maxVerticalGap: number;
    backgroundMatchesEditor: boolean;
  };
  viewport?: { x: number; y: number; zoom: number };
}

export interface WorkbenchGraphAppearance {
  compactZoomThreshold: number;
  compactNodeFontScale: number;
  edgeLabelFontScale: number;
}

export const DEFAULT_WORKBENCH_GRAPH_APPEARANCE: WorkbenchGraphAppearance = {
  compactZoomThreshold: 0.8,
  compactNodeFontScale: 1.6,
  edgeLabelFontScale: 1.3,
};

export type WorkbenchGraphHostMessage =
  | { type: "cockpitContextInvalidated"; message: string }
  | { type: "cockpitAppearance"; appearance: WorkbenchGraphAppearance }
  | {
      type: "cockpitSession";
      session: CockpitSession;
      sourceVisible?: boolean;
      sourcePinned?: boolean;
    }
  | { type: "cockpitFocus"; payload: CockpitFocusPayload }
  | { type: "cockpitRefresh"; payload: CockpitRefreshPayload }
  | { type: "cockpitDropRejected"; message: string }
  | { type: "cockpitTreeDragStatus"; payload: WorkbenchGraphDragPayload | null }
  | {
      type: "cockpitNeighborhood";
      requestId: number;
      intent: "expand" | "radius";
      direction?: CockpitDirection;
      neighborhood: CockpitNeighborhood;
      presentations: Record<string, WorkbenchGraphIdentityPresentation>;
    }
  | { type: "cockpitPreview"; preview: WorkbenchGraphSourcePreview; pinned?: boolean }
  | { type: "cockpitPerspectives"; perspectives: CockpitPerspective[] }
  | { type: "scopeError"; message: string }
  | {
      type: "searchResults";
      requestId: number;
      query: string;
      results: WorkbenchGraphSearchResult[];
    };

export type WorkbenchGraphWebviewMessage =
  | { type: "ready" }
  | { type: "focus"; prefix: string }
  | { type: "back" }
  | { type: "forward" }
  | {
      type: "requestNeighborhood";
      requestId: number;
      symbolUri: string;
      intent: "expand" | "radius";
      direction?: CockpitDirection;
    }
  | { type: "search"; requestId: number; query: string }
  | { type: "inspect"; symbolUri: string }
  | { type: "dismissPreview" }
  | { type: "pinPreview"; symbolUri: string; pinned: boolean }
  | { type: "resolveTreeDrag" }
  | { type: "clearTreeDrag" }
  | { type: "dropTreeSource" }
  | { type: "open"; symbolUri: string }
  | { type: "actions"; symbolUri: string }
  | { type: "pin"; symbolUri: string; pinned: boolean }
  | {
      type: "dropSource";
      payload: WorkbenchGraphDragPayload;
    }
  | { type: "savePerspective"; state: CockpitPerspectiveState }
  | { type: "loadPerspective"; name: string }
  | { type: "deletePerspective"; name: string }
  | {
      type: "ack";
      renderId: number;
      rendered: WorkbenchGraphRenderEvidence;
    };
