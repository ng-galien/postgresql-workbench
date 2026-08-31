import { postgresCompletionSyntaxFacts } from "../analysis/completionProjection.js";
import { type PostgresLanguageRegionShape, postgresCaretShape } from "../analysis/documentShape.js";
import { POSTGRES_SQL_KEYWORD_SOURCE } from "../analysis/postgresKeywordCatalog.js";
import { postgresAnalysisIdentity } from "../analysis/postgresSyntax.js";
import type { PostgresSyntaxExpectationProvider } from "../analysis/syntaxExpectations.js";
import { DEFAULT_POSTGRES_SYNTAX_PREDICTION_BUDGET } from "../analysis/syntaxExpectations.js";
import type { SyntaxLanguage } from "../analysis/syntaxTree.js";
import { type PostgresCompletionPlan, planPostgresCompletion } from "../authoring/completion.js";
import type { SqlAuthoringSnapshot } from "../snapshot.js";
import type { SqlAuthoringHostServices } from "./hostServices.js";

export interface SqlAuthoringCompletionRequest {
  uri: string;
  source: string;
  language: SyntaxLanguage;
  offset: number;
  snapshot: SqlAuthoringSnapshot;
  limit?: number;
}

/** Complete transport-neutral completion orchestration shared by every LSP host and its tests. */
export async function planSqlAuthoringCompletionRequest(
  request: SqlAuthoringCompletionRequest,
  host: Pick<SqlAuthoringHostServices, "syntax">,
  expectations: PostgresSyntaxExpectationProvider,
): Promise<PostgresCompletionPlan> {
  const syntax = await host.syntax({
    uri: request.uri,
    source: request.source,
    language: request.language,
  });
  if (!syntax.facts) return unavailable("shape-truncated");
  const root = syntax.facts.shape.root;
  if (root.language !== request.language) return unavailable("region-language-mismatch");
  if (
    root.sourceRange.start !== 0 ||
    root.sourceRange.end !== request.source.length ||
    !regionMatchesSource(root, request.source)
  ) {
    return unavailable("analysis-identity-mismatch");
  }
  const caret = postgresCaretShape(syntax.facts.shape, request.offset);
  if (caret?.status !== "projected") return unavailable("invalid-analysis-range");
  const region = syntaxRegionById(syntax.facts.shape.root, caret.regionId);
  if (
    region?.target.status !== "available" ||
    region.analysisSource === undefined ||
    region.analysisIdentity === undefined
  ) {
    return unavailable("region-unprojectable");
  }
  if (!regionMatchesSource(region, request.source)) {
    return unavailable("analysis-identity-mismatch");
  }
  const expectationRequest = {
    regionId: region.id,
    dialect: {
      postgresMajor: Number.parseInt(POSTGRES_SQL_KEYWORD_SOURCE.postgresVersion, 10),
    },
    budget: DEFAULT_POSTGRES_SYNTAX_PREDICTION_BUDGET,
    analysisSource: region.analysisSource,
    analysisIdentity: region.analysisIdentity,
    analysisOffset: caret.analysisOffset,
  };
  const expectation =
    region.target.target.language === "sql"
      ? await expectations.expectedSyntax({ ...expectationRequest, target: region.target.target })
      : await expectations.expectedSyntax({ ...expectationRequest, target: region.target.target });
  const facts = await postgresCompletionSyntaxFacts(
    request.source,
    syntax.facts,
    region,
    expectation,
    (projectedSource) =>
      host.syntax({ uri: request.uri, source: projectedSource, language: request.language }),
  );
  if (!facts) return unavailable("region-syntax-error");
  return planPostgresCompletion({
    expectation,
    snapshot: request.snapshot,
    facts,
    ...(request.limit === undefined ? {} : { limit: request.limit }),
  });
}

function regionMatchesSource(region: PostgresLanguageRegionShape, source: string): boolean {
  if (
    region.projection.kind !== "identity" ||
    region.analysisSource === undefined ||
    region.analysisIdentity === undefined
  ) {
    return false;
  }
  const current = source.slice(
    region.projection.documentRange.start,
    region.projection.documentRange.end,
  );
  const identity = postgresAnalysisIdentity(current);
  return (
    region.analysisSource === current &&
    region.analysisIdentity.algorithm === identity.algorithm &&
    region.analysisIdentity.value === identity.value &&
    region.analysisIdentity.length === identity.length
  );
}

function syntaxRegionById(
  root: PostgresLanguageRegionShape,
  id: string,
): PostgresLanguageRegionShape | undefined {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = syntaxRegionById(child, id);
    if (found) return found;
  }
  return undefined;
}

function unavailable(
  reason: Extract<PostgresCompletionPlan, { status: "unavailable" }>["reason"],
): PostgresCompletionPlan {
  return { status: "unavailable", reason, proposals: [], isIncomplete: false };
}
