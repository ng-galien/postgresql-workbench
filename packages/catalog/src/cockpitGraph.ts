import type { NamedSqlToken } from "../../sql/src/languageServer/protocol.js";
import type {
  CodeMonikerGraphResult,
  CodeMonikerIdentityGraphResult,
  CodeMonikerSymbol,
} from "./localCodeMoniker.js";
import {
  buildWorkbenchObjects,
  buildWorkbenchTableMembers,
  type WorkbenchDatabaseIdentity,
  type WorkbenchObjectModel,
  workbenchObjectFromSymbol,
} from "./objectModel.js";
import { buildWorkbenchRelationGroups } from "./relations.js";

/**
 * The graph the Cockpit renders, as the catalog produces it: a focused symbol, who calls it and
 * what it calls, and the labels a reader needs to recognise them.
 */
export type CockpitDirection = "incoming" | "outgoing";

export interface WorkbenchGraphIdentityPresentation {
  label: string;
  kind: string;
  origin?: string;
  hasCockpitActions?: boolean;
}

export interface WorkbenchGraphBreadcrumb {
  prefix: string;
  label: string;
}

export interface CockpitNeighbor {
  direction: CockpitDirection;
  symbol: CodeMonikerSymbol;
  count: number;
  kinds: string[];
  score: number;
}

export interface CockpitNeighborhood {
  focus: CodeMonikerSymbol;
  incoming: CockpitNeighbor[];
  outgoing: CockpitNeighbor[];
  totals: { incoming: number; outgoing: number };
  unresolved: number;
  limited: boolean;
}

export interface WorkbenchGraphSearchResult {
  symbolUri: string;
  label: string;
  schema: string;
  kind: string;
  detail: string;
  resultType: "schema" | "object" | "member";
  incoming?: number;
  outgoing?: number;
  countStatus: "loading" | "available" | "unavailable";
}

export interface WorkbenchGraphSourcePreview {
  symbolUri: string;
  title: string;
  kind: string;
  file: string;
  firstLine: number;
  lastLine: number;
  lines: Array<{ number: number; text: string }>;
  /**
   * What the SQL authoring server made of this source, when the host asked it: each piece and each
   * name, kinds named against the server's legend. The view paints these and computes nothing —
   * the same single path every other SQL surface reads its colours through.
   */
  tokens?: NamedSqlToken[];
}

export const COCKPIT_BATCH_SIZE = 3;
export const COCKPIT_DOM_BUDGET = 60;
export const COCKPIT_RELATIONS = ["calls", "reads", "writes", "references", "uses_type"];

export type CockpitTarget =
  | { kind: "object"; symbol: CodeMonikerSymbol; object: WorkbenchObjectModel }
  | { kind: "landing"; schemaHint?: string };

export function resolveCockpitTarget(
  prefix: string,
  symbols: readonly CodeMonikerSymbol[],
  database: WorkbenchDatabaseIdentity,
): CockpitTarget {
  const symbol = symbols.find((candidate) => candidate.uri === prefix);
  const object = symbol ? workbenchObjectFromSymbol(symbol, database) : undefined;
  if (symbol && object) return { kind: "object", symbol, object };
  const schemaHint =
    symbol?.postgres?.documentKind === "schema" ? symbol.postgres.schema : undefined;
  return { kind: "landing", schemaHint };
}

export function databaseLandingIdentity(
  symbols: readonly CodeMonikerSymbol[],
  database: WorkbenchDatabaseIdentity,
): string | undefined {
  return symbols.find(
    (symbol) =>
      symbol.postgres?.connectionId === database.connectionId &&
      symbol.postgres.database === database.database &&
      symbol.postgres.documentKind === "schema",
  )?.uri;
}

export function schemaLandingIdentity(
  symbols: readonly CodeMonikerSymbol[],
  database: WorkbenchDatabaseIdentity,
  schema: string,
): string | undefined {
  return symbols.find(
    (symbol) =>
      symbol.postgres?.connectionId === database.connectionId &&
      symbol.postgres.database === database.database &&
      symbol.postgres.schema === schema &&
      symbol.postgres.documentKind === "schema",
  )?.uri;
}

export function neighborhoodFromGraph(
  source: CodeMonikerGraphResult,
  database?: WorkbenchDatabaseIdentity,
  indexedSymbols: readonly CodeMonikerSymbol[] = [],
): CockpitNeighborhood {
  const focus = source.focus.symbol;
  if (!focus) throw new Error("Code Moniker returned a dependency result without a focus symbol.");
  const incoming = database
    ? objectNeighbors(source, "incoming", database, indexedSymbols)
    : rankNeighbors(source.callers, "incoming");
  const outgoing = database
    ? objectNeighbors(source, "outgoing", database, indexedSymbols)
    : rankNeighbors(source.callees, "outgoing");
  return {
    focus,
    incoming,
    outgoing,
    totals: {
      incoming: database ? incoming.length : source.coverage.callers.matching,
      outgoing: database ? outgoing.length : source.coverage.callees.matching,
    },
    unresolved: Number(source.unlinked.unresolved ?? 0),
    limited:
      source.coverage.callers.returned < source.coverage.callers.matching ||
      source.coverage.callees.returned < source.coverage.callees.matching,
  };
}

function objectNeighbors(
  source: CodeMonikerGraphResult,
  direction: CockpitNeighbor["direction"],
  database: WorkbenchDatabaseIdentity,
  indexedSymbols: readonly CodeMonikerSymbol[],
): CockpitNeighbor[] {
  const canonicalSymbols = new Map(indexedSymbols.map((symbol) => [symbol.uri, symbol]));
  const merged = new Map<string, { symbol: CodeMonikerSymbol; count: number; kinds: string[] }>();
  for (const group of buildWorkbenchRelationGroups(source, database, indexedSymbols)) {
    if (group.direction !== direction) continue;
    for (const target of group.targets) {
      const symbol = target.object
        ? (canonicalSymbols.get(target.object.symbolUri) ?? target.symbol)
        : target.symbol;
      const current = merged.get(symbol.uri);
      merged.set(symbol.uri, {
        symbol,
        count: (current?.count ?? 0) + target.count,
        kinds: [...new Set([...(current?.kinds ?? []), group.relation])],
      });
    }
  }
  return rankNeighbors([...merged.values()], direction);
}

function rankNeighbors(
  neighbors: CodeMonikerGraphResult["callers"],
  direction: CockpitNeighbor["direction"],
): CockpitNeighbor[] {
  return neighbors
    .map((neighbor) => ({
      ...neighbor,
      direction,
      score: doiScore(neighbor.count, neighbor.kinds, neighbor.symbol.kind),
    }))
    .sort(
      (left, right) =>
        right.score - left.score || left.symbol.name.localeCompare(right.symbol.name),
    );
}

function doiScore(count: number, kinds: readonly string[], kind: string): number {
  const weights: Record<string, number> = {
    writes: 8,
    calls: 7,
    reads: 6,
    references: 4,
    uses_type: 2,
  };
  const relationWeight = Math.max(1, ...kinds.map((relation) => weights[relation] ?? 1));
  const kindWeight = kind === "trigger" ? 2 : kind === "table" || kind === "view" ? 1.5 : 1;
  return Math.log2(Math.max(1, count) + 1) * 3 + relationWeight + kindWeight;
}

export function initialCockpitGraph(
  neighborhood: CockpitNeighborhood,
  batchSize = COCKPIT_BATCH_SIZE,
): CodeMonikerIdentityGraphResult {
  const neighbors = [
    ...neighborhood.incoming.slice(0, batchSize),
    ...neighborhood.outgoing.slice(0, batchSize),
  ];
  const symbols = new Map<string, CodeMonikerSymbol>([
    [neighborhood.focus.uri, neighborhood.focus],
  ]);
  for (const neighbor of neighbors) symbols.set(neighbor.symbol.uri, neighbor.symbol);
  const edges = neighbors.map((neighbor) => ({
    source: neighbor.direction === "incoming" ? neighbor.symbol.uri : neighborhood.focus.uri,
    target: neighbor.direction === "incoming" ? neighborhood.focus.uri : neighbor.symbol.uri,
    count: neighbor.count,
    kinds: neighbor.kinds,
  }));
  const nodes = [...symbols.values()].map((symbol) => ({
    defs: 1,
    has_children: false,
    identity: symbol.uri,
    kind: symbol.kind,
    name: symbol.name,
    segment: symbol.name,
    symbol,
  }));
  return {
    prefix: neighborhood.focus.uri,
    path: [],
    min_count: 1,
    nodes,
    edges,
    ports_in: [],
    ports_out: [],
    coverage: {
      nodes_emitted: nodes.length,
      nodes_total: 1 + neighborhood.totals.incoming + neighborhood.totals.outgoing,
      edges_emitted: edges.length,
      edges_matching: neighborhood.totals.incoming + neighborhood.totals.outgoing,
      edges_total: neighborhood.totals.incoming + neighborhood.totals.outgoing,
      ports_in_emitted: 0,
      ports_in_matching: Math.max(0, neighborhood.totals.incoming - batchSize),
      ports_in_total: neighborhood.totals.incoming,
      ports_out_emitted: 0,
      ports_out_matching: Math.max(0, neighborhood.totals.outgoing - batchSize),
      ports_out_total: neighborhood.totals.outgoing,
      rows_emitted: nodes.length + edges.length,
      rows_matching: nodes.length + edges.length,
      rows_total: nodes.length + neighborhood.totals.incoming + neighborhood.totals.outgoing,
    },
    unlinked: { external: 0, manifest_blocked: 0, unresolved: neighborhood.unresolved },
  };
}

export function presentationsForSymbols(
  symbols: readonly CodeMonikerSymbol[],
  database: WorkbenchDatabaseIdentity,
  originFor: (sourceUri: string) => { kind: string; extension?: string } | undefined,
): Record<string, WorkbenchGraphIdentityPresentation> {
  return Object.fromEntries(
    symbols.map((symbol) => {
      const object = workbenchObjectFromSymbol(symbol, database);
      const origin = object ? originFor(object.sourceUri) : undefined;
      return [
        symbol.uri,
        object
          ? {
              label: objectLabel(object),
              kind: object.kind,
              origin: origin?.kind === "extension" ? origin.extension : undefined,
              hasCockpitActions:
                object.plpgsql && (object.kind === "function" || object.kind === "procedure"),
            }
          : { label: symbol.name, kind: symbol.kind },
      ];
    }),
  );
}

export function cockpitBreadcrumbs(
  symbol: CodeMonikerSymbol | undefined,
  database: WorkbenchDatabaseIdentity,
  symbols: readonly CodeMonikerSymbol[],
): WorkbenchGraphBreadcrumb[] {
  const databasePrefix = databaseLandingIdentity(symbols, database) ?? symbol?.uri;
  if (!databasePrefix) return [];
  const steps: WorkbenchGraphBreadcrumb[] = [{ prefix: databasePrefix, label: database.database }];
  if (!symbol) return steps;
  const object = workbenchObjectFromSymbol(symbol, database);
  if (!object) return steps;
  const schemaPrefix = schemaLandingIdentity(symbols, database, object.schema) ?? symbol.uri;
  steps.push({ prefix: schemaPrefix, label: object.schema });
  steps.push({ prefix: symbol.uri, label: objectLabel(object) });
  return steps;
}

export function searchGraphObjects(
  symbols: readonly CodeMonikerSymbol[],
  database: WorkbenchDatabaseIdentity,
  query: string,
  originFor: (sourceUri: string) => { kind: string; extension?: string } | undefined,
  limit = 40,
): WorkbenchGraphSearchResult[] {
  const normalized = query.trim();
  if (!normalized) return [];
  const parsed = parseGraphSearchQuery(normalized);
  const objects = buildWorkbenchObjects(symbols, database).filter(
    (object) => originFor(object.sourceUri)?.kind !== "extension",
  );
  const schemaResults = parsed.explicitSchema
    ? []
    : [...new Set(objects.map((object) => object.schema))]
        .filter(
          (schema) =>
            parsed.terms.length === 1 && schema.toLocaleLowerCase().includes(parsed.terms[0]),
        )
        .sort()
        .map((schema): WorkbenchGraphSearchResult => {
          const schemaObjects = objects.filter((object) => object.schema === schema);
          const schemaIdentity = schemaLandingIdentity(symbols, database, schema);
          return {
            symbolUri: schemaIdentity ?? schemaObjects[0]?.symbolUri ?? "",
            label: schema,
            schema,
            kind: "schema",
            detail: `${schemaObjects.length} objects · filter this schema`,
            resultType: "schema",
            countStatus: "available",
          };
        });
  const matchingObjects = objects
    .filter((object) => matchesObjectSearch(object, parsed))
    .sort(
      (left, right) =>
        searchObjectRank(right, parsed) - searchObjectRank(left, parsed) ||
        objectLabel(left).localeCompare(objectLabel(right)),
    );
  const objectResults = matchingObjects.map(
    (object): WorkbenchGraphSearchResult => ({
      symbolUri: object.symbolUri,
      label: objectLabel(object),
      schema: object.schema,
      kind: object.kind,
      detail:
        object.kind === "function" || object.kind === "procedure" ? object.signature : object.kind,
      resultType: "object",
      countStatus: "loading",
    }),
  );
  const memberResults = objects.flatMap((object): WorkbenchGraphSearchResult[] => {
    if (object.kind !== "table" && object.kind !== "view") return [];
    if (!matchesSchema(object.schema, parsed.schemas)) return [];
    if (
      parsed.kinds.length > 0 &&
      !parsed.kinds.some((kind) => kind === "column" || kind === "constraint")
    ) {
      return [];
    }
    return buildWorkbenchTableMembers(symbols, object).flatMap((member) => {
      const searchable = [
        object.schema,
        object.name,
        member.name,
        member.kind,
        member.type,
        `${object.schema}.${object.name}.${member.name}`,
      ]
        .join(" ")
        .toLocaleLowerCase();
      if (!parsed.terms.every((token) => searchable.includes(token))) return [];
      if (!parsed.names.every((token) => searchable.includes(token))) return [];
      if (parsed.kinds.length > 0 && !parsed.kinds.includes(member.kind)) return [];
      return [
        {
          symbolUri: object.symbolUri,
          label: `${object.name}.${member.name}`,
          schema: object.schema,
          kind: member.kind,
          detail: [object.kind, member.type].filter(Boolean).join(" · "),
          resultType: "member",
          countStatus: "loading",
        },
      ];
    });
  });
  return [...schemaResults, ...objectResults, ...memberResults].slice(0, Math.max(0, limit));
}

interface ParsedGraphSearchQuery {
  terms: string[];
  schemas: string[];
  kinds: string[];
  names: string[];
  explicitSchema: boolean;
}

function parseGraphSearchQuery(query: string): ParsedGraphSearchQuery {
  const parsed: ParsedGraphSearchQuery = {
    terms: [],
    schemas: [],
    kinds: [],
    names: [],
    explicitSchema: false,
  };
  for (const raw of query.toLocaleLowerCase().split(/\s+/).filter(Boolean)) {
    if (raw.startsWith("#")) {
      parsed.explicitSchema = true;
      if (raw.length > 1) parsed.schemas.push(...splitSearchValues(raw.slice(1)));
      continue;
    }
    if (raw.startsWith("@")) {
      if (raw.length > 1) parsed.kinds.push(...splitSearchKinds(raw.slice(1)));
      continue;
    }
    const separator = raw.indexOf(":");
    if (separator < 1) {
      parsed.terms.push(raw);
      continue;
    }
    const key = raw.slice(0, separator);
    const value = raw.slice(separator + 1);
    if (!value) continue;
    if (key === "schema") {
      parsed.explicitSchema = true;
      parsed.schemas.push(...splitSearchValues(value));
    } else if (key === "type" || key === "kind") {
      parsed.kinds.push(...splitSearchKinds(value));
    } else if (key === "name") {
      parsed.names.push(...splitSearchValues(value));
    } else if (
      ["table", "view", "function", "procedure", "trigger", "column", "constraint"].includes(key)
    ) {
      parsed.kinds.push(key);
      parsed.names.push(value);
    } else {
      parsed.terms.push(raw);
    }
  }
  return parsed;
}

function splitSearchValues(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function splitSearchKinds(value: string): string[] {
  return splitSearchValues(value).flatMap((kind) =>
    kind === "routine" || kind === "routines"
      ? ["function", "procedure"]
      : [kind.replace(/s$/, "")],
  );
}

function matchesObjectSearch(
  object: WorkbenchObjectModel,
  parsed: ParsedGraphSearchQuery,
): boolean {
  if (!matchesSchema(object.schema, parsed.schemas)) return false;
  if (parsed.kinds.length > 0 && !parsed.kinds.includes(object.kind)) return false;
  const searchable = [
    object.schema,
    object.name,
    object.kind,
    object.signature,
    `${object.schema}.${object.name}`,
  ]
    .join(" ")
    .toLocaleLowerCase();
  return (
    parsed.terms.every((token) => searchable.includes(token)) &&
    parsed.names.every((token) => searchable.includes(token))
  );
}

function matchesSchema(schema: string, filters: readonly string[]): boolean {
  const normalized = schema.toLocaleLowerCase();
  return filters.length === 0 || filters.some((filter) => normalized.includes(filter));
}

function searchObjectRank(object: WorkbenchObjectModel, parsed: ParsedGraphSearchQuery): number {
  const name = object.name.toLocaleLowerCase();
  const qualified = `${object.schema}.${object.name}`.toLocaleLowerCase();
  const terms = [...parsed.names, ...parsed.terms];
  return terms.reduce(
    (score, token) =>
      score + (name === token || qualified === token ? 8 : name.startsWith(token) ? 4 : 1),
    0,
  );
}

export function sourcePreviewPresentation(source: {
  symbol: CodeMonikerSymbol;
  source: NonNullable<CodeMonikerSymbol["source"]>;
}): WorkbenchGraphSourcePreview {
  return {
    symbolUri: source.symbol.uri,
    title: source.symbol.name,
    kind: source.symbol.kind,
    file: source.source.file,
    firstLine: source.source.first_line,
    lastLine: source.source.lines.at(-1)?.number ?? source.source.last_line,
    lines: source.source.lines,
  };
}

export function objectLabel(object: WorkbenchObjectModel): string {
  return object.kind === "function" || object.kind === "procedure"
    ? `${object.name}(${object.params.map((parameter) => parameter.type).join(", ")})`
    : object.name;
}
