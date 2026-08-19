import type { SqlAuthoringForeignKey, SqlAuthoringSnapshot } from "./snapshot.js";

/** One JOIN step: `from` is already in the query (or reached by the previous hop). */
export interface JoinHop {
  foreignKey: SqlAuthoringForeignKey;
  fromOid: number;
  toOid: number;
}

/** A way to reach a target relation from a relation of the query, possibly through mapping tables. */
export interface JoinPlan {
  /** Index in the `presentOids` given to the planner: the query relation the path starts from. */
  startIndex: number;
  startOid: number;
  targetOid: number;
  hops: JoinHop[];
  /** Relations traversed between start and target (mapping tables), in order. */
  viaOids: number[];
}

export interface JoinPlannerOptions {
  /** Longest accepted path; 3 covers a mapping table plus one indirection. */
  maxHops?: number;
  /** Bounds the number of returned plans, shortest first. */
  maxPlans?: number;
}

/**
 * A foreign key is usable for automatic JOINs only when PostgreSQL validated it and its column
 * lists are complete: anything else would compose a condition that does not hold.
 */
export function isStructurallyReliableForeignKey(foreignKey: SqlAuthoringForeignKey): boolean {
  const { sourceColumns, targetColumns } = foreignKey;
  return (
    foreignKey.validated &&
    sourceColumns.length > 0 &&
    sourceColumns.length === targetColumns.length &&
    sourceColumns.every((column) => column.length > 0) &&
    targetColumns.every((column) => column.length > 0)
  );
}

interface JoinEdge {
  foreignKey: SqlAuthoringForeignKey;
  toOid: number;
}

/**
 * Reliable foreign keys indexed by relation, each usable in either direction. Built once so a
 * traversal reads its neighbours instead of scanning every key of the schema at each step.
 */
function joinAdjacency(
  snapshot: Pick<SqlAuthoringSnapshot, "foreignKeys">,
): Map<number, JoinEdge[]> {
  const adjacency = new Map<number, JoinEdge[]>();
  const link = (fromOid: number, edge: JoinEdge) => {
    const edges = adjacency.get(fromOid);
    if (edges) edges.push(edge);
    else adjacency.set(fromOid, [edge]);
  };
  for (const foreignKey of snapshot.foreignKeys) {
    if (!isStructurallyReliableForeignKey(foreignKey)) continue;
    link(foreignKey.sourceTableOid, { foreignKey, toOid: foreignKey.targetTableOid });
    link(foreignKey.targetTableOid, { foreignKey, toOid: foreignKey.sourceTableOid });
  }
  return adjacency;
}

/**
 * Every simple path from a relation already in the query to the target, following reliable
 * foreign keys in either direction and never passing through another relation of the query
 * (a path through it would start there). Shortest plans first, then in a deterministic order
 * (foreign key declaration order), so the same schema always yields the same choices.
 */
export function planJoinPaths(
  snapshot: Pick<SqlAuthoringSnapshot, "foreignKeys">,
  presentOids: readonly number[],
  targetOid: number,
  options: JoinPlannerOptions = {},
): JoinPlan[] {
  return planJoinPathsWith(joinAdjacency(snapshot), presentOids, targetOid, options);
}

function planJoinPathsWith(
  adjacency: Map<number, JoinEdge[]>,
  presentOids: readonly number[],
  targetOid: number,
  options: JoinPlannerOptions,
): JoinPlan[] {
  const maxHops = options.maxHops ?? 3;
  const maxPlans = options.maxPlans ?? 12;
  const present = new Set(presentOids);
  if (present.has(targetOid)) return [];
  const plans: JoinPlan[] = [];
  const visit = (
    startIndex: number,
    startOid: number,
    currentOid: number,
    hops: JoinHop[],
    visited: Set<number>,
  ) => {
    if (hops.length >= maxHops) return;
    for (const { foreignKey, toOid: nextOid } of adjacency.get(currentOid) ?? []) {
      if (visited.has(nextOid)) continue;
      // Self-referencing keys and other relations of the query are not intermediate steps.
      if (nextOid === currentOid || (present.has(nextOid) && nextOid !== targetOid)) continue;
      const hop: JoinHop = { foreignKey, fromOid: currentOid, toOid: nextOid };
      if (nextOid === targetOid) {
        plans.push({
          startIndex,
          startOid,
          targetOid,
          hops: [...hops, hop],
          viaOids: hops.map((previous) => previous.toOid),
        });
        continue;
      }
      visit(startIndex, startOid, nextOid, [...hops, hop], new Set([...visited, nextOid]));
    }
  };
  presentOids.forEach((startOid, startIndex) => {
    visit(startIndex, startOid, startOid, [], new Set([startOid]));
  });
  // Stable order: fewer hops first; the recursion already follows declaration order otherwise.
  return plans
    .map((plan, order) => ({ plan, order }))
    .sort((a, b) => a.plan.hops.length - b.plan.hops.length || a.order - b.order)
    .slice(0, maxPlans)
    .map(({ plan }) => plan);
}

/** The plans a JOIN picker should offer: only the shortest ones (a direct key beats a detour). */
export function shortestJoinPlans(plans: readonly JoinPlan[]): JoinPlan[] {
  const shortest = plans[0]?.hops.length;
  return shortest === undefined ? [] : plans.filter((plan) => plan.hops.length === shortest);
}

/** Every relation reachable from the query within `maxHops`, with its shortest plan first. */
export function reachableJoinTargets(
  snapshot: Pick<SqlAuthoringSnapshot, "foreignKeys">,
  presentOids: readonly number[],
  candidateOids: readonly number[],
  options: JoinPlannerOptions = {},
): Map<number, JoinPlan[]> {
  const adjacency = joinAdjacency(snapshot);
  const reachable = new Map<number, JoinPlan[]>();
  for (const oid of candidateOids) {
    const plans = planJoinPathsWith(adjacency, presentOids, oid, options);
    if (plans.length > 0) reachable.set(oid, plans);
  }
  return reachable;
}
