import type { PostgresCompletionSyntaxFacts } from "../analysis/completionProjection.js";
import type {
  PostgresBindingFact,
  PostgresCteFact,
  PostgresNameFact,
  PostgresRelationFact,
  PostgresSyntaxScope,
  PostgresWindowFact,
} from "../analysis/documentFacts.js";
import { postgresScopeAt } from "../analysis/documentFacts.js";
import type { PostgresLanguageRegionShape } from "../analysis/documentShape.js";
import type {
  PlpgsqlKeywordLabel,
  PostgresSqlKeywordLabel,
} from "../analysis/postgresKeywordCatalog.js";
import type { PostgresShapeRange } from "../analysis/postgresSyntax.js";
import type {
  AvailablePlpgsqlSyntaxExpectation,
  AvailablePostgresSqlSyntaxExpectation,
  AvailablePostgresSyntaxExpectation,
  PlpgsqlSyntaxSlot,
  PlpgsqlSyntaxSlotKind,
  PostgresSqlSyntaxSlot,
  PostgresSqlSyntaxSlotKind,
  PostgresSyntaxAuthority,
  PostgresSyntaxExpectationResult,
  PostgresSyntaxFragment,
} from "../analysis/syntaxExpectations.js";
import type {
  SqlAuthoringObject,
  SqlAuthoringObjectKind,
  SqlAuthoringSnapshot,
} from "../snapshot.js";
import { quoteSqlIdentifierIfNeeded } from "../text/identifiers.js";

export type PostgresAuthoringProposalKind =
  | "keyword"
  | "scaffold"
  | "schema"
  | "relation"
  | "column"
  | "routine"
  | "type"
  | "cte"
  | "window"
  | "alias"
  | "binding"
  | "variable"
  | "parameter";

export type PostgresAuthoringInsertion =
  | { kind: "text"; text: string }
  | {
      kind: "call";
      callee: string;
      arguments: readonly { placeholder: string }[];
    }
  | {
      /** A complete statement skeleton, written as an LSP snippet with its tab stops. */
      kind: "scaffold";
      snippet: string;
    };

interface SnapshotProvenance {
  connectionId: string;
  database: string;
  revision: string;
  generation: number | null;
}

interface CatalogObjectProvenance {
  oid: number;
  kind: SqlAuthoringObjectKind;
  schema: string;
  name: string;
}

interface LocalFactProvenance {
  regionId: string;
  scopeId: string;
  language: "sql" | "plpgsql";
  role: PostgresNameFact["role"];
  range: PostgresShapeRange;
}

export type PostgresAuthoringProposalSource =
  | {
      kind: "grammar-terminal";
      language: "sql";
      keyword: PostgresSqlKeywordLabel;
      authority: PostgresSyntaxAuthority;
    }
  | {
      kind: "grammar-scaffold";
      language: "sql";
      keyword: PostgresSqlKeywordLabel;
      authority: PostgresSyntaxAuthority;
    }
  | {
      kind: "grammar-terminal";
      language: "plpgsql";
      keyword: PlpgsqlKeywordLabel;
      authority: PostgresSyntaxAuthority;
    }
  | {
      kind: "catalog-object";
      language: "sql";
      slot: "relation" | "routine" | "column";
      scopeId: string;
      snapshot: SnapshotProvenance;
      object: CatalogObjectProvenance;
    }
  | {
      kind: "derived-schema";
      language: "sql";
      slot: "schema";
      scopeId: string;
      snapshot: SnapshotProvenance;
    }
  | {
      kind: "local-name";
      language: "sql";
      slot: PostgresSqlSyntaxSlotKind;
      derivation?: "relation-alias-stage";
      fact: LocalFactProvenance;
    }
  | {
      kind: "local-name";
      language: "plpgsql";
      slot: PlpgsqlSyntaxSlotKind;
      fact: LocalFactProvenance;
    };

/** A transport-neutral proposal produced by the autonomous SQL authoring application core. */
export interface PostgresAuthoringProposal {
  kind: PostgresAuthoringProposalKind;
  label: string;
  detail?: string;
  insertion: PostgresAuthoringInsertion;
  /** UTF-16 range in the complete application document, never in an injected analysis slice. */
  documentReplacementRange: PostgresShapeRange;
  source: PostgresAuthoringProposalSource;
  /** Lower groups are presented first; order is stable inside one group. */
  rankGroup: 0 | 1 | 2;
  triggerSuggestionsAfterInsert?: boolean;
}

export interface PostgresCompletionPlanRequest {
  expectation: PostgresSyntaxExpectationResult;
  snapshot: SqlAuthoringSnapshot;
  facts: PostgresCompletionSyntaxFacts;
  /** Optional application policy. Omission means no truncation. */
  limit?: number;
}

export type PostgresCompletionUnavailableReason =
  | "shape-truncated"
  | "region-not-found"
  | "region-unprojectable"
  | "region-target-unavailable"
  | "region-target-mismatch"
  | "region-language-mismatch"
  | "region-syntax-error"
  | "scope-not-found"
  | "analysis-identity-mismatch"
  | "invalid-analysis-range";

export type PostgresCompletionPlan =
  | {
      status: "available";
      proposals: readonly PostgresAuthoringProposal[];
      isIncomplete: boolean;
    }
  | {
      status: "ambiguous";
      reason: string;
      proposals: readonly [];
      isIncomplete: false;
    }
  | {
      status: "unavailable";
      reason: string;
      proposals: readonly [];
      isIncomplete: false;
    };

interface CompletionContext {
  documentReplacementRange: PostgresShapeRange;
  documentCaretOffset: number;
  scope: PostgresSyntaxScope;
}

/**
 * Resolves provider-proven grammar expectations against one Workbench catalog snapshot and the
 * syntax scope derived canonically at the caret. It never parses source text or widens an unusable
 * result.
 */
export function planPostgresCompletion(
  request: PostgresCompletionPlanRequest,
): PostgresCompletionPlan {
  const { expectation } = request;
  switch (expectation.status) {
    case "ambiguous":
      return {
        status: "ambiguous",
        reason: expectation.reason,
        proposals: [],
        isIncomplete: false,
      };
    case "unavailable":
      return {
        status: "unavailable",
        reason: expectation.reason,
        proposals: [],
        isIncomplete: false,
      };
    case "available": {
      const prepared = prepareCompletionContext(expectation, request);
      if (prepared.status === "unavailable") return prepared;
      const proposals = isSqlExpectation(expectation)
        ? planSqlCompletion(expectation, request, prepared.context)
        : planPlpgsqlCompletion(expectation, request, prepared.context);
      return applyLimit(stableRank(deduplicate(proposals)), request.limit);
    }
  }
}

function prepareCompletionContext(
  expectation: AvailablePostgresSyntaxExpectation,
  request: PostgresCompletionPlanRequest,
):
  | { status: "available"; context: CompletionContext }
  | Extract<PostgresCompletionPlan, { status: "unavailable" }> {
  const facts = request.facts.document;
  if (facts.shape.truncated) return unavailable("shape-truncated");
  const region = regionById(facts.shape.root, expectation.regionId);
  if (!region) return unavailable("region-not-found");
  if (region.projection.kind !== "identity") return unavailable("region-unprojectable");
  if (region.target.status !== "available") return unavailable("region-target-unavailable");
  if (region.language !== expectation.target.language)
    return unavailable("region-language-mismatch");
  if (!sameTarget(region.target.target, expectation.target))
    return unavailable("region-target-mismatch");
  if (!sameAnalysisIdentity(region.analysisIdentity, expectation.analysisIdentity))
    return unavailable("analysis-identity-mismatch");
  const replacement = projectAnalysisRange(region, expectation.replacementRange);
  const caret = projectAnalysisOffset(region, expectation.analysisOffset);
  if (!replacement || caret === undefined) return unavailable("invalid-analysis-range");
  const scope = postgresScopeAt(facts.scopes, region.id, caret);
  if (!scope) return unavailable("scope-not-found");
  return {
    status: "available",
    context: { documentReplacementRange: replacement, documentCaretOffset: caret, scope },
  };
}

function unavailable(
  reason: PostgresCompletionUnavailableReason,
): Extract<PostgresCompletionPlan, { status: "unavailable" }> {
  return { status: "unavailable", reason, proposals: [], isIncomplete: false };
}

function isSqlExpectation(
  expectation: AvailablePostgresSyntaxExpectation,
): expectation is AvailablePostgresSqlSyntaxExpectation {
  return expectation.target.language === "sql";
}

/**
 * Whole-statement skeletons, each offered only where the grammar expects its opening keyword and
 * the region holds statements — an expression position gets the keyword alone.
 */
const SQL_STATEMENT_SCAFFOLDS: ReadonlyMap<string, { label: string; snippet: string }> = new Map([
  ["SELECT", { label: "SELECT … FROM …;", snippet: "SELECT ${1:columns}\nFROM ${2:relation};" }],
  [
    "INSERT",
    {
      label: "INSERT INTO … VALUES …;",
      snippet: "INSERT INTO ${1:relation} (${2:columns})\nVALUES (${3:values});",
    },
  ],
  [
    "UPDATE",
    {
      label: "UPDATE … SET … WHERE …;",
      snippet: "UPDATE ${1:relation}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition};",
    },
  ],
  [
    "DELETE",
    {
      label: "DELETE FROM … WHERE …;",
      snippet: "DELETE FROM ${1:relation}\nWHERE ${2:condition};",
    },
  ],
]);

function planSqlCompletion(
  expectation: AvailablePostgresSqlSyntaxExpectation,
  request: PostgresCompletionPlanRequest,
  context: CompletionContext,
): readonly PostgresAuthoringProposal[] {
  const semantic = expectation.slots
    .flatMap((slot) => resolveSqlSlot(slot, request, context))
    .filter((proposal) => matchesFragment(proposal.label, expectation.fragment));
  const scaffolds =
    expectation.target.entryPoint === "expression"
      ? []
      : expectation.keywords.flatMap((keyword): PostgresAuthoringProposal[] => {
          const scaffold = SQL_STATEMENT_SCAFFOLDS.get(keyword.label);
          if (!scaffold || !matchesFragment(keyword.label, expectation.fragment)) return [];
          return [
            {
              kind: "scaffold",
              label: scaffold.label,
              insertion: { kind: "scaffold", snippet: scaffold.snippet },
              documentReplacementRange: context.documentReplacementRange,
              source: {
                kind: "grammar-scaffold",
                language: "sql",
                keyword: keyword.label,
                authority: expectation.authority,
              },
              rankGroup: 2,
            },
          ];
        });
  const grammar = expectation.keywords
    .filter((keyword) => matchesFragment(keyword.label, expectation.fragment))
    .map(
      (keyword): PostgresAuthoringProposal => ({
        kind: "keyword",
        label: keyword.label,
        insertion: { kind: "text", text: keyword.label },
        documentReplacementRange: context.documentReplacementRange,
        source: {
          kind: "grammar-terminal",
          language: "sql",
          keyword: keyword.label,
          authority: expectation.authority,
        },
        rankGroup: 2,
      }),
    );
  return [...semantic, ...scaffolds, ...grammar];
}

function planPlpgsqlCompletion(
  expectation: AvailablePlpgsqlSyntaxExpectation,
  request: PostgresCompletionPlanRequest,
  context: CompletionContext,
): readonly PostgresAuthoringProposal[] {
  const semantic = expectation.slots
    .flatMap((slot) => resolvePlpgsqlSlot(slot, request, context))
    .filter((proposal) => matchesFragment(proposal.label, expectation.fragment));
  const grammar = expectation.keywords
    .filter((keyword) => matchesFragment(keyword.label, expectation.fragment))
    .map(
      (keyword): PostgresAuthoringProposal => ({
        kind: "keyword",
        label: keyword.label,
        insertion: { kind: "text", text: keyword.label },
        documentReplacementRange: context.documentReplacementRange,
        source: {
          kind: "grammar-terminal",
          language: "plpgsql",
          keyword: keyword.label,
          authority: expectation.authority,
        },
        rankGroup: 2,
      }),
    );
  return [...semantic, ...grammar];
}

function resolveSqlSlot(
  slot: PostgresSqlSyntaxSlot,
  request: PostgresCompletionPlanRequest,
  context: CompletionContext,
): PostgresAuthoringProposal[] {
  switch (slot.slot) {
    case "schema":
      return slot.qualifier.length === 0
        ? [...new Set(request.snapshot.objects.map((object) => object.schema))].map((schema) => ({
            kind: "schema",
            label: schema,
            insertion: { kind: "text", text: `${quoteSqlIdentifierIfNeeded(schema)}.` },
            documentReplacementRange: context.documentReplacementRange,
            source: {
              kind: "derived-schema",
              language: "sql",
              slot: "schema",
              scopeId: context.scope.id,
              snapshot: snapshotProvenance(request.snapshot),
            },
            rankGroup: 1,
            triggerSuggestionsAfterInsert: true,
          }))
        : [];
    case "relation":
      return catalogObjects(slot, request.snapshot, ["table", "view"]).map((object) =>
        objectProposal(object, "relation", slot, request, context),
      );
    case "routine":
      return catalogObjects(slot, request.snapshot, [slot.invocation]).map((object) =>
        objectProposal(object, "routine", slot, request, context),
      );
    case "column":
      return [
        ...(slot.qualifier.length === 0 ? aliasProposals(slot, request, context) : []),
        ...columnProposals(slot, request, context),
      ];
    case "cte":
      return localNameProposals(
        visibleNamedFacts<PostgresCteFact>(request, context, "cte", "declaration"),
        "cte",
        slot,
        context,
      );
    case "window":
      return localNameProposals(
        visibleNamedFacts<PostgresWindowFact>(request, context, "window", "declaration"),
        "window",
        slot,
        context,
      );
    case "alias":
      return aliasProposals(slot, request, context);
    case "binding":
      return bindingProposals("binding", slot, request, context);
    case "type":
      return [];
  }
}

function resolvePlpgsqlSlot(
  slot: PlpgsqlSyntaxSlot,
  request: PostgresCompletionPlanRequest,
  context: CompletionContext,
): PostgresAuthoringProposal[] {
  switch (slot.slot) {
    case "variable":
    case "parameter":
      return bindingProposals(slot.slot, slot, request, context);
    case "type":
      return [];
  }
}

function catalogObjects(
  slot: PostgresSqlSyntaxSlot,
  snapshot: SqlAuthoringSnapshot,
  kinds: readonly SqlAuthoringObjectKind[],
): SqlAuthoringObject[] {
  if (slot.qualifier.length > 1) return [];
  const schema = slot.qualifier[0]?.canonical;
  return snapshot.objects.filter(
    (object) => kinds.includes(object.kind) && (schema === undefined || object.schema === schema),
  );
}

function objectProposal(
  object: SqlAuthoringObject,
  kind: "relation" | "routine",
  slot: PostgresSqlSyntaxSlot,
  request: PostgresCompletionPlanRequest,
  context: CompletionContext,
): PostgresAuthoringProposal {
  const name = quoteSqlIdentifierIfNeeded(object.name);
  const insertion =
    slot.qualifier.length === 0 ? `${quoteSqlIdentifierIfNeeded(object.schema)}.${name}` : name;
  return {
    kind,
    label: object.name,
    insertion:
      kind === "routine"
        ? {
            kind: "call",
            callee: insertion,
            arguments: object.parameters.map((parameter) => ({
              placeholder: parameter.name || parameter.type,
            })),
          }
        : { kind: "text", text: insertion },
    documentReplacementRange: context.documentReplacementRange,
    source: catalogSource(kind, object, request, context),
    rankGroup: 1,
  };
}

function columnProposals(
  slot: PostgresSqlSyntaxSlot,
  request: PostgresCompletionPlanRequest,
  context: CompletionContext,
): PostgresAuthoringProposal[] {
  const qualifier = slot.qualifier.at(-1)?.canonical;
  return visibleRelationFacts(request, context).flatMap((relation) => {
    const relationName = relation.parts.at(-1);
    const reference = relation.alias ?? relationName;
    if (
      !relationName ||
      !reference ||
      (qualifier !== undefined && reference.canonical !== qualifier)
    ) {
      return [];
    }
    const schema = relation.parts.at(-2)?.canonical;
    const candidates = request.snapshot.objects.filter(
      (object) =>
        (object.kind === "table" || object.kind === "view") &&
        object.name === relationName.canonical &&
        (schema === undefined || object.schema === schema),
    );
    if (candidates.length !== 1) return [];
    const object = candidates[0];
    return object.columns.map(
      (column): PostgresAuthoringProposal => ({
        kind: "column",
        label: column.name,
        detail: column.type,
        insertion: {
          kind: "text",
          text:
            qualifier === undefined
              ? `${reference.written}.${quoteSqlIdentifierIfNeeded(column.name)}`
              : quoteSqlIdentifierIfNeeded(column.name),
        },
        documentReplacementRange: context.documentReplacementRange,
        source: catalogSource("column", object, request, context),
        rankGroup: 0,
      }),
    );
  });
}

function aliasProposals(
  slot: PostgresSqlSyntaxSlot,
  request: PostgresCompletionPlanRequest,
  context: CompletionContext,
): PostgresAuthoringProposal[] {
  if (slot.qualifier.length > 0) return [];
  return visibleRelationFacts(request, context).flatMap((fact) => {
    const alias = fact.alias;
    if (!alias) return [];
    return [
      {
        ...sqlLocalProposal(
          "alias",
          alias.written,
          `${alias.written}.`,
          slot.slot,
          fact,
          context,
          slot.slot === "column" ? "relation-alias-stage" : undefined,
        ),
        triggerSuggestionsAfterInsert: true,
      },
    ];
  });
}

function bindingProposals(
  kind: "binding" | "variable" | "parameter",
  slot: PostgresSqlSyntaxSlot | PlpgsqlSyntaxSlot,
  request: PostgresCompletionPlanRequest,
  context: CompletionContext,
): PostgresAuthoringProposal[] {
  if (slot.qualifier.length > 0) return [];
  return visibleNamedFacts<PostgresBindingFact>(request, context, "binding", "declaration")
    .filter((fact) => kind === "binding" || fact.bindingKind === kind)
    .flatMap((fact) => {
      const name = fact.parts.at(-1);
      return name
        ? [
            slot.language === "sql"
              ? sqlLocalProposal(kind, name.written, name.written, slot.slot, fact, context)
              : plpgsqlLocalProposal(kind, name.written, name.written, slot.slot, fact, context),
          ]
        : [];
    });
}

function localNameProposals<TFact extends PostgresCteFact | PostgresWindowFact>(
  facts: readonly TFact[],
  kind: "cte" | "window",
  slot: PostgresSqlSyntaxSlot,
  context: CompletionContext,
): PostgresAuthoringProposal[] {
  if (slot.qualifier.length > 0) return [];
  return facts.flatMap((fact) => {
    const name = fact.parts.at(-1);
    return name
      ? [sqlLocalProposal(kind, name.written, name.written, slot.slot, fact, context)]
      : [];
  });
}

function sqlLocalProposal(
  kind: "cte" | "window" | "alias" | "binding" | "variable" | "parameter",
  label: string,
  text: string,
  slot: PostgresSqlSyntaxSlotKind,
  fact: PostgresNameFact,
  context: CompletionContext,
  derivation?: "relation-alias-stage",
): PostgresAuthoringProposal {
  return {
    kind,
    label,
    insertion: { kind: "text", text },
    documentReplacementRange: context.documentReplacementRange,
    source: {
      kind: "local-name",
      language: "sql",
      slot,
      ...(derivation === undefined ? {} : { derivation }),
      fact: factProvenance(fact),
    },
    rankGroup: 0,
  };
}

function plpgsqlLocalProposal(
  kind: "binding" | "variable" | "parameter",
  label: string,
  text: string,
  slot: PlpgsqlSyntaxSlotKind,
  fact: PostgresNameFact,
  context: CompletionContext,
): PostgresAuthoringProposal {
  return {
    kind,
    label,
    insertion: { kind: "text", text },
    documentReplacementRange: context.documentReplacementRange,
    source: {
      kind: "local-name",
      language: "plpgsql",
      slot,
      fact: factProvenance(fact),
    },
    rankGroup: 0,
  };
}

function visibleNamedFacts<TFact extends PostgresNameFact>(
  request: PostgresCompletionPlanRequest,
  context: CompletionContext,
  role: TFact["role"],
  use?: "declaration" | "reference",
): TFact[] {
  const candidates = request.facts.document.names.filter(
    (fact): fact is TFact =>
      fact.role === role && (use === undefined || ("use" in fact && fact.use === use)),
  );
  return shadowedFacts(
    candidates,
    request.facts.document.scopes,
    context.scope.id,
    context.documentCaretOffset,
    (fact) => fact.parts.at(-1)?.canonical,
  );
}

function visibleRelationFacts(
  request: PostgresCompletionPlanRequest,
  context: CompletionContext,
): PostgresRelationFact[] {
  const candidates = request.facts.document.names.filter(
    (fact): fact is PostgresRelationFact => fact.role === "relation",
  );
  return shadowedFacts(
    candidates,
    request.facts.document.scopes,
    context.scope.id,
    context.documentCaretOffset,
    (fact) => (fact.alias ?? fact.parts.at(-1))?.canonical,
  );
}

function shadowedFacts<TFact extends PostgresNameFact>(
  facts: readonly TFact[],
  scopes: readonly PostgresSyntaxScope[],
  scopeId: string,
  documentCaretOffset: number,
  nameOf: (fact: TFact) => string | undefined,
): TFact[] {
  const distances = scopeDistances(scopes, scopeId);
  const result: TFact[] = [];
  const seen = new Set<string>();
  const visible = facts
    .map((fact) => ({
      fact,
      distance: nearestVisibleScopeDistance(fact, distances, documentCaretOffset),
    }))
    .filter(
      (candidate): candidate is { fact: TFact; distance: number } =>
        candidate.distance !== undefined,
    )
    .sort(
      (left, right) =>
        left.distance - right.distance || right.fact.range.start - left.fact.range.start,
    );
  for (const { fact } of visible) {
    const name = nameOf(fact);
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    result.push(fact);
  }
  return result;
}

function scopeDistances(
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

function nearestVisibleScopeDistance(
  fact: PostgresNameFact,
  distances: ReadonlyMap<string, number>,
  documentCaretOffset: number,
): number | undefined {
  const visibleDistances = fact.visibility.flatMap((visibility): number[] => {
    const distance = distances.get(visibility.scopeId);
    return distance !== undefined &&
      visibility.range.start <= documentCaretOffset &&
      visibility.range.end >= documentCaretOffset
      ? [distance]
      : [];
  });
  return visibleDistances.length > 0 ? Math.min(...visibleDistances) : undefined;
}

function catalogSource(
  slot: "relation" | "routine" | "column",
  object: SqlAuthoringObject,
  request: PostgresCompletionPlanRequest,
  context: CompletionContext,
): Extract<PostgresAuthoringProposalSource, { kind: "catalog-object" }> {
  return {
    kind: "catalog-object",
    language: "sql",
    slot,
    scopeId: context.scope.id,
    snapshot: snapshotProvenance(request.snapshot),
    object: objectProvenance(object),
  };
}

function snapshotProvenance(snapshot: SqlAuthoringSnapshot): SnapshotProvenance {
  return {
    connectionId: snapshot.connectionId,
    database: snapshot.database,
    revision: snapshot.revision,
    generation: snapshot.generation,
  };
}

function objectProvenance(object: SqlAuthoringObject): CatalogObjectProvenance {
  return { oid: object.oid, kind: object.kind, schema: object.schema, name: object.name };
}

function factProvenance(fact: PostgresNameFact): LocalFactProvenance {
  return {
    regionId: fact.regionId,
    scopeId: fact.scopeId,
    language: fact.language,
    role: fact.role,
    range: fact.range,
  };
}

function matchesFragment(label: string, fragment: PostgresSyntaxFragment): boolean {
  if (fragment.form === "none") return true;
  return fragment.form === "quoted-identifier"
    ? label.startsWith(fragment.canonical)
    : label.toLowerCase().startsWith(fragment.canonical.toLowerCase());
}

function regionById(
  root: PostgresLanguageRegionShape,
  regionId: string,
): PostgresLanguageRegionShape | undefined {
  if (root.id === regionId) return root;
  for (const child of root.children) {
    const found = regionById(child, regionId);
    if (found) return found;
  }
  return undefined;
}

function sameTarget(
  left: AvailablePostgresSyntaxExpectation["target"],
  right: AvailablePostgresSyntaxExpectation["target"],
): boolean {
  return left.language === right.language && left.entryPoint === right.entryPoint;
}

function sameAnalysisIdentity(
  left: PostgresLanguageRegionShape["analysisIdentity"],
  right: AvailablePostgresSyntaxExpectation["analysisIdentity"],
): boolean {
  return (
    left !== undefined &&
    left.algorithm === right.algorithm &&
    left.value === right.value &&
    left.length === right.length
  );
}

function projectAnalysisRange(
  region: PostgresLanguageRegionShape,
  range: PostgresShapeRange,
): PostgresShapeRange | undefined {
  const start = projectAnalysisOffset(region, range.start);
  const end = projectAnalysisOffset(region, range.end);
  return start === undefined || end === undefined || end < start ? undefined : { start, end };
}

function projectAnalysisOffset(
  region: PostgresLanguageRegionShape,
  offset: number,
): number | undefined {
  if (region.projection.kind !== "identity") return undefined;
  const { analysisRange, documentRange } = region.projection;
  if (offset < analysisRange.start || offset > analysisRange.end) return undefined;
  return documentRange.start + (offset - analysisRange.start);
}

function stableRank(
  proposals: readonly PostgresAuthoringProposal[],
): readonly PostgresAuthoringProposal[] {
  return proposals
    .map((proposal, index) => ({ proposal, index }))
    .sort(
      (left, right) =>
        left.proposal.rankGroup - right.proposal.rankGroup || left.index - right.index,
    )
    .map(({ proposal }) => proposal);
}

function applyLimit(
  proposals: readonly PostgresAuthoringProposal[],
  limit: number | undefined,
): Extract<PostgresCompletionPlan, { status: "available" }> {
  if (limit === undefined) return { status: "available", proposals, isIncomplete: false };
  if (!Number.isInteger(limit) || limit < 0) throw new Error(`Invalid completion limit: ${limit}`);
  return {
    status: "available",
    proposals: proposals.slice(0, limit),
    isIncomplete: proposals.length > limit,
  };
}

function deduplicate(
  proposals: readonly PostgresAuthoringProposal[],
): readonly PostgresAuthoringProposal[] {
  const seen = new Set<string>();
  return proposals.filter((proposal) => {
    const identity = `${proposal.kind}\0${JSON.stringify(proposal.insertion)}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}
