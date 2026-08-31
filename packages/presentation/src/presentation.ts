import type { WorkbenchColorRole } from "./roles.js";

export interface PostgresVisualIdentity {
  glyph: string;
  icon: string;
  color: WorkbenchColorRole;
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
  displayPath: string;
  label: string;
  path: string;
  kind: string;
  object: string;
}

const POSTGRES_VISUALS: Record<string, PostgresVisualIdentity> = {
  database: { glyph: "DB", icon: "database", color: "accent-blue" },
  schema: { glyph: "S", icon: "layers", color: "accent-purple" },
  table: { glyph: "T", icon: "table", color: "accent-blue" },
  view: { glyph: "V", icon: "eye", color: "accent-cyan" },
  function: { glyph: "ƒ", icon: "bracket-dot", color: "accent-green" },
  procedure: { glyph: "P", icon: "play-circle", color: "accent-orange" },
  trigger: { glyph: "⚡", icon: "zap", color: "accent-yellow" },
  test: { glyph: "✓", icon: "beaker", color: "accent-green" },
  extension: { glyph: "E", icon: "extensions", color: "accent-purple" },
  column: { glyph: "C", icon: "symbol-field", color: "accent-blue" },
  constraint: { glyph: "K", icon: "key", color: "accent-orange" },
  source: { glyph: "SQL", icon: "file-code", color: "accent-blue" },
};

const FALLBACK_VISUAL: PostgresVisualIdentity = {
  glyph: "◇",
  icon: "symbol-field",
  color: "accent-blue",
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
    displayPath: [source.database, source.schema, kind, source.name].join("/"),
    label: segments.join(" / "),
    path: segments.join("/"),
    kind,
    object,
  };
}
