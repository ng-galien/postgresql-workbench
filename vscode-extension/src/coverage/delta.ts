import type { CoverageExecutionSnapshot } from "../../../packages/coverage/src/index.js";

export type IndexedCoverageSnapshot = Map<number, Map<string, number>>;

export function indexCoverageSnapshot(
  snapshots: readonly CoverageExecutionSnapshot[],
): IndexedCoverageSnapshot {
  return new Map(snapshots.map(({ routineOid, executions }) => [routineOid, new Map(executions)]));
}

export function coverageDelta(
  previous: ReadonlyMap<number, ReadonlyMap<string, number>>,
  current: ReadonlyMap<number, ReadonlyMap<string, number>>,
): IndexedCoverageSnapshot {
  return new Map(
    [...current].map(([routineOid, executions]) => {
      const before = previous.get(routineOid);
      return [
        routineOid,
        new Map(
          [...executions].map(([pointId, executed]) => [
            pointId,
            Math.max(0, executed - (before?.get(pointId) ?? 0)),
          ]),
        ),
      ];
    }),
  );
}
