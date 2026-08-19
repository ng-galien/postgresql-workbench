import type {
  CodeMonikerGraphResult,
  CodeMonikerSymbol,
} from "../../../packages/catalog/src/localCodeMoniker.js";
import {
  buildWorkbenchObjects,
  isWorkbenchDatabaseSymbol,
  type WorkbenchDatabaseIdentity,
  type WorkbenchObjectModel,
  workbenchObjectFromSymbol,
} from "../../../packages/catalog/src/objectModel.js";

export type WorkbenchRelationKind = "calls" | "reads" | "writes" | "references" | "uses_type";
export type WorkbenchRelationDirection = "outgoing" | "incoming";

export interface WorkbenchRelationTarget {
  symbol: CodeMonikerSymbol;
  object?: WorkbenchObjectModel;
  count: number;
  members: Array<{ kind: string; name: string; signature: string }>;
}

export interface WorkbenchRelationGroup {
  relation: WorkbenchRelationKind;
  direction: WorkbenchRelationDirection;
  targets: WorkbenchRelationTarget[];
}

export type WorkbenchRelationFailureStatus = "missing" | "ambiguous" | "error";

const RELATION_ORDER: readonly WorkbenchRelationKind[] = [
  "calls",
  "reads",
  "writes",
  "references",
  "uses_type",
];
const RELATIONS = new Set<string>(RELATION_ORDER);

export function buildWorkbenchRelationGroups(
  graph: CodeMonikerGraphResult,
  database: WorkbenchDatabaseIdentity,
  indexedSymbols: readonly CodeMonikerSymbol[] = [],
): WorkbenchRelationGroup[] {
  const indexedObjects = buildWorkbenchObjects(indexedSymbols, database);
  const canonicalSymbols = new Map(indexedSymbols.map((symbol) => [symbol.uri, symbol]));
  const groups = new Map<string, Map<string, WorkbenchRelationTarget>>();

  collectNeighbors(graph.callees, "outgoing");
  collectNeighbors(graph.callers, "incoming");

  return [...groups.entries()]
    .map(([key, targets]) => {
      const [relation, direction] = key.split("\0") as [
        WorkbenchRelationKind,
        WorkbenchRelationDirection,
      ];
      return {
        relation,
        direction,
        targets: [...targets.values()].sort(compareTargets),
      };
    })
    .sort(
      (left, right) =>
        RELATION_ORDER.indexOf(left.relation) - RELATION_ORDER.indexOf(right.relation) ||
        directionOrder(left.direction) - directionOrder(right.direction),
    );

  function collectNeighbors(
    neighbors: CodeMonikerGraphResult["callees"],
    direction: WorkbenchRelationDirection,
  ): void {
    for (const neighbor of neighbors) {
      const neighborSymbol = canonicalSymbols.get(neighbor.symbol.uri) ?? neighbor.symbol;
      if (!isWorkbenchDatabaseSymbol(neighborSymbol, database)) {
        continue;
      }
      const object =
        workbenchObjectFromSymbol(neighborSymbol, database) ??
        indexedObjects.find((candidate) => candidate.sourceUri === neighborSymbol.file);
      for (const relation of neighbor.kinds) {
        if (!RELATIONS.has(relation)) {
          continue;
        }
        const key = `${relation}\0${direction}`;
        const targets = groups.get(key) ?? new Map<string, WorkbenchRelationTarget>();
        const targetKey = object?.sourceUri ?? neighbor.symbol.uri;
        const existing = targets.get(targetKey);
        const member = relationMember(neighborSymbol);
        const members = new Map(
          (existing?.members ?? []).map((candidate) => [relationMemberKey(candidate), candidate]),
        );
        if (member) members.set(relationMemberKey(member), member);
        const symbol =
          !existing || neighborSymbol.uri === object?.symbolUri ? neighborSymbol : existing.symbol;
        targets.set(targetKey, {
          symbol,
          object,
          count: (existing?.count ?? 0) + neighbor.count,
          members: [...members.values()].sort((left, right) => left.name.localeCompare(right.name)),
        });
        groups.set(key, targets);
      }
    }
  }
}

export function mergeWorkbenchRelationGroups(
  groups: readonly WorkbenchRelationGroup[],
): WorkbenchRelationGroup[] {
  const merged = new Map<string, Map<string, WorkbenchRelationTarget>>();
  for (const group of groups) {
    const groupKey = `${group.relation}\0${group.direction}`;
    const targets = merged.get(groupKey) ?? new Map<string, WorkbenchRelationTarget>();
    for (const target of group.targets) {
      const targetKey = target.object?.sourceUri ?? target.symbol.uri;
      const existing = targets.get(targetKey);
      const members = new Map(
        [...(existing?.members ?? []), ...target.members].map((member) => [
          relationMemberKey(member),
          member,
        ]),
      );
      targets.set(targetKey, {
        symbol: existing?.symbol ?? target.symbol,
        object: existing?.object ?? target.object,
        count: (existing?.count ?? 0) + target.count,
        members: [...members.values()].sort((left, right) => left.name.localeCompare(right.name)),
      });
    }
    merged.set(groupKey, targets);
  }
  return [...merged.entries()]
    .map(([key, targets]) => {
      const [relation, direction] = key.split("\0") as [
        WorkbenchRelationKind,
        WorkbenchRelationDirection,
      ];
      return { relation, direction, targets: [...targets.values()].sort(compareTargets) };
    })
    .sort(
      (left, right) =>
        RELATION_ORDER.indexOf(left.relation) - RELATION_ORDER.indexOf(right.relation) ||
        directionOrder(left.direction) - directionOrder(right.direction),
    );
}

function relationMember(
  symbol: CodeMonikerSymbol,
): { kind: string; name: string; signature: string } | undefined {
  return symbol.kind === "column" || symbol.kind === "constraint"
    ? { kind: symbol.kind, name: symbol.name, signature: symbol.signature }
    : undefined;
}

function relationMemberKey(member: { kind: string; name: string; signature: string }): string {
  return `${member.kind}\0${member.name}\0${member.signature}`;
}

export function isWorkbenchRelationSnapshotCurrent(
  actualGeneration: number | null,
  expectedGeneration: number | null,
  focusFound: boolean,
): boolean {
  return focusFound && actualGeneration === expectedGeneration;
}

export function classifyWorkbenchRelationFailure(message: string): WorkbenchRelationFailureStatus {
  if (/ambiguous/i.test(message)) {
    return "ambiguous";
  }
  if (/not found|symbol_not_found|focus_not_found/i.test(message)) {
    return "missing";
  }
  return "error";
}

function compareTargets(left: WorkbenchRelationTarget, right: WorkbenchRelationTarget): number {
  return (
    (left.object?.schema ?? "").localeCompare(right.object?.schema ?? "") ||
    (left.object?.name ?? left.symbol.name).localeCompare(
      right.object?.name ?? right.symbol.name,
    ) ||
    left.symbol.uri.localeCompare(right.symbol.uri)
  );
}

function directionOrder(direction: WorkbenchRelationDirection): number {
  return direction === "outgoing" ? 0 : 1;
}
