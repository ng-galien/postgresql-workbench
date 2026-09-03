import type { PostgresDocumentSyntaxFacts, PostgresNameFact } from "./documentFacts.js";
import type { PostgresLanguageRegionShape } from "./documentShape.js";
import {
  type PostgresAnalysisIdentity,
  type PostgresShapeRange,
  postgresAnalysisIdentity,
} from "./postgresSyntax.js";
import type {
  AvailablePostgresSqlSyntaxExpectation,
  PostgresSyntaxExpectationResult,
  PostgresSyntaxIdentifier,
} from "./syntaxExpectations.js";

export type PostgresCompletionFactsProvenance =
  | {
      kind: "original-document";
      analysisIdentity: PostgresAnalysisIdentity;
    }
  | {
      kind: "grammar-proven-qualified-reference-projection";
      regionId: string;
      originalAnalysisIdentity: PostgresAnalysisIdentity;
      projectedAnalysisIdentity: PostgresAnalysisIdentity;
      qualifier: readonly PostgresSyntaxIdentifier[];
      repairedDocumentRange: PostgresShapeRange;
      offsetMapping: "identity";
    };

/** Facts consumed only while planning one completion response, with their parse provenance. */
export interface PostgresCompletionSyntaxFacts {
  document: PostgresDocumentSyntaxFacts;
  provenance: PostgresCompletionFactsProvenance;
}

export interface PostgresCompletionProjectionParseResult {
  hasError: boolean;
  truncated: boolean;
  facts?: PostgresDocumentSyntaxFacts;
}

export function originalPostgresCompletionSyntaxFacts(
  facts: PostgresDocumentSyntaxFacts,
  region: PostgresLanguageRegionShape,
): PostgresCompletionSyntaxFacts {
  if (region.analysisIdentity === undefined) {
    throw new Error("Completion facts require a projected language region");
  }
  return {
    document: facts,
    provenance: { kind: "original-document", analysisIdentity: region.analysisIdentity },
  };
}

/**
 * The facts a completion may stand on while the document is mid-edit. Robust completion never
 * demands a valid document; this composes the canonical techniques for living without one:
 *
 * - The LR automaton parses the prefix alone and names what may stand at the caret — the
 *   expectation. A proven prefix is the admissibility test for everything else.
 * - The official parser's error recovery still classifies the rest of the statement, so a FROM
 *   clause keeps its relations and aliases while the line being typed is broken. When the prefix
 *   is attested, those recovered names stand; only an unproven prefix withholds them.
 * - An unfinished qualified reference (`p.`) is repaired with one equal-width neutral identifier
 *   and reparsed — equal width keeps every parser range and region identity stable — so a clean
 *   reparse can restore exact facts.
 */
export async function postgresCompletionSyntaxFacts(
  source: string,
  original: PostgresDocumentSyntaxFacts,
  region: PostgresLanguageRegionShape,
  expectation: PostgresSyntaxExpectationResult,
  parse: (projectedSource: string) => Promise<PostgresCompletionProjectionParseResult>,
): Promise<PostgresCompletionSyntaxFacts | undefined> {
  const fallback =
    region.hasError === false || expectation.status === "available"
      ? originalPostgresCompletionSyntaxFacts(original, region)
      : undefined;
  const repair = qualifiedReferenceProjection(source, region, expectation);
  if (repair === undefined) return fallback;

  const parsed = await parse(repair.source);
  if (
    parsed.hasError ||
    parsed.truncated ||
    parsed.facts === undefined ||
    parsed.facts.shape.truncated ||
    !sameIdentity(parsed.facts.shape.root.analysisIdentity, postgresAnalysisIdentity(repair.source))
  ) {
    return fallback;
  }
  if (!sameShapeTopology(original.shape.root, parsed.facts.shape.root)) return fallback;
  if (!scopeRegionsKnown(original.shape.root, parsed.facts)) return fallback;
  const projectedRegion = regionById(parsed.facts.shape.root, region.id);
  if (
    projectedRegion?.hasError !== false ||
    projectedRegion?.analysisIdentity === undefined ||
    projectedRegion.analysisSource === undefined ||
    !sameIdentity(
      projectedRegion.analysisIdentity,
      postgresAnalysisIdentity(projectedRegion.analysisSource),
    )
  ) {
    return fallback;
  }

  return {
    document: {
      shape: original.shape,
      scopes: parsed.facts.scopes,
      lexical: original.lexical,
      names: parsed.facts.names.filter(
        (fact) => !rangesOverlap(fact.range, repair.repairedDocumentRange),
      ),
    },
    provenance: {
      kind: "grammar-proven-qualified-reference-projection",
      regionId: region.id,
      originalAnalysisIdentity: repair.originalAnalysisIdentity,
      projectedAnalysisIdentity: projectedRegion.analysisIdentity,
      qualifier: repair.qualifier,
      repairedDocumentRange: repair.repairedDocumentRange,
      offsetMapping: "identity",
    },
  };
}

function qualifiedReferenceProjection(
  source: string,
  region: PostgresLanguageRegionShape,
  expectation: PostgresSyntaxExpectationResult,
):
  | {
      source: string;
      qualifier: readonly PostgresSyntaxIdentifier[];
      repairedDocumentRange: PostgresShapeRange;
      originalAnalysisIdentity: PostgresAnalysisIdentity;
    }
  | undefined {
  if (!isAvailableSqlExpectation(expectation)) return undefined;
  if (!sameExpectationRegion(region, expectation)) return undefined;
  if (
    expectation.fragment.form !== "none" ||
    expectation.fragment.written !== "" ||
    expectation.fragment.canonical !== "" ||
    expectation.replacementRange.start !== expectation.analysisOffset ||
    expectation.replacementRange.end !== expectation.analysisOffset
  ) {
    return undefined;
  }
  const qualifier = identifierQualifier(expectation);
  if (qualifier === undefined) return undefined;
  if (region.projection.kind !== "identity") return undefined;
  const currentRegionSource = source.slice(
    region.projection.documentRange.start,
    region.projection.documentRange.end,
  );
  if (
    region.analysisSource !== currentRegionSource ||
    !sameIdentity(region.analysisIdentity, postgresAnalysisIdentity(currentRegionSource))
  ) {
    return undefined;
  }
  if (
    expectation.analysisOffset < region.projection.analysisRange.start ||
    expectation.analysisOffset > region.projection.analysisRange.end
  ) {
    return undefined;
  }
  const relative = expectation.analysisOffset - region.projection.analysisRange.start;
  const documentCaret = region.projection.documentRange.start + relative;
  if (
    relative < 2 ||
    relative > region.projection.documentRange.end - region.projection.documentRange.start ||
    documentCaret <= region.projection.documentRange.start + 1 ||
    documentCaret > region.projection.documentRange.end ||
    documentCaret > source.length ||
    source[documentCaret - 1] !== "."
  ) {
    return undefined;
  }
  const qualifiedPrefix = `${qualifier.map((identifier) => identifier.written).join(".")}.`;
  const repairedDocumentRange = {
    start: documentCaret - qualifiedPrefix.length,
    end: documentCaret,
  };
  if (
    repairedDocumentRange.start < region.projection.documentRange.start ||
    source.slice(repairedDocumentRange.start, repairedDocumentRange.end) !== qualifiedPrefix
  ) {
    return undefined;
  }
  // Put the neutral identifier at the caret end of the equal-width span. Parser-owned scope
  // visibility then reaches the original caret instead of ending before the left padding.
  const placeholder = "x".padStart(qualifiedPrefix.length, " ");
  return {
    source: `${source.slice(0, repairedDocumentRange.start)}${placeholder}${source.slice(repairedDocumentRange.end)}`,
    qualifier,
    repairedDocumentRange,
    originalAnalysisIdentity: expectation.analysisIdentity,
  };
}

function isAvailableSqlExpectation(
  expectation: PostgresSyntaxExpectationResult,
): expectation is AvailablePostgresSqlSyntaxExpectation {
  return expectation.status === "available" && expectation.target.language === "sql";
}

function identifierQualifier(
  expectation: AvailablePostgresSqlSyntaxExpectation,
): readonly PostgresSyntaxIdentifier[] | undefined {
  return expectation.slots.find((slot) => slot.qualifier.length > 0)?.qualifier;
}

function sameExpectationRegion(
  region: PostgresLanguageRegionShape,
  expectation: AvailablePostgresSqlSyntaxExpectation,
): boolean {
  return (
    region.id === expectation.regionId &&
    region.language === "sql" &&
    region.target.status === "available" &&
    region.target.target.language === "sql" &&
    region.target.target.entryPoint === expectation.target.entryPoint &&
    region.analysisIdentity?.algorithm === expectation.analysisIdentity.algorithm &&
    region.analysisIdentity.value === expectation.analysisIdentity.value &&
    region.analysisIdentity.length === expectation.analysisIdentity.length
  );
}

function sameShapeTopology(
  original: PostgresLanguageRegionShape,
  projected: PostgresLanguageRegionShape,
): boolean {
  if (
    original.id !== projected.id ||
    original.language !== projected.language ||
    original.kind !== projected.kind ||
    original.sourceRange.start !== projected.sourceRange.start ||
    original.sourceRange.end !== projected.sourceRange.end ||
    original.projection.kind !== projected.projection.kind ||
    original.children.length !== projected.children.length ||
    original.target.status !== projected.target.status
  ) {
    return false;
  }
  if (
    original.target.status === "available" &&
    projected.target.status === "available" &&
    (original.target.target.language !== projected.target.target.language ||
      original.target.target.entryPoint !== projected.target.target.entryPoint)
  ) {
    return false;
  }
  return original.children.every((child, index) =>
    sameShapeTopology(child, projected.children[index]),
  );
}

function scopeRegionsKnown(
  originalRoot: PostgresLanguageRegionShape,
  projected: PostgresDocumentSyntaxFacts,
): boolean {
  return projected.scopes.every((scope) => regionById(originalRoot, scope.regionId) !== undefined);
}

function rangesOverlap(left: PostgresNameFact["range"], right: PostgresShapeRange): boolean {
  return left.start < right.end && right.start < left.end;
}

function sameIdentity(
  left: PostgresAnalysisIdentity | undefined,
  right: PostgresAnalysisIdentity,
): boolean {
  return (
    left?.algorithm === right.algorithm &&
    left.value === right.value &&
    left.length === right.length
  );
}

function regionById(
  region: PostgresLanguageRegionShape,
  id: string,
): PostgresLanguageRegionShape | undefined {
  if (region.id === id) return region;
  for (const child of region.children) {
    const found = regionById(child, id);
    if (found) return found;
  }
  return undefined;
}
