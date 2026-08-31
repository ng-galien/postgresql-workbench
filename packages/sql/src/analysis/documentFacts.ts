import { canonicalSqlIdentifier, splitSqlQualifiedIdentifier } from "../text/identifiers.js";
import {
  type PostgresDocumentShape,
  type PostgresLanguageRegionShape,
  type PostgresShapeRange,
  postgresDocumentShape,
} from "./documentShape.js";
import { sqlLexicalTokens } from "./lexicalTokens.js";
import {
  isSqlRoutineArgumentName,
  plpgsqlVariableDeclaration,
  sqlRoutineDeclarationOwner,
} from "./postgresGrammar.js";
import { directSyntaxChild, findSyntaxNode, syntaxNodeText } from "./syntaxNodes.js";
import { type PostgresNestedScopeKind, postgresNestedScopeKind } from "./syntaxScopes.js";
import type {
  SyntaxLanguage,
  SyntaxNode,
  SyntaxParseRequest,
  SyntaxParser,
  SyntaxTree,
} from "./syntaxTree.js";
import { byteToUtf16Offsets } from "./textOffsets.js";

export interface PostgresFactBase {
  regionId: string;
  language: SyntaxLanguage;
  range: PostgresShapeRange;
  /** Syntax-path identity within one immutable facts result. */
  scopeId: string;
}

export interface PostgresLexicalFact extends PostgresFactBase {
  kind: "keyword" | "string" | "number" | "comment" | "operator" | "punctuation";
}

export interface PostgresNamePart {
  written: string;
  canonical: string;
  range: PostgresShapeRange;
}

interface PostgresNameFactBase extends PostgresFactBase {
  parts: readonly PostgresNamePart[];
  /** Grammar-defined places where this name is visible to authoring and resolution. */
  visibility: readonly PostgresFactVisibility[];
}

export interface PostgresFactVisibility {
  scopeId: string;
  range: PostgresShapeRange;
}

export interface PostgresRelationFact extends PostgresNameFactBase {
  role: "relation";
  alias?: PostgresNamePart;
}

export interface PostgresColumnFact extends PostgresNameFactBase {
  role: "column";
}

export interface PostgresRoutineFact extends PostgresNameFactBase {
  role: "routine";
  invocation: "function" | "procedure";
}

export interface PostgresTypeFact extends PostgresNameFactBase {
  role: "type";
  form: "qualified" | "phrase";
}

export interface PostgresParameterFact extends PostgresNameFactBase {
  role: "parameter";
  parameterKind: "positional" | "named";
}

export interface PostgresCteDeclarationFact extends PostgresNameFactBase {
  role: "cte";
  use: "declaration";
  recursive: boolean;
}

export interface PostgresCteReferenceFact extends PostgresNameFactBase {
  role: "cte";
  use: "reference";
}

export type PostgresCteFact = PostgresCteDeclarationFact | PostgresCteReferenceFact;

export interface PostgresWindowFact extends PostgresNameFactBase {
  role: "window";
  use: "declaration" | "reference";
}

export interface PostgresBindingFact extends PostgresNameFactBase {
  role: "binding";
  bindingKind: "variable" | "parameter";
  use: "declaration" | "reference";
  readonly: boolean;
}

export type PostgresNameFact =
  | PostgresRelationFact
  | PostgresColumnFact
  | PostgresRoutineFact
  | PostgresTypeFact
  | PostgresParameterFact
  | PostgresCteFact
  | PostgresWindowFact
  | PostgresBindingFact;

export interface PostgresDocumentSyntaxFacts {
  shape: PostgresDocumentShape;
  scopes: readonly PostgresSyntaxScope[];
  lexical: readonly PostgresLexicalFact[];
  names: readonly PostgresNameFact[];
}

export type PostgresSyntaxScopeKind = "language-region" | PostgresNestedScopeKind;

export interface PostgresSyntaxScope {
  id: string;
  regionId: string;
  language: SyntaxLanguage;
  kind: PostgresSyntaxScopeKind;
  range: PostgresShapeRange;
  parentId?: string;
}

interface ScopedSyntaxScope extends PostgresSyntaxScope {
  depth: number;
}

/** Builds serializable application facts from the syntax port, with no LSP or catalog types. */
export async function postgresDocumentSyntaxFacts(
  parser: SyntaxParser,
  request: SyntaxParseRequest,
): Promise<PostgresDocumentSyntaxFacts> {
  const tree = await parser.parse({ ...request, namedOnly: false });
  return postgresDocumentSyntaxFactsFromTree(request.source, tree);
}

/** Pure reducer used when a caller already owns the parse needed for another syntax decision. */
export function postgresDocumentSyntaxFactsFromTree(
  source: string,
  tree: SyntaxTree,
): PostgresDocumentSyntaxFacts {
  const shape = postgresDocumentShape(source, tree);
  if (tree.truncated) return { shape, scopes: [], lexical: [], names: [] };

  const utf16Offset = byteToUtf16Offsets(source);
  const scopes: ScopedSyntaxScope[] = [];
  addRegionScopes(shape.root, undefined, 0);
  const names: PostgresNameFact[] = [];
  const bindingDeclarations: PostgresBindingFact[] = [];
  const cteDeclarations: Array<{
    fact: PostgresCteDeclarationFact;
    ownerRange: PostgresShapeRange;
  }> = [];
  visitNames(tree.root, [], syntaxLanguage(tree.language), shape.root.id, shape.root.id, []);
  resolveBindingReferences(names, bindingDeclarations);

  const lineStarts = startsOfLines(source);
  const lexical = sqlLexicalTokens(tree, source).flatMap((token): PostgresLexicalFact[] => {
    const start = (lineStarts[token.line] ?? 0) + token.character;
    const range = { start, end: start + token.length };
    const region = deepestRegionContaining(shape.root, range);
    if (region?.projection.kind !== "identity") return [];
    return [
      {
        regionId: region.id,
        language: region.language,
        range,
        scopeId: postgresScopeAt(scopes, region.id, range.start)?.id ?? region.id,
        kind: token.type,
      },
    ];
  });

  assertScopeReferences(scopes, [...lexical, ...names]);
  return { shape, scopes, lexical, names };

  function addRegionScopes(
    region: PostgresLanguageRegionShape,
    parentId: string | undefined,
    depth: number,
  ): void {
    scopes.push({
      id: region.id,
      regionId: region.id,
      language: region.language,
      kind: "language-region",
      range: region.sourceRange,
      ...(parentId === undefined ? {} : { parentId }),
      depth,
    });
    for (const child of region.children) addRegionScopes(child, region.id, depth + 1);
  }

  function visitNames(
    node: SyntaxNode,
    path: readonly number[],
    parentLanguage: SyntaxLanguage,
    parentRegionId: string,
    parentScopeId: string,
    ancestors: readonly SyntaxNode[],
  ): void {
    const range = nodeRange(node, utf16Offset);
    const region = deepestRegionContaining(shape.root, range);
    if (region?.projection.kind !== "identity") return;
    const language = node.languageRegion?.language ?? parentLanguage;
    const regionId = node.languageRegion ? region.id : parentRegionId;
    let scopeId = node.languageRegion ? regionId : parentScopeId;
    const nestedScopeKind = postgresNestedScopeKind(language, node.kind);
    if (nestedScopeKind !== undefined) {
      scopeId = `${regionId}:scope:${path.join(".") || "root"}`;
      const nestedParentId = node.languageRegion ? regionId : parentScopeId;
      scopes.push({
        id: scopeId,
        regionId,
        language,
        kind: nestedScopeKind,
        range,
        parentId: nestedParentId,
        depth: scopeDepth(scopes, nestedParentId) + 1,
      });
    }

    if (language === "sql") {
      const base = { regionId, language, scopeId } as const;
      if (node.kind === "common_table_expr") {
        const nameNode = directSyntaxChild(node, "name");
        const parts = nameNode ? nameParts(nameNode, source, utf16Offset) : [];
        if (parts.length > 0) {
          const withClause = [...ancestors]
            .reverse()
            .find((ancestor) => ancestor.kind === "with_clause");
          const recursive =
            withClause !== undefined && directSyntaxChild(withClause, "kw_recursive") !== undefined;
          const declarationScope = requiredScope(scopes, scopeId);
          const fact: PostgresCteDeclarationFact = {
            ...base,
            role: "cte",
            use: "declaration",
            recursive,
            parts,
            range: partsRange(parts),
            visibility: [
              {
                scopeId,
                range: {
                  start: recursive ? declarationScope.range.start : range.end,
                  end: declarationScope.range.end,
                },
              },
            ],
          };
          names.push(fact);
          cteDeclarations.push({ fact, ownerRange: range });
        }
      } else if (node.kind === "window_definition") {
        const nameNode = directSyntaxChild(node, "ColId");
        const parts = nameNode ? nameParts(nameNode, source, utf16Offset) : [];
        if (parts.length > 0) {
          names.push({
            ...base,
            role: "window",
            use: "declaration",
            parts,
            range: partsRange(parts),
            visibility: wholeScopeVisibility(scopes, scopeId),
          });
        }
      } else if (node.kind === "over_clause") {
        const nameNode = directSyntaxChild(node, "ColId");
        const parts = nameNode ? nameParts(nameNode, source, utf16Offset) : [];
        if (parts.length > 0) {
          names.push({
            ...base,
            role: "window",
            use: "reference",
            parts,
            range: partsRange(parts),
            visibility: occurrenceVisibility(scopeId, partsRange(parts)),
          });
        }
      } else if (node.kind === "relation_expr" || node.kind === "insert_target") {
        const qualified = findSyntaxNode(node, "qualified_name");
        const parts = qualified ? nameParts(qualified, source, utf16Offset) : [];
        if (parts.length > 0) {
          const aliasNode = relationAliasNode(node, ancestors.at(-1));
          const aliasParts = aliasNode ? nameParts(aliasNode, source, utf16Offset) : [];
          const relation: PostgresRelationFact = {
            ...base,
            role: "relation",
            parts,
            range: partsRange(parts),
            visibility: wholeScopeVisibility(scopes, scopeId),
            ...(aliasParts.at(-1) ? { alias: aliasParts.at(-1) } : {}),
          };
          names.push(relation);
          const cte = referencedCte(cteDeclarations, relation, scopes);
          const owner = [...ancestors]
            .reverse()
            .find((ancestor) => ancestor.kind === "common_table_expr");
          const selfReference =
            owner !== undefined &&
            cte !== undefined &&
            cte.ownerRange.start === nodeRange(owner, utf16Offset).start;
          if (cte && (!selfReference || cte.fact.recursive)) {
            names.push({
              ...base,
              role: "cte",
              use: "reference",
              parts,
              range: partsRange(parts),
              visibility: occurrenceVisibility(scopeId, partsRange(parts)),
            });
          }
        }
      } else if (node.kind === "columnref") {
        const parts = nameParts(node, source, utf16Offset);
        if (parts.length > 0 && parts.at(-1)?.written !== "*") {
          const factRange = partsRange(parts);
          names.push({
            ...base,
            role: "column",
            parts,
            range: factRange,
            visibility: occurrenceVisibility(scopeId, factRange),
          });
        }
      } else if (node.kind === "func_application") {
        const name = findSyntaxNode(node, "func_name");
        const parts = name ? nameParts(name, source, utf16Offset) : [];
        if (parts.length > 0) {
          names.push({
            ...base,
            role: "routine",
            invocation:
              !ancestors.some((ancestor) => ancestor.kind === "func_application") &&
              ancestors.some((ancestor) => ancestor.kind === "CallStmt")
                ? "procedure"
                : "function",
            parts,
            range: partsRange(parts),
            visibility: occurrenceVisibility(scopeId, partsRange(parts)),
          });
        }
      } else if (
        node.kind === "param" ||
        (node.kind === "param_name" &&
          ancestors.some((ancestor) => ancestor.kind === "func_arg_expr"))
      ) {
        const part = singleNamePart(node, source, utf16Offset);
        names.push({
          ...base,
          role: "parameter",
          parameterKind: node.kind === "param" ? "positional" : "named",
          parts: [part],
          range: part.range,
          visibility: occurrenceVisibility(scopeId, part.range),
        });
      } else if (node.kind === "Typename") {
        const generic = findSyntaxNode(node, "GenericType");
        const parts = generic
          ? nameParts(generic, source, utf16Offset)
          : typePhraseParts(node, source, utf16Offset);
        if (parts.length > 0) {
          names.push({
            ...base,
            role: "type",
            form: generic ? "qualified" : "phrase",
            parts,
            range: partsRange(parts),
            visibility: occurrenceVisibility(scopeId, partsRange(parts)),
          });
        }
      }
      if (isSqlRoutineArgumentName(node, ancestors.at(-1))) {
        const routine = sqlRoutineDeclarationOwner(ancestors);
        const body = routine
          ? routineBodyRegionInside(shape.root, nodeRange(routine, utf16Offset))
          : undefined;
        const parts = nameParts(node, source, utf16Offset);
        if (body && parts.length > 0) {
          const binding: PostgresBindingFact = {
            ...base,
            role: "binding",
            bindingKind: "parameter",
            use: "declaration",
            readonly: false,
            parts,
            range: partsRange(parts),
            visibility: [{ scopeId: body.id, range: body.sourceRange }],
          };
          names.push(binding);
          bindingDeclarations.push(binding);
        }
      }
    } else {
      const declaration = plpgsqlVariableDeclaration(node);
      if (declaration) {
        const parts = nameParts(declaration.name, source, utf16Offset);
        if (parts.length > 0) {
          const binding: PostgresBindingFact = {
            regionId,
            language,
            scopeId,
            role: "binding",
            bindingKind: "variable",
            use: "declaration",
            readonly: declaration.readonly,
            parts,
            range: partsRange(parts),
            visibility: wholeScopeVisibility(scopes, scopeId),
          };
          names.push(binding);
          bindingDeclarations.push(binding);
        }
        if (declaration.type) {
          const parts = typePhraseParts(declaration.type, source, utf16Offset);
          if (parts.length > 0) {
            names.push({
              regionId,
              language,
              scopeId,
              role: "type",
              form: declaration.typeForm ?? "phrase",
              parts,
              range: partsRange(parts),
              visibility: occurrenceVisibility(scopeId, partsRange(parts)),
            });
          }
        }
      }
    }

    for (const [index, child] of node.children.entries()) {
      visitNames(child, [...path, index], language, regionId, scopeId, [...ancestors, node]);
    }
  }
}

function routineBodyRegionInside(
  root: PostgresLanguageRegionShape,
  owner: PostgresShapeRange,
): PostgresLanguageRegionShape | undefined {
  return root.children
    .filter(
      (region) =>
        region.kind === "parser-injection" &&
        region.sourceRange.start >= owner.start &&
        region.sourceRange.end <= owner.end,
    )
    .sort((left, right) => left.sourceRange.start - right.sourceRange.start)[0];
}

/**
 * A routine binding can be named only after the parser exposed an SQL region and that grammar
 * classified the name. A provider returning an opaque expression therefore stays fail-closed: no
 * text is scanned to manufacture references.
 */
function resolveBindingReferences(
  names: PostgresNameFact[],
  declarations: readonly PostgresBindingFact[],
): void {
  for (const [index, fact] of names.entries()) {
    if (fact.language !== "sql" || fact.role !== "column" || fact.parts.length !== 1) continue;
    const part = fact.parts[0];
    const declaration = declarations
      .filter(
        (candidate) =>
          candidate.parts[0]?.canonical === part.canonical &&
          candidate.visibility.some(
            ({ range }) => range.start <= fact.range.start && range.end >= fact.range.end,
          ),
      )
      .sort((left, right) => {
        const leftSpan = narrowestVisibilitySpan(left, fact.range);
        const rightSpan = narrowestVisibilitySpan(right, fact.range);
        return leftSpan - rightSpan || right.range.start - left.range.start;
      })[0];
    if (!declaration) continue;
    names[index] = {
      regionId: fact.regionId,
      language: fact.language,
      scopeId: fact.scopeId,
      role: "binding",
      bindingKind: declaration.bindingKind,
      use: "reference",
      readonly: declaration.readonly,
      parts: fact.parts,
      range: fact.range,
      visibility: fact.visibility,
    };
  }
}

function narrowestVisibilitySpan(
  declaration: PostgresBindingFact,
  reference: PostgresShapeRange,
): number {
  return Math.min(
    ...declaration.visibility
      .filter(({ range }) => range.start <= reference.start && range.end >= reference.end)
      .map(({ range }) => range.end - range.start),
  );
}

function typePhraseParts(
  node: SyntaxNode,
  source: string,
  utf16Offset: (byte: number) => number,
): PostgresNamePart[] {
  const parts: PostgresNamePart[] = [];
  const visit = (candidate: SyntaxNode) => {
    if (
      candidate.kind === "opt_type_modifiers" ||
      candidate.kind === "opt_array_bounds" ||
      candidate.kind === "kw_setof"
    ) {
      return;
    }
    if (
      candidate.children.length === 0 &&
      (candidate.kind.startsWith("kw_") || candidate.kind === "identifier")
    ) {
      parts.push(singleNamePart(candidate, source, utf16Offset));
      return;
    }
    for (const child of candidate.children) visit(child);
  };
  visit(node);
  return parts;
}

function singleNamePart(
  node: SyntaxNode,
  source: string,
  utf16Offset: (byte: number) => number,
): PostgresNamePart {
  const written = syntaxNodeText(source, node);
  const range = nodeRange(node, utf16Offset);
  return { written, canonical: canonicalSqlIdentifier(written), range };
}

function relationAliasNode(
  relation: SyntaxNode,
  parent: SyntaxNode | undefined,
): SyntaxNode | undefined {
  for (const owner of [relation, parent]) {
    if (!owner) continue;
    const clause =
      directSyntaxChild(owner, "opt_alias_clause") ?? directSyntaxChild(owner, "alias_clause");
    if (clause) return findSyntaxNode(clause, "ColId") ?? clause;
  }
  if (parent?.kind === "relation_expr_opt_alias") return directSyntaxChild(parent, "ColId");
  return undefined;
}

function nameParts(
  node: SyntaxNode,
  source: string,
  utf16Offset: (byte: number) => number,
): PostgresNamePart[] {
  const range = nodeRange(node, utf16Offset);
  const written = syntaxNodeText(source, node).trim();
  const leading = syntaxNodeText(source, node).indexOf(written);
  const parts = splitSqlQualifiedIdentifier(written);
  const result: PostgresNamePart[] = [];
  let cursor = 0;
  for (const part of parts) {
    const relative = written.indexOf(part, cursor);
    if (relative < 0) continue;
    const start = range.start + leading + relative;
    result.push({
      written: part,
      canonical: canonicalSqlIdentifier(part),
      range: { start, end: start + part.length },
    });
    cursor = relative + part.length;
  }
  return result;
}

function partsRange(parts: readonly PostgresNamePart[]): PostgresShapeRange {
  const first = parts[0];
  const last = parts.at(-1);
  if (!first || !last) throw new Error("A PostgreSQL name fact requires at least one part");
  return { start: first.range.start, end: last.range.end };
}

function nodeRange(node: SyntaxNode, utf16Offset: (byte: number) => number): PostgresShapeRange {
  return { start: utf16Offset(node.byteRange[0]), end: utf16Offset(node.byteRange[1]) };
}

function deepestRegionContaining(
  root: PostgresLanguageRegionShape,
  range: PostgresShapeRange,
): PostgresLanguageRegionShape | undefined {
  if (range.start < root.sourceRange.start || range.end > root.sourceRange.end) return undefined;
  for (const child of root.children) {
    const nested = deepestRegionContaining(child, range);
    if (nested) return nested;
  }
  return root;
}

export function postgresScopeAt(
  scopes: readonly PostgresSyntaxScope[],
  regionId: string,
  documentOffset: number,
): PostgresSyntaxScope | undefined {
  const depths = scopeDepths(scopes);
  const inRegion = scopes.filter((scope) => scope.regionId === regionId);
  return (
    deepestScope(
      inRegion.filter((scope) => scope.range.start === documentOffset),
      depths,
    ) ??
    deepestScope(
      inRegion.filter(
        (scope) => scope.range.start < documentOffset && scope.range.end > documentOffset,
      ),
      depths,
    ) ??
    deepestScope(
      inRegion.filter((scope) => scope.range.end === documentOffset),
      depths,
    )
  );
}

function deepestScope(
  scopes: readonly PostgresSyntaxScope[],
  depths: ReadonlyMap<string, number>,
): PostgresSyntaxScope | undefined {
  return [...scopes].sort(
    (left, right) =>
      (depths.get(right.id) ?? 0) - (depths.get(left.id) ?? 0) ||
      left.range.end - left.range.start - (right.range.end - right.range.start) ||
      left.id.localeCompare(right.id),
  )[0];
}

function referencedCte(
  declarations: readonly {
    fact: PostgresCteDeclarationFact;
    ownerRange: PostgresShapeRange;
  }[],
  relation: PostgresRelationFact,
  scopes: readonly PostgresSyntaxScope[],
): { fact: PostgresCteDeclarationFact; ownerRange: PostgresShapeRange } | undefined {
  const name = relation.parts.length === 1 ? relation.parts[0]?.canonical : undefined;
  if (name === undefined) return undefined;
  const visibleScopes = scopeIdsFromNearest(scopes, relation.scopeId);
  return declarations
    .filter(
      ({ fact }) =>
        fact.parts.at(-1)?.canonical === name &&
        visibleAt(fact.visibility, visibleScopes, relation.range.start),
    )
    .sort((left, right) => {
      const leftDepth = visibleScopes.get(left.fact.scopeId) ?? Number.MAX_SAFE_INTEGER;
      const rightDepth = visibleScopes.get(right.fact.scopeId) ?? Number.MAX_SAFE_INTEGER;
      return leftDepth - rightDepth || right.fact.range.start - left.fact.range.start;
    })[0];
}

function scopeIdsFromNearest(
  scopes: readonly PostgresSyntaxScope[],
  scopeId: string,
): ReadonlyMap<string, number> {
  const byId = new Map(scopes.map((scope) => [scope.id, scope] as const));
  const result = new Map<string, number>();
  let current = byId.get(scopeId);
  let distance = 0;
  while (current) {
    if (result.has(current.id)) throw new Error(`Cyclic syntax scope graph at ${current.id}`);
    result.set(current.id, distance);
    current = current.parentId === undefined ? undefined : byId.get(current.parentId);
    distance += 1;
  }
  return result;
}

function assertScopeReferences(
  scopes: readonly PostgresSyntaxScope[],
  facts: readonly (PostgresLexicalFact | PostgresNameFact)[],
): void {
  const byId = new Map(scopes.map((scope) => [scope.id, scope] as const));
  for (const scope of scopes) {
    if (scope.parentId !== undefined && !byId.has(scope.parentId)) {
      throw new Error(`Unknown parent scope ${scope.parentId} of ${scope.id}`);
    }
  }
  for (const fact of facts) {
    const declarationScope = byId.get(fact.scopeId);
    if (!declarationScope) {
      throw new Error(`Unknown scope ${fact.scopeId} referenced by syntax fact`);
    }
    if (
      declarationScope.regionId !== fact.regionId ||
      declarationScope.language !== fact.language
    ) {
      throw new Error(`Syntax fact and declaration scope disagree at ${fact.scopeId}`);
    }
    assertRangeInside(fact.range, declarationScope.range, `syntax fact in ${fact.scopeId}`);
    if ("visibility" in fact) {
      for (const visibility of fact.visibility) {
        const visibilityScope = byId.get(visibility.scopeId);
        if (!visibilityScope) {
          throw new Error(
            `Unknown visibility scope ${visibility.scopeId} referenced by syntax fact`,
          );
        }
        assertRangeInside(
          visibility.range,
          visibilityScope.range,
          `syntax fact visibility in ${visibility.scopeId}`,
        );
      }
    }
  }
}

function assertRangeInside(
  range: PostgresShapeRange,
  container: PostgresShapeRange,
  subject: string,
): void {
  if (range.end < range.start || range.start < container.start || range.end > container.end) {
    throw new Error(`Invalid ${subject} range ${range.start}-${range.end}`);
  }
}

function wholeScopeVisibility(
  scopes: readonly PostgresSyntaxScope[],
  scopeId: string,
): readonly PostgresFactVisibility[] {
  return [{ scopeId, range: requiredScope(scopes, scopeId).range }];
}

function occurrenceVisibility(
  scopeId: string,
  range: PostgresShapeRange,
): readonly PostgresFactVisibility[] {
  return [{ scopeId, range }];
}

function requiredScope(
  scopes: readonly PostgresSyntaxScope[],
  scopeId: string,
): PostgresSyntaxScope {
  const scope = scopes.find((candidate) => candidate.id === scopeId);
  if (!scope) throw new Error(`Unknown syntax scope ${scopeId}`);
  return scope;
}

function visibleAt(
  visibility: readonly PostgresFactVisibility[],
  scopesFromCaret: ReadonlyMap<string, number>,
  documentOffset: number,
): boolean {
  return visibility.some(
    (entry) =>
      scopesFromCaret.has(entry.scopeId) &&
      entry.range.start <= documentOffset &&
      entry.range.end >= documentOffset,
  );
}

function scopeDepths(scopes: readonly PostgresSyntaxScope[]): ReadonlyMap<string, number> {
  const byId = new Map(scopes.map((scope) => [scope.id, scope] as const));
  const result = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (scope: PostgresSyntaxScope): number => {
    const known = result.get(scope.id);
    if (known !== undefined) return known;
    if (visiting.has(scope.id)) throw new Error(`Cyclic syntax scope graph at ${scope.id}`);
    visiting.add(scope.id);
    let depth = 0;
    if (scope.parentId !== undefined) {
      const parent = byId.get(scope.parentId);
      if (!parent) throw new Error(`Unknown parent scope ${scope.parentId} of ${scope.id}`);
      depth = depthOf(parent) + 1;
    }
    visiting.delete(scope.id);
    result.set(scope.id, depth);
    return depth;
  };
  for (const scope of scopes) depthOf(scope);
  return result;
}

function scopeDepth(scopes: readonly ScopedSyntaxScope[], scopeId: string): number {
  const scope = scopes.find((candidate) => candidate.id === scopeId);
  if (!scope) throw new Error(`Unknown parent scope ${scopeId}`);
  return scope.depth;
}

function syntaxLanguage(language: string): SyntaxLanguage {
  if (language === "sql" || language === "plpgsql") return language;
  throw new Error(`Unsupported PostgreSQL document language: ${language}`);
}

function startsOfLines(source: string): number[] {
  const starts = [0];
  for (let index = source.indexOf("\n"); index >= 0; index = source.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}
