import type { PostgresDocumentDescriptor } from "./postgresCatalog.js";

export interface WorkbenchTreeSymbol {
  uri: string;
  name: string;
  kind: string;
  file: string;
  signature: string;
  line_range?: [number, number] | null;
  source?: {
    lines: Array<{ number: number; text: string }>;
  } | null;
  postgres?: PostgresDocumentDescriptor;
}

export interface WorkbenchDatabaseIdentity {
  connectionId: string;
  database: string;
}

export interface WorkbenchRoutineParam {
  name: string;
  type: string;
}

export type WorkbenchObjectKind = "table" | "view" | "function" | "procedure" | "trigger";

export interface WorkbenchObjectModel {
  symbolUri: string;
  sourceUri: string;
  connectionId: string;
  database: string;
  schema: string;
  oid: number;
  name: string;
  kind: WorkbenchObjectKind;
  signature: string;
  params: WorkbenchRoutineParam[];
  plpgsql: boolean;
}

export type WorkbenchTableMemberKind = "column" | "constraint";

export interface WorkbenchTableMemberModel {
  symbolUri: string;
  sourceUri: string;
  kind: WorkbenchTableMemberKind;
  name: string;
  type: string;
  line: number | null;
}

export interface WorkbenchSchemaModel {
  schema: string;
  objects: WorkbenchObjectModel[];
}

interface DatabaseDocumentIdentity extends WorkbenchDatabaseIdentity {
  schema: string;
  documentKind: "schema" | "table" | "view" | "routine" | "trigger";
  oid: number;
}

const OBJECT_ORDER: Record<WorkbenchObjectKind, number> = {
  table: 0,
  view: 1,
  function: 2,
  procedure: 2,
  trigger: 3,
};

export function buildWorkbenchSchemas(
  symbols: readonly WorkbenchTreeSymbol[],
  database: WorkbenchDatabaseIdentity,
): WorkbenchSchemaModel[] {
  return listWorkbenchSchemas(symbols, database).map((schema) => ({
    schema,
    objects: buildWorkbenchObjects(symbols, database, schema),
  }));
}

export function listWorkbenchSchemas(
  symbols: readonly WorkbenchTreeSymbol[],
  database: WorkbenchDatabaseIdentity,
): string[] {
  const schemas = new Set<string>();
  for (const symbol of symbols) {
    const document = symbol.postgres;
    if (!document || !matchesDatabase(document, database)) {
      continue;
    }
    if (
      (document.documentKind === "schema" && symbol.kind === "schema") ||
      topLevelObjectKind(document.documentKind, symbol.kind)
    ) {
      schemas.add(document.schema);
    }
  }
  return [...schemas].sort((left, right) => left.localeCompare(right));
}

export function buildWorkbenchObjects(
  symbols: readonly WorkbenchTreeSymbol[],
  database: WorkbenchDatabaseIdentity,
  schema?: string,
): WorkbenchObjectModel[] {
  const objects: WorkbenchObjectModel[] = [];
  for (const symbol of symbols) {
    const object = workbenchObjectFromSymbol(symbol, database);
    if (!object || (schema !== undefined && object.schema !== schema)) {
      continue;
    }
    objects.push(object);
  }
  return objects.sort(compareWorkbenchObjects);
}

export function buildWorkbenchTableMembers(
  symbols: readonly WorkbenchTreeSymbol[],
  table: WorkbenchObjectModel,
): WorkbenchTableMemberModel[] {
  if (table.kind !== "table" && table.kind !== "view") return [];
  return symbols
    .filter(
      (symbol) =>
        symbol.file === table.sourceUri &&
        (symbol.kind === "column" ||
          (symbol.kind === "constraint" && !isAnonymousConstraint(symbol.name))),
    )
    .map((symbol) => ({
      symbolUri: symbol.uri,
      sourceUri: symbol.file,
      kind: symbol.kind as WorkbenchTableMemberKind,
      name: symbol.name,
      type: symbol.signature,
      line: symbol.line_range?.[0] ?? null,
    }))
    .sort(
      (left, right) =>
        memberOrder(left.kind) - memberOrder(right.kind) ||
        (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER) ||
        left.name.localeCompare(right.name),
    );
}

export function searchWorkbenchObjects(
  symbols: readonly WorkbenchTreeSymbol[],
  database: WorkbenchDatabaseIdentity,
  query: string,
  limit = 100,
): WorkbenchObjectModel[] {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return buildWorkbenchObjects(symbols, database)
    .filter((object) => {
      const searchable = [
        object.schema,
        object.name,
        object.kind,
        object.signature,
        `${object.schema}.${object.name}`,
      ]
        .join(" ")
        .toLocaleLowerCase();
      return tokens.every((token) => searchable.includes(token));
    })
    .slice(0, Math.max(0, limit));
}

export function workbenchObjectFromSymbol(
  symbol: WorkbenchTreeSymbol,
  database: WorkbenchDatabaseIdentity,
): WorkbenchObjectModel | undefined {
  const document = symbol.postgres;
  if (!document || !matchesDatabase(document, database)) {
    return undefined;
  }
  const kind = topLevelObjectKind(document.documentKind, symbol.kind);
  if (!kind) {
    return undefined;
  }
  const name =
    kind === "function" || kind === "procedure"
      ? routineName(symbol.name, symbol.signature)
      : symbol.name;
  return {
    symbolUri: symbol.uri,
    sourceUri: symbol.file,
    connectionId: document.connectionId,
    database: document.database,
    schema: document.schema,
    oid: document.oid,
    name,
    kind,
    signature: symbol.signature,
    params:
      kind === "function" || kind === "procedure" ? parseRoutineSignature(symbol.signature) : [],
    plpgsql:
      (kind === "function" || kind === "procedure") &&
      (symbol.source?.lines.some(({ text }) => /\bLANGUAGE\s+plpgsql\b/i.test(text)) ?? false),
  };
}

export function isWorkbenchDatabaseSymbol(
  symbol: WorkbenchTreeSymbol,
  database: WorkbenchDatabaseIdentity,
): boolean {
  const document = symbol.postgres;
  return document !== undefined && matchesDatabase(document, database);
}

function matchesDatabase(
  document: DatabaseDocumentIdentity,
  database: WorkbenchDatabaseIdentity,
): boolean {
  return document.connectionId === database.connectionId && document.database === database.database;
}

function compareWorkbenchObjects(left: WorkbenchObjectModel, right: WorkbenchObjectModel): number {
  return (
    left.schema.localeCompare(right.schema) ||
    OBJECT_ORDER[left.kind] - OBJECT_ORDER[right.kind] ||
    left.name.localeCompare(right.name) ||
    left.signature.localeCompare(right.signature)
  );
}

function memberOrder(kind: WorkbenchTableMemberKind): number {
  return kind === "column" ? 0 : 1;
}

function isAnonymousConstraint(name: string): boolean {
  const offset = Number(name);
  return Number.isSafeInteger(offset) && offset >= 0 && String(offset) === name;
}

function routineName(name: string, signature: string): string {
  const suffix = `(${signature})`;
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

function topLevelObjectKind(
  documentKind: DatabaseDocumentIdentity["documentKind"],
  symbolKind: string,
): WorkbenchObjectKind | undefined {
  if (documentKind === "routine") {
    return symbolKind === "function" || symbolKind === "procedure" ? symbolKind : undefined;
  }
  if (
    documentKind !== "schema" &&
    (symbolKind === "table" || symbolKind === "view" || symbolKind === "trigger") &&
    symbolKind === documentKind
  ) {
    return symbolKind;
  }
  return undefined;
}

function parseRoutineSignature(signature: string): WorkbenchRoutineParam[] {
  return splitTopLevel(signature).map((slot, index) => {
    const separator = slot.indexOf(":");
    if (separator < 0) {
      return { name: `$${index + 1}`, type: slot.trim() };
    }
    return {
      name: slot.slice(0, separator).trim() || `$${index + 1}`,
      type: slot.slice(separator + 1).trim(),
    };
  });
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "(" || character === "[" || character === "{") {
      depth += 1;
    } else if (character === ")" || character === "]" || character === "}") {
      depth = Math.max(0, depth - 1);
    } else if (character === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) {
    parts.push(tail);
  }
  return parts;
}
