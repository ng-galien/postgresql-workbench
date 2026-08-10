export interface PostgresVisualIdentity {
  glyph: string;
  icon: string;
  color: string;
}

export interface PostgresSourcePresentationInput {
  database: string;
  schema: string;
  documentKind: string;
  name: string;
  signature: string;
  symbolKind: string;
}

export interface PostgresSourcePresentation {
  label: string;
  path: string;
  kind: string;
  object: string;
}

const POSTGRES_VISUALS: Record<string, PostgresVisualIdentity> = {
  database: { glyph: "DB", icon: "database", color: "charts.blue" },
  schema: { glyph: "S", icon: "layers", color: "charts.purple" },
  table: { glyph: "T", icon: "table", color: "charts.blue" },
  view: { glyph: "V", icon: "eye", color: "charts.cyan" },
  function: { glyph: "ƒ", icon: "bracket-dot", color: "charts.green" },
  procedure: { glyph: "P", icon: "play-circle", color: "charts.orange" },
  trigger: { glyph: "⚡", icon: "zap", color: "charts.yellow" },
  test: { glyph: "✓", icon: "beaker", color: "testing.iconPassed" },
  extension: { glyph: "E", icon: "extensions", color: "charts.purple" },
  column: { glyph: "C", icon: "symbol-field", color: "charts.blue" },
  constraint: { glyph: "K", icon: "key", color: "charts.orange" },
  source: { glyph: "SQL", icon: "file-code", color: "charts.blue" },
};

const FALLBACK_VISUAL: PostgresVisualIdentity = {
  glyph: "◇",
  icon: "symbol-field",
  color: "charts.blue",
};

export function postgresVisual(kind: string): PostgresVisualIdentity {
  return POSTGRES_VISUALS[kind] ?? FALLBACK_VISUAL;
}

/** One human-facing projection shared by editors, breadcrumbs, tests and coverage. */
export function postgresSourcePresentation(
  source: PostgresSourcePresentationInput,
): PostgresSourcePresentation {
  const kind =
    source.symbolKind === "function" || source.symbolKind === "procedure"
      ? source.symbolKind
      : source.documentKind;
  const signature = source.signature.trim();
  const object =
    signature && signature !== source.name
      ? signature.startsWith(source.name)
        ? signature
        : signature.startsWith("(")
          ? `${source.name}${signature}`
          : `${source.name}(${signature})`
      : source.name;
  const segments = [source.database, source.schema, kind, object];
  return {
    label: segments.join(" / "),
    path: segments.join("/"),
    kind,
    object,
  };
}
