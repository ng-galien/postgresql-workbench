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
  writes: "var(--pgw-accent-orange)",
  reads: "var(--pgw-accent-blue)",
  calls: "var(--pgw-accent-green)",
  triggers: "var(--pgw-accent-yellow)",
  foreign_key: "var(--pgw-accent-purple)",
  references: "var(--pgw-accent-purple)",
  uses_type: "var(--pgw-accent-cyan)",
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
