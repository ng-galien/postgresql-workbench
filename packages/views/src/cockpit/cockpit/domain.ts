import type { CodeMonikerSymbol } from "../../../../catalog/src/localCodeMoniker.js";
import type {
  CockpitDirection,
  CockpitNeighborhood,
  WorkbenchGraphIdentityPresentation,
} from "../protocol.js";

export interface CockpitNodeModel {
  identity: string;
  symbol: CodeMonikerSymbol;
  presentation: WorkbenchGraphIdentityPresentation;
  incoming: number;
  outgoing: number;
  score: number;
  pinned: boolean;
}

export interface CockpitEdgeModel {
  id: string;
  source: string;
  target: string;
  count: number;
  kinds: string[];
}

export interface NeighborhoodModel {
  value: CockpitNeighborhood;
  presentations: Record<string, WorkbenchGraphIdentityPresentation>;
  revealed: { incoming: number; outgoing: number };
}

const COCKPIT_BATCH_SIZE = 3;
const COCKPIT_DOM_BUDGET = 60;

export interface ExplorationModel {
  focusIdentity: string | null;
  nodes: Record<string, CockpitNodeModel>;
  edges: Record<string, CockpitEdgeModel>;
  neighborhoods: Record<string, NeighborhoodModel>;
}

export function emptyExploration(): ExplorationModel {
  return { focusIdentity: null, nodes: {}, edges: {}, neighborhoods: {} };
}

export function startExploration(
  current: ExplorationModel,
  neighborhood: CockpitNeighborhood,
  presentations: Record<string, WorkbenchGraphIdentityPresentation>,
): ExplorationModel {
  const pinnedNodes = Object.fromEntries(
    Object.entries(current.nodes).filter(([, node]) => node.pinned),
  );
  let next: ExplorationModel = {
    focusIdentity: neighborhood.focus.uri,
    nodes: pinnedNodes,
    edges: {},
    neighborhoods: {},
  };
  next = installNeighborhood(next, neighborhood, presentations);
  next = revealNeighbors(next, neighborhood.focus.uri, "incoming", COCKPIT_BATCH_SIZE);
  next = revealNeighbors(next, neighborhood.focus.uri, "outgoing", COCKPIT_BATCH_SIZE);
  return pruneExploration(next);
}

export function installNeighborhood(
  exploration: ExplorationModel,
  neighborhood: CockpitNeighborhood,
  presentations: Record<string, WorkbenchGraphIdentityPresentation>,
): ExplorationModel {
  const next = cloneExploration(exploration);
  const identity = neighborhood.focus.uri;
  next.neighborhoods[identity] = next.neighborhoods[identity] ?? {
    value: neighborhood,
    presentations,
    revealed: { incoming: 0, outgoing: 0 },
  };
  next.neighborhoods[identity].value = neighborhood;
  next.neighborhoods[identity].presentations = presentations;
  const current = next.nodes[identity];
  next.nodes[identity] = {
    identity,
    symbol: neighborhood.focus,
    presentation: presentations[identity] ?? {
      label: neighborhood.focus.name,
      kind: neighborhood.focus.kind,
    },
    incoming: neighborhood.totals.incoming,
    outgoing: neighborhood.totals.outgoing,
    score: Number.MAX_SAFE_INTEGER,
    pinned: current?.pinned ?? false,
  };
  return next;
}

export function installPinnedNodes(
  exploration: ExplorationModel,
  pinned: ReadonlyArray<{
    symbol: CodeMonikerSymbol;
    presentation: WorkbenchGraphIdentityPresentation;
  }>,
): ExplorationModel {
  const next = cloneExploration(exploration);
  for (const { symbol, presentation } of pinned) {
    if (next.nodes[symbol.uri]) {
      next.nodes[symbol.uri].pinned = true;
      continue;
    }
    next.nodes[symbol.uri] = {
      identity: symbol.uri,
      symbol,
      presentation,
      incoming: 0,
      outgoing: 0,
      score: Number.MAX_SAFE_INTEGER - 1,
      pinned: true,
    };
  }
  return pruneExploration(next);
}

export function refreshExploration(
  exploration: ExplorationModel,
  refreshes: ReadonlyArray<{
    previousIdentity: string;
    neighborhood: CockpitNeighborhood;
    presentations: Record<string, WorkbenchGraphIdentityPresentation>;
  }>,
  identityRemap: Readonly<Record<string, string>>,
  validIdentities: ReadonlySet<string>,
  focusIdentity: string | null,
  pinnedIdentities: ReadonlySet<string>,
): ExplorationModel {
  let next = remapExploration(exploration, identityRemap);
  next.focusIdentity = focusIdentity;
  for (const [identity, node] of Object.entries(next.nodes)) {
    if (!validIdentities.has(identity)) delete next.nodes[identity];
    else node.pinned = pinnedIdentities.has(identity);
  }
  for (const [id, edge] of Object.entries(next.edges)) {
    if (!next.nodes[edge.source] || !next.nodes[edge.target]) delete next.edges[id];
  }
  const revealed = new Map<string, { incoming: number; outgoing: number }>();
  const refreshedIdentities = new Set(refreshes.map(({ neighborhood }) => neighborhood.focus.uri));
  for (const refresh of refreshes) {
    const identity = refresh.neighborhood.focus.uri;
    const current = next.neighborhoods[identity];
    revealed.set(identity, current?.revealed ?? { incoming: 0, outgoing: 0 });
  }
  for (const [id, edge] of Object.entries(next.edges)) {
    if (refreshedIdentities.has(edge.source) || refreshedIdentities.has(edge.target)) {
      delete next.edges[id];
    }
  }
  for (const refresh of refreshes) {
    const identity = refresh.neighborhood.focus.uri;
    next = installNeighborhood(next, refresh.neighborhood, refresh.presentations);
    next.neighborhoods[identity].revealed = { incoming: 0, outgoing: 0 };
  }
  for (const refresh of refreshes) {
    const identity = refresh.neighborhood.focus.uri;
    const previous = revealed.get(identity) ?? { incoming: 0, outgoing: 0 };
    for (const direction of ["incoming", "outgoing"] as const) {
      const amount = Math.min(previous[direction], refresh.neighborhood[direction].length);
      if (amount > 0) next = revealNeighbors(next, identity, direction, amount);
    }
  }
  if (focusIdentity && !next.nodes[focusIdentity]) {
    const focusRefresh = refreshes.find(
      ({ neighborhood }) => neighborhood.focus.uri === focusIdentity,
    );
    if (focusRefresh) {
      next = startExploration(next, focusRefresh.neighborhood, focusRefresh.presentations);
    }
  }
  for (const identity of Object.keys(next.nodes)) {
    if (identity === focusIdentity || next.nodes[identity].pinned) continue;
    const linked = Object.values(next.edges).some(
      (edge) => edge.source === identity || edge.target === identity,
    );
    if (!linked) delete next.nodes[identity];
  }
  return next;
}

function remapExploration(
  exploration: ExplorationModel,
  identityRemap: Readonly<Record<string, string>>,
): ExplorationModel {
  const next = cloneExploration(exploration);
  const remap = (identity: string) => identityRemap[identity] ?? identity;
  next.focusIdentity = next.focusIdentity ? remap(next.focusIdentity) : null;
  next.nodes = Object.fromEntries(
    Object.entries(next.nodes).map(([identity, node]) => {
      const mapped = remap(identity);
      return [mapped, { ...node, identity: mapped }];
    }),
  );
  next.edges = Object.fromEntries(
    Object.values(next.edges).map((edge) => {
      const source = remap(edge.source);
      const target = remap(edge.target);
      const id = edgeId(source, target);
      return [id, { ...edge, id, source, target }];
    }),
  );
  next.neighborhoods = Object.fromEntries(
    Object.entries(next.neighborhoods).map(([identity, neighborhood]) => [
      remap(identity),
      neighborhood,
    ]),
  );
  return next;
}

export function revealNeighbors(
  exploration: ExplorationModel,
  identity: string,
  direction: CockpitDirection,
  amount = COCKPIT_BATCH_SIZE,
): ExplorationModel {
  const next = cloneExploration(exploration);
  const catalog = next.neighborhoods[identity];
  if (!catalog) return next;
  const candidates = catalog.value[direction];
  const start = catalog.revealed[direction];
  const end = Math.min(candidates.length, start + amount);
  for (const candidate of candidates.slice(start, end)) {
    const neighborIdentity = candidate.symbol.uri;
    const current = next.nodes[neighborIdentity];
    next.nodes[neighborIdentity] = {
      identity: neighborIdentity,
      symbol: candidate.symbol,
      presentation: current?.presentation ??
        catalog.presentations[neighborIdentity] ?? {
          label: candidate.symbol.name,
          kind: candidate.symbol.kind,
        },
      incoming: current?.incoming ?? 0,
      outgoing: current?.outgoing ?? 0,
      score: Math.max(current?.score ?? 0, candidate.score),
      pinned: current?.pinned ?? false,
    };
    const source = direction === "incoming" ? neighborIdentity : identity;
    const target = direction === "incoming" ? identity : neighborIdentity;
    const id = edgeId(source, target);
    const previous = next.edges[id];
    next.edges[id] = {
      id,
      source,
      target,
      count: Math.max(previous?.count ?? 0, candidate.count),
      kinds: [...new Set([...(previous?.kinds ?? []), ...candidate.kinds])].sort(),
    };
  }
  catalog.revealed[direction] = end;
  return pruneExploration(next);
}

export function restorePerspectiveExpansions(
  exploration: ExplorationModel,
  expansions: Record<string, { incoming: number; outgoing: number }>,
): ExplorationModel {
  let next = exploration;
  for (const [identity, target] of Object.entries(expansions)) {
    const neighborhood = next.neighborhoods[identity];
    if (!neighborhood) continue;
    for (const direction of ["incoming", "outgoing"] as const) {
      const missing = Math.max(0, target[direction] - neighborhood.revealed[direction]);
      if (missing > 0) next = revealNeighbors(next, identity, direction, missing);
    }
  }
  return next;
}

export function hiddenCount(
  exploration: ExplorationModel,
  identity: string,
  direction: CockpitDirection,
): number {
  const catalog = exploration.neighborhoods[identity];
  if (!catalog) return 0;
  return Math.max(0, catalog.value.totals[direction] - catalog.revealed[direction]);
}

export function togglePinned(exploration: ExplorationModel, identity: string): ExplorationModel {
  const next = cloneExploration(exploration);
  const node = next.nodes[identity];
  if (node) node.pinned = !node.pinned;
  return next;
}

export function edgeId(source: string, target: string): string {
  return `${source}->${target}`;
}

export function shortestPath(
  edges: readonly CockpitEdgeModel[],
  start: string,
  target: string,
): string[] {
  return directedPath(edges, start, target) || directedPath(edges, start, target, true) || [];
}

function directedPath(
  edges: readonly CockpitEdgeModel[],
  start: string,
  target: string,
  undirected = false,
): string[] | undefined {
  const queue: string[][] = [[start]];
  const visited = new Set([start]);
  while (queue.length > 0) {
    const path = queue.shift();
    if (!path) break;
    const current = path.at(-1);
    if (!current) continue;
    if (current === target) return path;
    for (const edge of edges) {
      const next =
        edge.source === current
          ? edge.target
          : undirected && edge.target === current
            ? edge.source
            : null;
      if (!next || visited.has(next)) continue;
      visited.add(next);
      queue.push([...path, next]);
    }
  }
  return undefined;
}

export function cloneExploration(exploration: ExplorationModel): ExplorationModel {
  return {
    focusIdentity: exploration.focusIdentity,
    nodes: Object.fromEntries(
      Object.entries(exploration.nodes).map(([identity, node]) => [identity, { ...node }]),
    ),
    edges: Object.fromEntries(
      Object.entries(exploration.edges).map(([identity, edge]) => [
        identity,
        { ...edge, kinds: [...edge.kinds] },
      ]),
    ),
    neighborhoods: Object.fromEntries(
      Object.entries(exploration.neighborhoods).map(([identity, neighborhood]) => [
        identity,
        {
          value: neighborhood.value,
          presentations: neighborhood.presentations,
          revealed: { ...neighborhood.revealed },
        },
      ]),
    ),
  };
}

function pruneExploration(exploration: ExplorationModel): ExplorationModel {
  const identities = Object.keys(exploration.nodes);
  if (identities.length <= COCKPIT_DOM_BUDGET) return exploration;
  const removable = identities
    .filter(
      (identity) => identity !== exploration.focusIdentity && !exploration.nodes[identity].pinned,
    )
    .sort(
      (left, right) =>
        exploration.nodes[left].score - exploration.nodes[right].score || left.localeCompare(right),
    );
  const remove = new Set(removable.slice(0, identities.length - COCKPIT_DOM_BUDGET));
  for (const identity of remove) delete exploration.nodes[identity];
  for (const [identity, edge] of Object.entries(exploration.edges)) {
    if (remove.has(edge.source) || remove.has(edge.target)) delete exploration.edges[identity];
  }
  return exploration;
}
