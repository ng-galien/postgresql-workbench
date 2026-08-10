const RELATION_PRIORITY = [
  "writes",
  "reads",
  "calls",
  "triggers",
  "foreign_key",
  "references",
  "uses_type",
] as const;

const RELATION_LABELS: Record<string, string> = {
  calls: "calls",
  reads: "reads",
  writes: "writes",
  references: "references",
  uses_type: "uses type",
  triggers: "triggers",
  foreign_key: "foreign key",
};

const RELATION_COLORS: Record<string, string> = {
  writes: "var(--vscode-charts-orange)",
  reads: "var(--vscode-charts-blue)",
  calls: "var(--vscode-charts-green)",
  triggers: "var(--vscode-charts-yellow)",
  foreign_key: "var(--vscode-charts-purple)",
  references: "var(--vscode-charts-purple)",
  uses_type: "var(--vscode-charts-cyan)",
};

export function primaryRelationKind(kinds: readonly string[]): string {
  return RELATION_PRIORITY.find((kind) => kinds.includes(kind)) ?? kinds[0] ?? "relation";
}

export function relationClass(kind: string): string {
  return `relation-${kind.replaceAll("_", "-")}`;
}

export function relationLabel(kind: string): string {
  return RELATION_LABELS[kind] ?? kind.replaceAll("_", " ");
}

export function relationColor(kind: string): string {
  return RELATION_COLORS[kind] ?? "var(--pg-accent)";
}
