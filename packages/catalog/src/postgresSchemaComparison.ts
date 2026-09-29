import { createHash } from "node:crypto";
import type { VirtualSqlDocument, VirtualSqlSourceSet } from "./postgresCatalog.js";

interface CodeMonikerDiffImpactSide {
  identity: string;
  compact_identity: string;
  kind: string;
  signature?: string;
}

interface CodeMonikerDiffImpactSymbol {
  kind: string;
  body_changed?: boolean;
  signature_changed?: boolean;
  visibility_changed?: boolean;
  header_changed?: boolean;
  old?: CodeMonikerDiffImpactSide | null;
  new?: CodeMonikerDiffImpactSide | null;
}

interface CodeMonikerDiffImpactRef {
  kind: string;
  ref_kind: string;
  old_source?: string | null;
  new_source?: string | null;
  old_source_compact?: string | null;
  new_source_compact?: string | null;
  old_target?: string | null;
  new_target?: string | null;
  old_target_compact?: string | null;
  new_target_compact?: string | null;
}

interface CodeMonikerDiffImpactResult {
  diagnostics: string[];
  symbol_changes: CodeMonikerDiffImpactSymbol[];
  ref_changes: CodeMonikerDiffImpactRef[];
}

export interface CodeMonikerStructureComparisonClient {
  readonly diffImpact: {
    compare(options: {
      scope: string;
      project?: string | null;
      base: VirtualSqlSourceSet;
      head: VirtualSqlSourceSet;
      files: Array<{
        status: "modified";
        old_uri: string;
        new_uri: string;
        old_hunks: Array<{ start: number; end: number }>;
        new_hunks: Array<{ start: number; end: number }>;
      }>;
    }): Promise<CodeMonikerDiffImpactResult>;
  };
}

const COMPARISON_URI = "memory://postgres-schema-comparison/schema.sql";
const COMPARISON_SOURCE_SET = "postgres-schema-comparison";

export interface PostgresStructureDifference {
  identity: string;
  kind: string;
  change: string;
}

export interface PostgresReferenceDifference {
  kind: string;
  oldTarget?: string;
  newTarget?: string;
}

export interface PostgresStructureComparison {
  isomorphic: boolean;
  onlyInBase: PostgresStructureDifference[];
  onlyInHead: PostgresStructureDifference[];
  changed: PostgresStructureDifference[];
  references: PostgresReferenceDifference[];
  diagnostics: string[];
  raw: CodeMonikerDiffImpactResult;
}

export type PostgresStructureComparisonMode = "semantic" | "structure";

export async function comparePostgresStructures(
  client: CodeMonikerStructureComparisonClient,
  base: readonly VirtualSqlDocument[],
  head: readonly VirtualSqlDocument[],
  scope: string,
  mode: PostgresStructureComparisonMode = "semantic",
): Promise<PostgresStructureComparison> {
  const baseDocument = assembleStructureDocument(base);
  const headDocument = assembleStructureDocument(head);
  const raw = await client.diffImpact.compare({
    scope,
    project: "postgres-schema",
    base: sourceSet("base", baseDocument),
    head: sourceSet("head", headDocument),
    files: [
      {
        status: "modified",
        old_uri: COMPARISON_URI,
        new_uri: COMPARISON_URI,
        old_hunks: [wholeDocumentSpan(baseDocument.content)],
        new_hunks: [wholeDocumentSpan(headDocument.content)],
      },
    ],
  });
  const relevantSymbols =
    mode === "semantic"
      ? raw.symbol_changes
      : reconcileEquivalentConstraints(raw.symbol_changes.filter(isStructuralSymbolChange));
  const onlyInBase = relevantSymbols
    .filter((change) => change.kind === "removed")
    .map((change) => structureDifference(change, "old"));
  const onlyInHead = relevantSymbols
    .filter((change) => change.kind === "added")
    .map((change) => structureDifference(change, "new"));
  const changed = relevantSymbols
    .filter((change) => change.kind !== "removed" && change.kind !== "added")
    .map((change) => structureDifference(change, change.new ? "new" : "old"));
  const references =
    mode === "semantic"
      ? raw.ref_changes.map(referenceDifference)
      : structuralReferenceDifferences(raw.ref_changes);
  return {
    isomorphic:
      onlyInBase.length === 0 &&
      onlyInHead.length === 0 &&
      changed.length === 0 &&
      references.length === 0 &&
      raw.diagnostics.length === 0,
    onlyInBase,
    onlyInHead,
    changed,
    references,
    diagnostics: raw.diagnostics,
    raw,
  };
}

function isStructuralSymbolChange(change: CodeMonikerDiffImpactSymbol): boolean {
  if (change.kind === "added" || change.kind === "removed") return true;
  if (!change.old || !change.new) return true;
  if (change.signature_changed || change.kind === "signature-changed") {
    return structuralSignaturesDiffer(change.old.signature, change.new.signature);
  }
  if (
    (change.body_changed || change.kind === "body-modified") &&
    STRUCTURAL_BODY_KINDS.has(change.new.kind)
  ) {
    return structuralSignaturesDiffer(change.old.signature, change.new.signature);
  }
  return false;
}

const STRUCTURAL_BODY_KINDS = new Set([
  "column",
  "constraint",
  "index",
  "table",
  "trigger",
  "type",
  "view",
]);

function structuralSignaturesDiffer(oldSignature?: string, newSignature?: string): boolean {
  if (oldSignature === undefined || newSignature === undefined) return true;
  return normalizeStructuralSignature(oldSignature) !== normalizeStructuralSignature(newSignature);
}

function reconcileEquivalentConstraints(
  changes: readonly CodeMonikerDiffImpactSymbol[],
): CodeMonikerDiffImpactSymbol[] {
  const remaining = [...changes];
  const addedByStructure = new Map<string, number[]>();
  for (const [index, change] of remaining.entries()) {
    if (change.kind !== "added" || change.new?.kind !== "constraint") continue;
    const key = constraintStructureKey(change.new);
    const matches = addedByStructure.get(key) ?? [];
    matches.push(index);
    addedByStructure.set(key, matches);
  }
  const ignored = new Set<number>();
  for (const [index, change] of remaining.entries()) {
    if (change.kind !== "removed" || change.old?.kind !== "constraint") continue;
    const matches = addedByStructure.get(constraintStructureKey(change.old));
    const matchingIndex = matches?.pop();
    if (matchingIndex === undefined) continue;
    ignored.add(index);
    ignored.add(matchingIndex);
  }
  return remaining.filter(
    (change, index) => !ignored.has(index) && !isMaterializedConstraintArtifact(change),
  );
}

function constraintStructureKey(side: CodeMonikerDiffImpactSide): string {
  return `${constraintOwner(side)}\u0000${normalizeStructuralSignature(side.signature ?? "")}`;
}

function normalizeStructuralSignature(signature: string): string {
  const withoutConstraintName = signature
    .trim()
    .replace(/^constraint\s+(?:"(?:[^"]|"")*"|\S+)\s+/iu, "");
  const normalized = normalizeOutsideQuotedSql(withoutConstraintName);
  if (!normalized.startsWith("check(") || !normalized.endsWith(")")) return normalized;
  let expression = normalized.slice("check(".length, -1);
  while (hasWrappingParentheses(expression)) expression = expression.slice(1, -1);
  return `check(${expression})`;
}

function normalizeOutsideQuotedSql(source: string): string {
  let result = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      result += character;
      if (character !== quote) continue;
      if (source[index + 1] === quote) {
        result += source[index + 1];
        index += 1;
      } else {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      result += character;
    } else if (/\s/u.test(character)) {
      const previous = result.at(-1);
      const next = source.slice(index).match(/\S/u)?.[0];
      if (previous && next && previous !== " " && !/[(),]/u.test(previous + next)) {
        result += " ";
      }
    } else {
      result += character.toLowerCase();
    }
  }
  return result;
}

function hasWrappingParentheses(source: string): boolean {
  if (!source.startsWith("(") || !source.endsWith(")")) return false;
  let depth = 0;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character !== quote) continue;
      if (source[index + 1] === quote) index += 1;
      else quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    if (depth === 0 && index < source.length - 1) return false;
  }
  return depth === 0 && quote === undefined;
}

function constraintCategory(signature: string): string {
  const normalized = signature.toLowerCase();
  if (normalized.includes("foreign key") || normalized.includes("references")) return "foreign-key";
  if (normalized.includes("primary key")) return "primary-key";
  if (normalized.includes("unique")) return "unique";
  if (normalized.includes("check")) return "check";
  if (normalized.includes("not null")) return "not-null";
  if (normalized === "null") return "null";
  if (normalized.includes("default")) return "default";
  if (normalized.includes("generated")) return "generated";
  return normalized;
}

function isMaterializedConstraintArtifact(change: CodeMonikerDiffImpactSymbol): boolean {
  if (change.kind === "removed" && change.old?.kind === "constraint") {
    return constraintCategory(change.old.signature ?? "") === "null";
  }
  return false;
}

function constraintOwner(side: CodeMonikerDiffImpactSide): string {
  return (side.compact_identity || side.identity).replace(/\/constraint:[^/]+$/, "");
}

function structuralReferenceDifferences(
  changes: readonly CodeMonikerDiffImpactRef[],
): PostgresReferenceDifference[] {
  const differences: PostgresReferenceDifference[] = [];
  const balances = new Map<string, number>();
  for (const change of changes) {
    const oldSource = change.old_source_compact ?? change.old_source;
    const newSource = change.new_source_compact ?? change.new_source;
    if (
      change.ref_kind !== "member_of" ||
      ![oldSource, newSource].some((source) => source?.includes("/index:"))
    ) {
      continue;
    }
    const oldTarget = change.old_target_compact ?? change.old_target;
    const newTarget = change.new_target_compact ?? change.new_target;
    if (oldTarget && newTarget) {
      if (oldTarget !== newTarget) {
        differences.push({
          kind: `${change.kind}:${change.ref_kind}`,
          oldTarget,
          newTarget,
        });
      }
      continue;
    }
    const target = oldTarget ?? newTarget;
    if (!target) continue;
    const direction = oldTarget ? -1 : 1;
    const source = oldSource ?? newSource ?? "";
    const key = `${change.ref_kind}\u0000${source}\u0000${target}`;
    balances.set(key, (balances.get(key) ?? 0) + direction);
  }
  for (const [key, balance] of [...balances].sort(([left], [right]) => left.localeCompare(right))) {
    const [refKind, , target] = key.split("\u0000") as [string, string, string];
    for (let index = 0; index < Math.abs(balance); index += 1) {
      differences.push({
        kind: `${balance < 0 ? "ref-removed" : "ref-added"}:${refKind}`,
        ...(balance < 0 ? { oldTarget: target } : { newTarget: target }),
      });
    }
  }
  return differences;
}

export function assemblePostgresStructureSql(documents: readonly VirtualSqlDocument[]): string {
  return documents
    .map((document) => document.content.trim())
    .filter((content) => content.length > 0)
    .sort((left, right) => left.localeCompare(right))
    .join("\n\n")
    .concat("\n");
}

function assembleStructureDocument(documents: readonly VirtualSqlDocument[]): VirtualSqlDocument {
  return {
    uri: COMPARISON_URI,
    language: "sql",
    content: assemblePostgresStructureSql(documents),
  };
}

function sourceSet(revisionPrefix: string, document: VirtualSqlDocument): VirtualSqlSourceSet {
  const digest = createHash("sha256").update(document.content).digest("hex");
  return {
    srcset: COMPARISON_SOURCE_SET,
    revision: `${revisionPrefix}-${digest}`,
    documents: [document],
  };
}

function wholeDocumentSpan(content: string): { start: number; end: number } {
  return { start: 1, end: Math.max(1, content.split("\n").length) };
}

function structureDifference(
  change: CodeMonikerDiffImpactSymbol,
  side: "old" | "new",
): PostgresStructureDifference {
  const symbol = change[side];
  if (!symbol) {
    throw new Error(`Code Moniker ${change.kind} change has no ${side} symbol`);
  }
  return {
    identity: symbol.compact_identity || symbol.identity,
    kind: symbol.kind,
    change: change.kind,
  };
}

function referenceDifference(change: CodeMonikerDiffImpactRef): PostgresReferenceDifference {
  return {
    kind: `${change.kind}:${change.ref_kind}`,
    ...(change.old_target ? { oldTarget: change.old_target } : {}),
    ...(change.new_target ? { newTarget: change.new_target } : {}),
  };
}
