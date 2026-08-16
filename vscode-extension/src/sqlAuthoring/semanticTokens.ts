import { SemanticTokensBuilder } from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";
import {
  canonicalSqlIdentifier,
  POSTGRES_IDENTIFIER_PATTERN,
  splitSqlQualifiedIdentifier,
  sqlAliasAfterRelation,
} from "./identifiers.js";
import type { SqlAuthoringObject, SqlAuthoringSnapshot } from "./protocol.js";
import { scanPostgresSql } from "./sqlLexing.js";

export const SQL_SEMANTIC_TOKEN_TYPES = [
  "variable",
  "parameter",
  "type",
  "function",
  "sqlSchema",
  "sqlTable",
  "sqlView",
  "sqlCte",
  "sqlAlias",
  "sqlColumn",
  "sqlFunction",
  "sqlProcedure",
  "sqlParameter",
  "sqlType",
  "sqlWindow",
] as const;

type SqlSemanticTokenType = (typeof SQL_SEMANTIC_TOKEN_TYPES)[number];

interface Token {
  length: number;
  offset: number;
  type: SqlSemanticTokenType;
}

interface RelationReference {
  alias?: string;
  aliasOffset?: number;
  cte?: string;
  object?: SqlAuthoringObject;
  reference: string;
  referenceOffset: number;
}

interface NamedSymbol {
  name: string;
  offset: number;
}

const IDENTIFIER = POSTGRES_IDENTIFIER_PATTERN;
const QUALIFIED_IDENTIFIER = String.raw`(?:${IDENTIFIER})(?:\s*\.\s*(?:${IDENTIFIER}))?`;
const STRUCTURAL_CALL_NAMES = new Set([
  "all",
  "any",
  "array",
  "as",
  "case",
  "call",
  "cast",
  "collate",
  "distinct",
  "delete",
  "else",
  "end",
  "exists",
  "fetch",
  "filter",
  "for",
  "from",
  "group",
  "having",
  "in",
  "insert",
  "into",
  "join",
  "lateral",
  "limit",
  "offset",
  "on",
  "order",
  "over",
  "partition",
  "row",
  "select",
  "set",
  "table",
  "tablesample",
  "then",
  "union",
  "update",
  "using",
  "values",
  "when",
  "where",
  "window",
  "with",
]);
const UNQUALIFIED_COLUMN_EXCLUSIONS = new Set([
  ...STRUCTURAL_CALL_NAMES,
  "and",
  "asc",
  "by",
  "cross",
  "desc",
  "false",
  "full",
  "inner",
  "interval",
  "is",
  "left",
  "natural",
  "not",
  "null",
  "or",
  "outer",
  "recursive",
  "right",
  "true",
  "merge",
]);

export function postgresSemanticTokens(document: TextDocument, snapshot: SqlAuthoringSnapshot) {
  const source = document.getText();
  const maskedSource = scanPostgresSql(source).maskedSource;
  const tokens: Token[] = [];
  const occupied = new Set<string>();
  const ctes = cteDeclarations(source, maskedSource);
  const windows = windowSymbols(source, maskedSource);
  const references = relationReferences(source, maskedSource, snapshot.objects, ctes);

  addCteTokens(tokens, occupied, ctes);
  addWindowTokens(tokens, occupied, windows);
  addRelationTokens(tokens, occupied, references);
  addRoutineTokens(tokens, occupied, source, maskedSource, snapshot.objects);
  addParameterTokens(tokens, occupied, maskedSource);
  addTypeTokens(tokens, occupied, source, maskedSource);
  addQualifiedTokens(tokens, occupied, source, maskedSource, snapshot.objects, references);
  addUnqualifiedColumnTokens(tokens, occupied, source, maskedSource, references);

  tokens.sort((left, right) => left.offset - right.offset);
  const builder = new SemanticTokensBuilder();
  for (const token of tokens) {
    const position = document.positionAt(token.offset);
    builder.push(
      position.line,
      position.character,
      token.length,
      SQL_SEMANTIC_TOKEN_TYPES.indexOf(token.type),
      0,
    );
  }
  return builder.build();
}

function addCteTokens(tokens: Token[], occupied: Set<string>, ctes: readonly NamedSymbol[]): void {
  for (const cte of ctes) addToken(tokens, occupied, cte.offset, cte.name.length, "sqlCte");
}

function addWindowTokens(
  tokens: Token[],
  occupied: Set<string>,
  windows: { declarations: NamedSymbol[]; references: NamedSymbol[] },
): void {
  for (const window of [...windows.declarations, ...windows.references]) {
    addToken(tokens, occupied, window.offset, window.name.length, "sqlWindow");
  }
}

function addRelationTokens(
  tokens: Token[],
  occupied: Set<string>,
  references: readonly RelationReference[],
): void {
  for (const reference of references) {
    if (reference.cte) {
      addToken(tokens, occupied, reference.referenceOffset, reference.reference.length, "sqlCte");
    } else if (reference.object) {
      addObjectReferenceTokens(tokens, occupied, reference);
    }
    if (reference.alias && reference.aliasOffset !== undefined) {
      addToken(tokens, occupied, reference.aliasOffset, reference.alias.length, "sqlAlias");
    }
  }
}

function addObjectReferenceTokens(
  tokens: Token[],
  occupied: Set<string>,
  reference: RelationReference,
): void {
  if (!reference.object) return;
  const parts = qualifiedIdentifierParts(reference.reference, reference.referenceOffset);
  if (parts.length === 2) {
    addToken(tokens, occupied, parts[0].offset, parts[0].source.length, "sqlSchema");
  }
  const objectPart = parts.at(-1);
  if (!objectPart) return;
  addToken(
    tokens,
    occupied,
    objectPart.offset,
    objectPart.source.length,
    objectTokenType(reference.object),
  );
}

function addRoutineTokens(
  tokens: Token[],
  occupied: Set<string>,
  source: string,
  maskedSource: string,
  objects: readonly SqlAuthoringObject[],
): void {
  const pattern = new RegExp(String.raw`(${QUALIFIED_IDENTIFIER})\s*(?=\()`, "gu");
  for (const match of maskedSource.matchAll(pattern)) {
    const offset = (match.index ?? 0) + match[0].indexOf(match[1]);
    const reference = source.slice(offset, offset + match[1].length);
    const parts = qualifiedIdentifierParts(reference, offset);
    const namePart = parts.at(-1);
    if (!namePart) continue;
    const name = canonicalSqlIdentifier(namePart.source);
    const before = maskedSource.slice(Math.max(0, offset - 32), offset);
    const called = /\bCALL\s*$/iu.test(before);
    const object = routineObject(parts, objects, called);
    if (!object && STRUCTURAL_CALL_NAMES.has(name)) continue;
    if (parts.length === 2) {
      addToken(tokens, occupied, parts[0].offset, parts[0].source.length, "sqlSchema");
    }
    addToken(
      tokens,
      occupied,
      namePart.offset,
      namePart.source.length,
      object?.kind === "procedure" || called ? "sqlProcedure" : "sqlFunction",
    );
  }
}

function addParameterTokens(tokens: Token[], occupied: Set<string>, maskedSource: string): void {
  for (const match of maskedSource.matchAll(/\$[1-9]\d*/gu)) {
    addToken(tokens, occupied, match.index ?? 0, match[0].length, "sqlParameter");
  }
  const namedArgument = new RegExp(String.raw`(${IDENTIFIER})\s*=>`, "gu");
  for (const match of maskedSource.matchAll(namedArgument)) {
    const offset = (match.index ?? 0) + match[0].indexOf(match[1]);
    addToken(tokens, occupied, offset, match[1].length, "sqlParameter");
  }
}

function addTypeTokens(
  tokens: Token[],
  occupied: Set<string>,
  source: string,
  maskedSource: string,
): void {
  const castPattern = new RegExp(String.raw`::\s*(${QUALIFIED_IDENTIFIER})`, "gu");
  for (const match of maskedSource.matchAll(castPattern)) {
    addQualifiedType(tokens, occupied, source, match, 1);
  }
  const returnsPattern = new RegExp(String.raw`\bRETURNS\s+(${QUALIFIED_IDENTIFIER})`, "giu");
  for (const match of maskedSource.matchAll(returnsPattern)) {
    addQualifiedType(tokens, occupied, source, match, 1);
  }
  const castFunctionPattern = new RegExp(
    String.raw`\bCAST\s*\([\s\S]*?\bAS\s+(${QUALIFIED_IDENTIFIER})(?:\s*\([^)]*\))?\s*\)`,
    "giu",
  );
  for (const match of maskedSource.matchAll(castFunctionPattern)) {
    addQualifiedType(tokens, occupied, source, match, 1);
  }
}

function addQualifiedType(
  tokens: Token[],
  occupied: Set<string>,
  source: string,
  match: RegExpMatchArray,
  group: number,
): void {
  const offset = (match.index ?? 0) + match[0].lastIndexOf(match[group]);
  const reference = source.slice(offset, offset + match[group].length);
  const parts = qualifiedIdentifierParts(reference, offset);
  if (parts.length === 2) {
    addToken(tokens, occupied, parts[0].offset, parts[0].source.length, "sqlSchema");
  }
  const type = parts.at(-1);
  if (type) addToken(tokens, occupied, type.offset, type.source.length, "sqlType");
}

function addQualifiedTokens(
  tokens: Token[],
  occupied: Set<string>,
  source: string,
  maskedSource: string,
  objects: readonly SqlAuthoringObject[],
  references: readonly RelationReference[],
): void {
  const aliases = new Map<string, RelationReference>();
  for (const reference of references) {
    const qualifier = reference.alias ?? reference.object?.name ?? reference.cte;
    if (qualifier) aliases.set(canonicalSqlIdentifier(qualifier), reference);
  }

  const qualifiedPattern = new RegExp(String.raw`(${IDENTIFIER})\s*\.\s*(${IDENTIFIER})`, "gu");
  for (const match of maskedSource.matchAll(qualifiedPattern)) {
    const matchOffset = match.index ?? 0;
    const leftOffset = matchOffset + match[0].indexOf(match[1]);
    const rightOffset = matchOffset + match[0].lastIndexOf(match[2]);
    const leftSource = source.slice(leftOffset, leftOffset + match[1].length);
    const rightSource = source.slice(rightOffset, rightOffset + match[2].length);
    const left = canonicalSqlIdentifier(leftSource);
    const right = canonicalSqlIdentifier(rightSource);
    const reference = aliases.get(left);
    if (
      reference &&
      (reference.cte || reference.object?.columns.some((column) => column.name === right))
    ) {
      addToken(tokens, occupied, leftOffset, match[1].length, "sqlAlias");
      addToken(tokens, occupied, rightOffset, match[2].length, "sqlColumn");
      continue;
    }
    const candidates = objects.filter((object) => object.schema === left && object.name === right);
    const object = uniqueSemanticObject(candidates);
    if (!object) continue;
    addToken(tokens, occupied, leftOffset, match[1].length, "sqlSchema");
    addToken(tokens, occupied, rightOffset, match[2].length, objectTokenType(object));
  }
}

function addUnqualifiedColumnTokens(
  tokens: Token[],
  occupied: Set<string>,
  source: string,
  maskedSource: string,
  references: readonly RelationReference[],
): void {
  const objects = references.flatMap((reference) => (reference.object ? [reference.object] : []));
  const pattern = new RegExp(IDENTIFIER, "gu");
  for (const match of maskedSource.matchAll(pattern)) {
    const offset = match.index ?? 0;
    if (isOccupied(occupied, offset, match[0].length)) continue;
    const sourceIdentifier = source.slice(offset, offset + match[0].length);
    const name = canonicalSqlIdentifier(sourceIdentifier);
    if (UNQUALIFIED_COLUMN_EXCLUSIONS.has(name)) continue;
    const owners = new Set(
      objects.filter((object) => object.columns.some((column) => column.name === name)).map(keyFor),
    );
    if (owners.size === 1) {
      addToken(tokens, occupied, offset, match[0].length, "sqlColumn");
    }
  }
}

function relationReferences(
  source: string,
  maskedSource: string,
  objects: readonly SqlAuthoringObject[],
  ctes: readonly NamedSymbol[],
): RelationReference[] {
  const references: RelationReference[] = [];
  const cteNames = new Set(ctes.map((cte) => canonicalSqlIdentifier(cte.name)));
  const pattern = new RegExp(
    String.raw`\b(?:FROM|INTO|UPDATE|USING|(?:NATURAL\s+)?(?:(?:LEFT|RIGHT|FULL)(?:\s+OUTER)?\s+|(?:INNER|CROSS)\s+)?JOIN)\s+(${QUALIFIED_IDENTIFIER})`,
    "giu",
  );
  for (const match of maskedSource.matchAll(pattern)) {
    const referenceOffset = (match.index ?? 0) + match[0].indexOf(match[1]);
    const reference = source.slice(referenceOffset, referenceOffset + match[1].length);
    const parts = splitSqlQualifiedIdentifier(reference).map(canonicalSqlIdentifier);
    const object = resolveRelationObject(parts, objects);
    const cte = parts.length === 1 && cteNames.has(parts[0]) ? parts[0] : undefined;
    if (!object && !cte) continue;
    const relationEnd = referenceOffset + match[1].length;
    const alias = sqlAliasAfterRelation(source, maskedSource, relationEnd);
    const aliasMatch = new RegExp(
      String.raw`^\s+(?:AS\s+)?(${POSTGRES_IDENTIFIER_PATTERN})`,
      "iu",
    ).exec(maskedSource.slice(relationEnd));
    references.push({
      alias,
      aliasOffset:
        alias === undefined || aliasMatch === null
          ? undefined
          : relationEnd + aliasMatch[0].lastIndexOf(aliasMatch[1]),
      cte,
      object,
      reference,
      referenceOffset,
    });
  }
  return references;
}

function cteDeclarations(source: string, maskedSource: string): NamedSymbol[] {
  const declarations: NamedSymbol[] = [];
  const withPattern = /\bWITH\b\s*(?:RECURSIVE\b\s*)?/giu;
  for (const withMatch of maskedSource.matchAll(withPattern)) {
    let cursor = (withMatch.index ?? 0) + withMatch[0].length;
    while (cursor < maskedSource.length) {
      const declaration = new RegExp(
        String.raw`^\s*(${IDENTIFIER})(?:\s*\([^)]*\))?\s+AS\s+(?:(?:NOT\s+)?MATERIALIZED\s+)?\(`,
        "iu",
      ).exec(maskedSource.slice(cursor));
      if (!declaration) break;
      const nameOffset = cursor + declaration[0].indexOf(declaration[1]);
      declarations.push({
        name: source.slice(nameOffset, nameOffset + declaration[1].length),
        offset: nameOffset,
      });
      const openOffset = cursor + declaration[0].lastIndexOf("(");
      const closeOffset = matchingParenthesis(maskedSource, openOffset);
      if (closeOffset === undefined) break;
      const comma = /^\s*,/u.exec(maskedSource.slice(closeOffset + 1));
      if (!comma) break;
      cursor = closeOffset + 1 + comma[0].length;
    }
  }
  return declarations;
}

function windowSymbols(
  source: string,
  maskedSource: string,
): { declarations: NamedSymbol[]; references: NamedSymbol[] } {
  const declarations = namedMatches(
    source,
    maskedSource,
    new RegExp(String.raw`\bWINDOW\s+(${IDENTIFIER})\s+AS\s*\(`, "giu"),
  );
  const references = namedMatches(
    source,
    maskedSource,
    new RegExp(String.raw`\bOVER\s+(${IDENTIFIER})(?!\s*\.)`, "giu"),
  );
  return { declarations, references };
}

function namedMatches(source: string, maskedSource: string, pattern: RegExp): NamedSymbol[] {
  const symbols: NamedSymbol[] = [];
  for (const match of maskedSource.matchAll(pattern)) {
    const offset = (match.index ?? 0) + match[0].indexOf(match[1]);
    symbols.push({ name: source.slice(offset, offset + match[1].length), offset });
  }
  return symbols;
}

function matchingParenthesis(source: string, openOffset: number): number | undefined {
  let depth = 0;
  for (let offset = openOffset; offset < source.length; offset += 1) {
    if (source[offset] === "(") depth += 1;
    if (source[offset] === ")") depth -= 1;
    if (depth === 0) return offset;
  }
  return undefined;
}

function resolveRelationObject(
  parts: string[],
  objects: readonly SqlAuthoringObject[],
): SqlAuthoringObject | undefined {
  if (parts.length === 2) {
    return uniqueSemanticObject(
      objects.filter(
        (object) =>
          object.schema === parts[0] &&
          object.name === parts[1] &&
          (object.kind === "table" || object.kind === "view"),
      ),
    );
  }
  if (parts.length !== 1) return undefined;
  return uniqueSemanticObject(
    objects.filter(
      (object) => object.name === parts[0] && (object.kind === "table" || object.kind === "view"),
    ),
  );
}

function routineObject(
  parts: Array<{ source: string }>,
  objects: readonly SqlAuthoringObject[],
  called: boolean,
): SqlAuthoringObject | undefined {
  const names = parts.map((part) => canonicalSqlIdentifier(part.source));
  const candidates = objects.filter(
    (object) =>
      (object.kind === "function" || object.kind === "procedure") &&
      object.name === names.at(-1) &&
      (names.length === 1 || object.schema === names[0]) &&
      (!called || object.kind === "procedure"),
  );
  return uniqueSemanticObject(candidates);
}

function uniqueSemanticObject(
  candidates: readonly SqlAuthoringObject[],
): SqlAuthoringObject | undefined {
  if (candidates.length === 0) return undefined;
  const identities = new Set(candidates.map(keyFor));
  return identities.size === 1 ? candidates[0] : undefined;
}

function keyFor(object: SqlAuthoringObject): string {
  return `${object.kind}:${object.schema}:${object.oid}`;
}

function objectTokenType(object: SqlAuthoringObject): SqlSemanticTokenType {
  switch (object.kind) {
    case "table":
      return "sqlTable";
    case "view":
      return "sqlView";
    case "function":
      return "sqlFunction";
    case "procedure":
      return "sqlProcedure";
  }
}

function qualifiedIdentifierParts(
  reference: string,
  referenceOffset: number,
): Array<{ offset: number; source: string }> {
  const sourceParts = splitSqlQualifiedIdentifier(reference);
  const parts: Array<{ offset: number; source: string }> = [];
  let cursor = 0;
  for (const source of sourceParts) {
    const relativeOffset = reference.indexOf(source, cursor);
    parts.push({ offset: referenceOffset + relativeOffset, source });
    cursor = relativeOffset + source.length;
  }
  return parts;
}

function isOccupied(occupied: Set<string>, offset: number, length: number): boolean {
  return occupied.has(`${offset}:${length}`);
}

function addToken(
  tokens: Token[],
  occupied: Set<string>,
  offset: number,
  length: number,
  type: SqlSemanticTokenType,
): void {
  const key = `${offset}:${length}`;
  if (length <= 0 || occupied.has(key)) return;
  occupied.add(key);
  tokens.push({ length, offset, type });
}
