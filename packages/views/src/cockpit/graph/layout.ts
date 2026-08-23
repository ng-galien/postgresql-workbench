import type { CockpitEdgeModel, CockpitNodeModel } from "./domain.js";

export interface CockpitPosition {
  x: number;
  y: number;
}

export function layoutCockpit(
  nodes: readonly CockpitNodeModel[],
  edges: readonly CockpitEdgeModel[],
  focusIdentity: string | null,
  saved: Readonly<Record<string, CockpitPosition>>,
): Record<string, CockpitPosition> {
  if (!focusIdentity) return {};
  const positions: Record<string, CockpitPosition> = { ...saved };
  positions[focusIdentity] ??= { x: 0, y: 0 };
  const origin = positions[focusIdentity];
  const depths = directionalDepths(nodes, edges, focusIdentity);
  const layers = new Map<number, CockpitNodeModel[]>();
  for (const node of nodes) {
    if (node.identity === focusIdentity || positions[node.identity]) continue;
    const depth = depths.get(node.identity) ?? (node.pinned ? 0 : 2);
    layers.set(depth, [...(layers.get(depth) ?? []), node]);
  }
  for (const [depth, layer] of [...layers].sort(([left], [right]) => left - right)) {
    const sorted = [...layer].sort((left, right) => {
      const leftAnchor = parentAnchorY(left.identity, depth, edges, positions);
      const rightAnchor = parentAnchorY(right.identity, depth, edges, positions);
      return (
        (leftAnchor ?? Number.MAX_SAFE_INTEGER) - (rightAnchor ?? Number.MAX_SAFE_INTEGER) ||
        right.score - left.score ||
        left.identity.localeCompare(right.identity)
      );
    });
    const step = 148;
    const start = -((sorted.length - 1) * step) / 2;
    sorted.forEach((node, index) => {
      const parentY = parentAnchorY(node.identity, depth, edges, positions);
      const preferred = {
        x: origin.x + (depth === 0 ? (index - (sorted.length - 1) / 2) * 280 : depth * 340),
        y: origin.y + (depth === 0 ? 360 : (parentY ?? origin.y + start + index * step) - origin.y),
      };
      positions[node.identity] = avoidCollision(preferred, positions);
    });
  }
  return positions;
}

function parentAnchorY(
  identity: string,
  depth: number,
  edges: readonly CockpitEdgeModel[],
  positions: Readonly<Record<string, CockpitPosition>>,
): number | undefined {
  if (depth === 0) return undefined;
  const parents = edges.flatMap((edge) => {
    if (depth < 0 && edge.source === identity) return [edge.target];
    if (depth > 0 && edge.target === identity) return [edge.source];
    return [];
  });
  const values = parents.flatMap((parent) => (positions[parent] ? [positions[parent].y] : []));
  if (values.length === 0) return undefined;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function directionalDepths(
  nodes: readonly CockpitNodeModel[],
  edges: readonly CockpitEdgeModel[],
  focusIdentity: string,
): Map<string, number> {
  const visible = new Set(nodes.map((node) => node.identity));
  const depths = new Map<string, number>([[focusIdentity, 0]]);
  const visit = (direction: 1 | -1) => {
    let frontier = [focusIdentity];
    for (let distance = 1; distance <= 4 && frontier.length > 0; distance += 1) {
      const next = new Set<string>();
      for (const identity of frontier) {
        for (const edge of edges) {
          const candidate =
            direction === 1 && edge.source === identity
              ? edge.target
              : direction === -1 && edge.target === identity
                ? edge.source
                : undefined;
          if (!candidate || !visible.has(candidate) || depths.has(candidate)) continue;
          depths.set(candidate, distance * direction);
          next.add(candidate);
        }
      }
      frontier = [...next];
    }
  };
  visit(-1);
  visit(1);
  return depths;
}

function avoidCollision(
  preferred: CockpitPosition,
  positions: Readonly<Record<string, CockpitPosition>>,
): CockpitPosition {
  const occupied = Object.values(positions);
  for (let attempt = 0; attempt < occupied.length * 2 + 4; attempt += 1) {
    const distance = Math.ceil(attempt / 2) * 148;
    const offset = attempt === 0 ? 0 : attempt % 2 === 1 ? distance : -distance;
    const candidate = { x: preferred.x, y: preferred.y + offset };
    if (
      occupied.every(
        (position) =>
          Math.abs(position.x - candidate.x) > 252 || Math.abs(position.y - candidate.y) > 124,
      )
    ) {
      return candidate;
    }
  }
  return preferred;
}
