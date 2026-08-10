import type { CodeMonikerSymbol } from "../../../src/workbench/localCodeMoniker.js";

export type CockpitDirection = "incoming" | "outgoing";

export interface WorkbenchGraphIdentityPresentation {
  label: string;
  kind: string;
  origin?: string;
  hasCockpitActions?: boolean;
}

export interface WorkbenchGraphBreadcrumb {
  prefix: string;
  label: string;
}

export interface CockpitNeighbor {
  direction: CockpitDirection;
  symbol: CodeMonikerSymbol;
  count: number;
  kinds: string[];
  score: number;
}

export interface CockpitNeighborhood {
  focus: CodeMonikerSymbol;
  incoming: CockpitNeighbor[];
  outgoing: CockpitNeighbor[];
  totals: { incoming: number; outgoing: number };
  unresolved: number;
  limited: boolean;
}

export interface WorkbenchGraphSearchResult {
  symbolUri: string;
  label: string;
  schema: string;
  kind: string;
  detail: string;
  resultType: "schema" | "object" | "member";
  incoming?: number;
  outgoing?: number;
  countStatus: "loading" | "available" | "unavailable";
}

export interface WorkbenchGraphSourcePreview {
  symbolUri: string;
  title: string;
  kind: string;
  file: string;
  firstLine: number;
  lastLine: number;
  lines: Array<{ number: number; text: string }>;
}

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
  serverId: string;
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
  perspective?: CockpitPerspective;
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

export type WorkbenchGraphHostMessage =
  | { type: "databaseContextInvalidated"; message: string }
  | { type: "cockpitSession"; session: CockpitSession }
  | { type: "cockpitFocus"; payload: CockpitFocusPayload }
  | {
      type: "cockpitNeighborhood";
      requestId: number;
      intent: "expand" | "radius";
      direction?: CockpitDirection;
      neighborhood: CockpitNeighborhood;
      presentations: Record<string, WorkbenchGraphIdentityPresentation>;
    }
  | { type: "cockpitPreview"; preview: WorkbenchGraphSourcePreview }
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
  | { type: "open"; symbolUri: string }
  | { type: "actions"; symbolUri: string }
  | { type: "pin"; symbolUri: string; pinned: boolean }
  | { type: "savePerspective"; state: CockpitPerspectiveState }
  | { type: "loadPerspective"; name: string }
  | { type: "deletePerspective"; name: string }
  | {
      type: "ack";
      renderId: number;
      rendered: WorkbenchGraphRenderEvidence;
    };
