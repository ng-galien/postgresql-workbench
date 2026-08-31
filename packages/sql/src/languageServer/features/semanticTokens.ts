import { SemanticTokensBuilder } from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type {
  PostgresBindingFact,
  PostgresColumnFact,
  PostgresCteFact,
  PostgresLexicalFact,
  PostgresNameFact,
  PostgresParameterFact,
  PostgresRoutineFact,
  PostgresTypeFact,
  PostgresWindowFact,
} from "../../analysis/documentFacts.js";
import type { SqlAuthoringObject, SqlAuthoringSnapshot } from "../../snapshot.js";
import { canonicalSqlIdentifier, splitSqlQualifiedIdentifier } from "../../text/identifiers.js";
import {
  SQL_SEMANTIC_TOKEN_MODIFIERS,
  SQL_SEMANTIC_TOKEN_TYPES,
  type SqlSemanticTokenType,
} from "../legend.js";

interface Token {
  length: number;
  offset: number;
  tokenModifiers: number;
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

interface EncodedToken {
  length: number;
  offset: number;
  tokenType: number;
  tokenModifiers: number;
}

/**
 * One stream, in two layers. What each piece of the statement *is* comes from the parse; what each
 * name *means* needs the catalog, and only this server has it. They are laid in that order and a
 * piece already spoken for is left alone, so a word the grammar reserves but a query uses as a
 * column name is coloured by what it means here rather than by how it is spelled.
 */
export function postgresSemanticTokens(
  document: TextDocument,
  snapshot: SqlAuthoringSnapshot | undefined,
  names: readonly PostgresNameFact[] = [],
  lexical: readonly PostgresLexicalFact[] = [],
) {
  const source = document.getText();
  const encoded: EncodedToken[] = [];
  for (const token of collectSemanticTokens(source, snapshot, names)) {
    // A semantic token addresses one line: a quoted identifier written across two produces none.
    if (source.slice(token.offset, token.offset + token.length).includes("\n")) continue;
    encoded.push({
      length: token.length,
      offset: token.offset,
      tokenType: semanticTokenTypeIndex(token.type),
      tokenModifiers: token.tokenModifiers,
    });
  }
  const taken = new Set(encoded.map((token) => `${token.offset}:${token.length}`));
  for (const fact of lexical) {
    const length = fact.range.end - fact.range.start;
    if (length <= 0 || taken.has(`${fact.range.start}:${length}`)) continue;
    encoded.push({
      length,
      offset: fact.range.start,
      tokenType: semanticTokenTypeIndex(fact.kind),
      tokenModifiers: 0,
    });
    taken.add(`${fact.range.start}:${length}`);
  }
  encoded.sort((left, right) => left.offset - right.offset || left.length - right.length);
  const builder = new SemanticTokensBuilder();
  for (const token of encoded) {
    const position = document.positionAt(token.offset);
    builder.push(
      position.line,
      position.character,
      token.length,
      token.tokenType,
      token.tokenModifiers,
    );
  }
  return builder.build();
}

function collectSemanticTokens(
  source: string,
  snapshot: SqlAuthoringSnapshot | undefined,
  names: readonly PostgresNameFact[],
): Token[] {
  const tokens: Token[] = [];
  const occupied = new Set<string>();

  addBindingFactTokens(tokens, occupied, names);
  addCteFactTokens(tokens, occupied, names);
  addWindowFactTokens(tokens, occupied, names);
  addRoutineFactTokens(tokens, occupied, names, snapshot?.objects ?? []);
  addParameterFactTokens(tokens, occupied, names);
  addTypeFactTokens(tokens, occupied, names);
  if (snapshot) {
    const references = relationReferences(names, snapshot.objects, source);
    addRelationTokens(tokens, occupied, references);
    addColumnFactTokens(tokens, occupied, names, references);
  }
  return tokens;
}

function addBindingFactTokens(
  tokens: Token[],
  occupied: Set<string>,
  names: readonly PostgresNameFact[],
): void {
  for (const fact of names.filter(
    (candidate): candidate is PostgresBindingFact => candidate.role === "binding",
  )) {
    const name = fact.parts[0];
    if (!name) continue;
    addToken(
      tokens,
      occupied,
      name.range.start,
      name.range.end - name.range.start,
      fact.bindingKind,
      semanticTokenModifiers(fact),
    );
  }
}

function addCteFactTokens(
  tokens: Token[],
  occupied: Set<string>,
  names: readonly PostgresNameFact[],
): void {
  for (const fact of names.filter(
    (candidate): candidate is PostgresCteFact => candidate.role === "cte",
  )) {
    const name = fact.parts.at(-1);
    if (name)
      addToken(tokens, occupied, name.range.start, name.range.end - name.range.start, "sqlCte");
  }
}

function addWindowFactTokens(
  tokens: Token[],
  occupied: Set<string>,
  names: readonly PostgresNameFact[],
): void {
  for (const fact of names.filter(
    (candidate): candidate is PostgresWindowFact => candidate.role === "window",
  )) {
    const name = fact.parts.at(-1);
    if (name) {
      addToken(tokens, occupied, name.range.start, name.range.end - name.range.start, "sqlWindow");
    }
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

function addRoutineFactTokens(
  tokens: Token[],
  occupied: Set<string>,
  names: readonly PostgresNameFact[],
  objects: readonly SqlAuthoringObject[],
): void {
  for (const fact of names.filter(
    (candidate): candidate is PostgresRoutineFact => candidate.role === "routine",
  )) {
    const namePart = fact.parts.at(-1);
    if (!namePart) continue;
    const object = routineObject(fact, objects);
    const schema = fact.parts.at(-2);
    if (schema) {
      addToken(
        tokens,
        occupied,
        schema.range.start,
        schema.range.end - schema.range.start,
        "sqlSchema",
      );
    }
    addToken(
      tokens,
      occupied,
      namePart.range.start,
      namePart.range.end - namePart.range.start,
      object?.kind === "procedure" || fact.invocation === "procedure"
        ? "sqlProcedure"
        : "sqlFunction",
    );
  }
}

function addParameterFactTokens(
  tokens: Token[],
  occupied: Set<string>,
  names: readonly PostgresNameFact[],
): void {
  for (const fact of names.filter(
    (candidate): candidate is PostgresParameterFact => candidate.role === "parameter",
  )) {
    const part = fact.parts[0];
    if (part) {
      addToken(
        tokens,
        occupied,
        part.range.start,
        part.range.end - part.range.start,
        "sqlParameter",
      );
    }
  }
}

function addTypeFactTokens(
  tokens: Token[],
  occupied: Set<string>,
  names: readonly PostgresNameFact[],
): void {
  for (const fact of names.filter(
    (candidate): candidate is PostgresTypeFact => candidate.role === "type",
  )) {
    const typeParts = fact.form === "qualified" ? fact.parts.slice(-1) : fact.parts;
    const schema = fact.form === "qualified" ? fact.parts.at(-2) : undefined;
    if (schema) {
      addToken(
        tokens,
        occupied,
        schema.range.start,
        schema.range.end - schema.range.start,
        "sqlSchema",
      );
    }
    for (const part of typeParts) {
      addToken(
        tokens,
        occupied,
        part.range.start,
        part.range.end - part.range.start,
        fact.language === "plpgsql" ? "type" : "sqlType",
      );
    }
  }
}

function addColumnFactTokens(
  tokens: Token[],
  occupied: Set<string>,
  names: readonly PostgresNameFact[],
  references: readonly RelationReference[],
): void {
  const aliases = new Map<string, RelationReference>();
  for (const reference of references) {
    const qualifier = reference.alias ?? reference.object?.name ?? reference.cte;
    if (qualifier) aliases.set(canonicalSqlIdentifier(qualifier), reference);
  }

  const objects = references.flatMap((reference) => (reference.object ? [reference.object] : []));
  for (const fact of names.filter(
    (candidate): candidate is PostgresColumnFact => candidate.role === "column",
  )) {
    const name = fact.parts.at(-1);
    if (!name) continue;
    const qualifier = fact.parts.at(-2);
    if (qualifier) {
      const reference = aliases.get(qualifier.canonical);
      if (
        reference &&
        (reference.cte ||
          reference.object?.columns.some((column) => column.name === name.canonical))
      ) {
        addToken(
          tokens,
          occupied,
          qualifier.range.start,
          qualifier.range.end - qualifier.range.start,
          "sqlAlias",
        );
        addToken(
          tokens,
          occupied,
          name.range.start,
          name.range.end - name.range.start,
          "sqlColumn",
        );
      }
      continue;
    }
    const owners = new Set(
      objects
        .filter((object) => object.columns.some((column) => column.name === name.canonical))
        .map(keyFor),
    );
    if (owners.size === 1) {
      addToken(tokens, occupied, name.range.start, name.range.end - name.range.start, "sqlColumn");
    }
  }
}

/** Relation references of the document, read from the syntax tree and resolved on the Index. */
function relationReferences(
  names: readonly PostgresNameFact[],
  objects: readonly SqlAuthoringObject[],
  source: string,
): RelationReference[] {
  const cteReferences = new Map(
    names
      .filter(
        (candidate): candidate is PostgresCteFact =>
          candidate.role === "cte" && candidate.use === "reference",
      )
      .map((fact) => [`${fact.range.start}:${fact.range.end}`, fact] as const),
  );
  const references: RelationReference[] = [];
  for (const fact of names.filter((candidate) => candidate.role === "relation")) {
    const parts = fact.parts.map((part) => part.canonical);
    const object = resolveRelationObject(parts, objects);
    const cte = cteReferences.get(`${fact.range.start}:${fact.range.end}`)?.parts.at(-1)?.canonical;
    if (!object && !cte) continue;
    references.push({
      ...(fact.alias === undefined ? {} : { alias: fact.alias.written }),
      ...(fact.alias === undefined ? {} : { aliasOffset: fact.alias.range.start }),
      ...(cte === undefined ? {} : { cte }),
      ...(object === undefined ? {} : { object }),
      reference: source.slice(fact.range.start, fact.range.end),
      referenceOffset: fact.range.start,
    });
  }
  return references;
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
  fact: PostgresRoutineFact,
  objects: readonly SqlAuthoringObject[],
): SqlAuthoringObject | undefined {
  const names = fact.parts.map((part) => part.canonical);
  const candidates = objects.filter(
    (object) =>
      (object.kind === "function" || object.kind === "procedure") &&
      object.name === names.at(-1) &&
      (names.length === 1 || object.schema === names[0]) &&
      (fact.invocation !== "procedure" || object.kind === "procedure"),
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

function addToken(
  tokens: Token[],
  occupied: Set<string>,
  offset: number,
  length: number,
  type: SqlSemanticTokenType,
  tokenModifiers = 0,
): void {
  const key = `${offset}:${length}`;
  if (length <= 0 || occupied.has(key)) return;
  occupied.add(key);
  tokens.push({ length, offset, tokenModifiers, type });
}

const SEMANTIC_TOKEN_TYPE_INDEX = new Map<SqlSemanticTokenType, number>(
  SQL_SEMANTIC_TOKEN_TYPES.map((type, index) => [type, index]),
);
const SEMANTIC_TOKEN_MODIFIER_INDEX = new Map(
  SQL_SEMANTIC_TOKEN_MODIFIERS.map((modifier, index) => [modifier, index]),
);

function semanticTokenTypeIndex(type: SqlSemanticTokenType): number {
  const index = SEMANTIC_TOKEN_TYPE_INDEX.get(type);
  if (index === undefined)
    throw new Error(`Semantic token type is absent from the legend: ${type}`);
  return index;
}

function semanticTokenModifiers(fact: PostgresBindingFact): number {
  let modifiers = 0;
  if (fact.use === "declaration") modifiers |= semanticTokenModifier("declaration");
  if (fact.readonly) modifiers |= semanticTokenModifier("readonly");
  return modifiers;
}

function semanticTokenModifier(modifier: (typeof SQL_SEMANTIC_TOKEN_MODIFIERS)[number]): number {
  const index = SEMANTIC_TOKEN_MODIFIER_INDEX.get(modifier);
  if (index === undefined)
    throw new Error(`Semantic token modifier is absent from the legend: ${modifier}`);
  return 1 << index;
}
