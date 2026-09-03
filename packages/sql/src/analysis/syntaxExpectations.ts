import type { PlpgsqlKeywordLabel, PostgresSqlKeywordLabel } from "./postgresKeywordCatalog.js";
import type {
  PlpgsqlSyntaxTarget,
  PostgresAnalysisIdentity,
  PostgresShapeRange,
  PostgresSqlSyntaxTarget,
  PostgresSyntaxTarget,
} from "./postgresSyntax.js";

export type {
  PlpgsqlSyntaxTarget,
  PostgresSqlSyntaxTarget,
  PostgresSyntaxTarget,
} from "./postgresSyntax.js";

export interface PostgresSyntaxDialect {
  postgresMajor: number;
}

export interface PostgresSyntaxPredictionBudget {
  /** Maximum UTF-8 bytes accepted from `analysisSource`. */
  maxSourceBytes: number;
  /** Maximum PostgreSQL scanner tokens consumed before the caret. */
  maxTokens: number;
  /** Maximum LR shift/reduce actions used to establish one expectation. */
  maxParserActions: number;
}

/** Shared stateless predictor budget used by every LSP host unless application policy overrides it. */
export const DEFAULT_POSTGRES_SYNTAX_PREDICTION_BUDGET: PostgresSyntaxPredictionBudget = {
  maxSourceBytes: 1_048_576,
  maxTokens: 10_000,
  maxParserActions: 250_000,
};

/**
 * Exact upstream inputs behind one prediction. Digests are content digests, not package versions:
 * the result remains auditable even when a provider package is rebuilt.
 */
export interface PostgresSyntaxAuthority {
  postgresRef: string;
  generator: { name: "gnu-bison"; version: string };
  grammarDigest: string;
  scannerDigest: string;
  keywordDigest: string;
  /** Digest of the generated predictive automaton, independent from PostgreSQL's source files. */
  predictorDigest: string;
  /** Digest of the versioned grammar-role and semantic-slot projection. */
  projectionDigest: string;
}

/** Identifier text already classified and folded by the syntax provider's PostgreSQL scanner. */
export interface PostgresSyntaxIdentifier {
  written: string;
  canonical: string;
  quoted: boolean;
}

export interface PostgresSyntaxFragment {
  written: string;
  canonical: string;
  form: "none" | "unquoted-identifier" | "quoted-identifier" | "keyword";
}

export interface PostgresSqlExpectedKeyword {
  language: "sql";
  kind: "keyword";
  label: PostgresSqlKeywordLabel;
}

export interface PlpgsqlExpectedKeyword {
  language: "plpgsql";
  kind: "keyword";
  label: PlpgsqlKeywordLabel;
}

export type PostgresSqlSyntaxSlotKind =
  | "schema"
  | "relation"
  | "column"
  | "routine"
  | "type"
  | "cte"
  | "window"
  | "alias"
  | "binding";
export type PlpgsqlSyntaxSlotKind = "variable" | "parameter" | "type";

interface PostgresSqlSyntaxSlotBase {
  language: "sql";
  /** Identifier parts before the fragment, as classified by the provider. */
  qualifier: readonly PostgresSyntaxIdentifier[];
}

export type PostgresSqlSyntaxSlot =
  | (PostgresSqlSyntaxSlotBase & {
      slot: Exclude<PostgresSqlSyntaxSlotKind, "routine">;
    })
  | (PostgresSqlSyntaxSlotBase & {
      slot: "routine";
      invocation: "function" | "procedure";
    });

export interface PlpgsqlSyntaxSlot {
  language: "plpgsql";
  slot: PlpgsqlSyntaxSlotKind;
  /** Labels and record qualifiers are syntax facts; their resolution remains application work. */
  qualifier: readonly PostgresSyntaxIdentifier[];
}

export interface PostgresSyntaxExpectationRequestFor<TTarget extends PostgresSyntaxTarget> {
  regionId: string;
  target: TTarget;
  dialect: PostgresSyntaxDialect;
  budget: PostgresSyntaxPredictionBudget;
  analysisSource: string;
  analysisIdentity: PostgresAnalysisIdentity;
  /** UTF-16 offset in `analysisSource`, matching LSP and Monaco offsets. */
  analysisOffset: number;
}

export type PostgresSyntaxExpectationRequest =
  | PostgresSyntaxExpectationRequestFor<PostgresSqlSyntaxTarget>
  | PostgresSyntaxExpectationRequestFor<PlpgsqlSyntaxTarget>;

interface AvailableSyntaxExpectationBase<TTarget extends PostgresSyntaxTarget> {
  status: "available";
  regionId: string;
  target: TTarget;
  authority: PostgresSyntaxAuthority;
  /** Must identify the exact request source used to produce this expectation. */
  analysisIdentity: PostgresAnalysisIdentity;
  /** UTF-16 caret offset in the same `analysisSource` used for the request. */
  analysisOffset: number;
  /** UTF-16 range in the region's `analysisSource`; the provider scanner owns this decision. */
  replacementRange: PostgresShapeRange;
  fragment: PostgresSyntaxFragment;
}

export interface AvailablePostgresSqlSyntaxExpectation<
  TTarget extends PostgresSqlSyntaxTarget = PostgresSqlSyntaxTarget,
> extends AvailableSyntaxExpectationBase<TTarget> {
  /** Suggestible keyword projection of the exact provider grammar state. */
  keywords: readonly PostgresSqlExpectedKeyword[];
  slots: readonly PostgresSqlSyntaxSlot[];
}

export interface AvailablePlpgsqlSyntaxExpectation<
  TTarget extends PlpgsqlSyntaxTarget = PlpgsqlSyntaxTarget,
> extends AvailableSyntaxExpectationBase<TTarget> {
  /** Suggestible keyword projection of the exact provider grammar state. */
  keywords: readonly PlpgsqlExpectedKeyword[];
  slots: readonly PlpgsqlSyntaxSlot[];
}

export type AvailablePostgresSyntaxExpectation =
  | AvailablePostgresSqlSyntaxExpectation
  | AvailablePlpgsqlSyntaxExpectation;

export type PostgresSyntaxAmbiguityReason =
  | "parser-recovery"
  | "non-local-state"
  | "lexical-ambiguity"
  | "grammar-dialect-mismatch";

export type PostgresSyntaxUnavailableReason =
  | "unsupported-entry-point"
  | "unprojectable-region"
  | "truncated"
  | "provider-capability-missing";

interface UnusableSyntaxExpectationBase<TTarget extends PostgresSyntaxTarget> {
  regionId: string;
  target: TTarget;
}

export interface AmbiguousPostgresSyntaxExpectation<TTarget extends PostgresSyntaxTarget>
  extends UnusableSyntaxExpectationBase<TTarget> {
  status: "ambiguous";
  reason: PostgresSyntaxAmbiguityReason;
}

export interface UnavailablePostgresSyntaxExpectation<TTarget extends PostgresSyntaxTarget>
  extends UnusableSyntaxExpectationBase<TTarget> {
  status: "unavailable";
  reason: PostgresSyntaxUnavailableReason;
}

/** `ambiguous` and `unavailable` deliberately cannot carry keywords or semantic slots. */
export type AvailablePostgresSyntaxExpectationFor<TTarget extends PostgresSyntaxTarget> =
  TTarget extends PostgresSqlSyntaxTarget
    ? AvailablePostgresSqlSyntaxExpectation<TTarget>
    : TTarget extends PlpgsqlSyntaxTarget
      ? AvailablePlpgsqlSyntaxExpectation<TTarget>
      : never;

export type PostgresSyntaxExpectationResultFor<TTarget extends PostgresSyntaxTarget> =
  | AvailablePostgresSyntaxExpectationFor<TTarget>
  | AmbiguousPostgresSyntaxExpectation<TTarget>
  | UnavailablePostgresSyntaxExpectation<TTarget>;

export type PostgresSyntaxExpectationResult =
  PostgresSyntaxExpectationResultFor<PostgresSyntaxTarget>;

/** Autonomous Workbench port implemented by the published syntax provider. */
export interface PostgresSyntaxExpectationProvider {
  expectedSyntax<TTarget extends PostgresSyntaxTarget>(
    request: PostgresSyntaxExpectationRequestFor<TTarget>,
  ): Promise<PostgresSyntaxExpectationResultFor<TTarget>>;
}

/** Honest capability result used until an installed provider exposes predictive syntax. */
export const unavailablePostgresSyntaxExpectationProvider: PostgresSyntaxExpectationProvider = {
  async expectedSyntax(request) {
    return {
      status: "unavailable",
      regionId: request.regionId,
      target: request.target,
      reason: "provider-capability-missing",
    };
  },
};
