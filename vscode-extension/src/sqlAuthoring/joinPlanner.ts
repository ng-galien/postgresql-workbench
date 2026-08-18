import type { SqlAuthoringForeignKey, SqlAuthoringSnapshot } from "./protocol.js";

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
  const sourceColumns = foreignKey.sourceColumns;
  const targetColumns = foreignKey.targetColumns;
  return (
    foreignKey.validated === true &&
    Array.isArray(sourceColumns) &&
    Array.isArray(targetColumns) &&
    sourceColumns.length > 0 &&
    sourceColumns.length === targetColumns.length &&
    sourceColumns.every((column) => typeof column === "string" && column.length > 0) &&
    targetColumns.every((column) => typeof column === "string" && column.length > 0)
  );
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
  const maxHops = options.maxHops ?? 3;
  const maxPlans = options.maxPlans ?? 12;
  const present = new Set(presentOids);
  if (present.has(targetOid)) return [];
  const edges = snapshot.foreignKeys
    .map((foreignKey, order) => ({ foreignKey, order }))
    .filter(({ foreignKey }) => isStructurallyReliableForeignKey(foreignKey));
  const plans: JoinPlan[] = [];
  const visit = (
    startIndex: number,
    startOid: number,
    currentOid: number,
    hops: JoinHop[],
    visited: Set<number>,
  ) => {
    if (hops.length >= maxHops) return;
    for (const { foreignKey } of edges) {
      const nextOid =
        foreignKey.sourceTableOid === currentOid
          ? foreignKey.targetTableOid
          : foreignKey.targetTableOid === currentOid
            ? foreignKey.sourceTableOid
            : undefined;
      if (nextOid === undefined || visited.has(nextOid)) continue;
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
  const reachable = new Map<number, JoinPlan[]>();
  for (const oid of candidateOids) {
    const plans = planJoinPaths(snapshot, presentOids, oid, options);
    if (plans.length > 0) reachable.set(oid, plans);
  }
  return reachable;
}
