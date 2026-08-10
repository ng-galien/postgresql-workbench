export { CoverageInstrumentationError } from "./errors.js";
export {
  coverageMarkerPrefix,
  formatCoverageMarker,
  parseCoverageMarker,
} from "./markers.js";
export type {
  CoverageAnalysis,
  CoverageDiagnostic,
  CoveragePoint,
  CoveragePointKind,
  CoveragePointResult,
  CoverageProbePlacement,
  CoverageResult,
  InstrumentedCoverageDdl,
  InstrumentedCoverageSource,
} from "./model.js";
export type {
  PgTapAssertion,
  PgTapAssertionStatus,
  PgTapDiscovery,
  PgTapQueryClient,
  PgTapReport,
  PgTapRoutineDependencyRequest,
  PgTapRoutineDependencyResolver,
  PgTapSourceRoutine,
  PgTapTestRoutine,
} from "./pgtap.js";
export {
  DEFAULT_PGTAP_TEST_PATTERNS,
  discoverPgTapTests,
  executePgTapTest,
  matchesPgTapTestPatterns,
  parsePgTapOutput,
  resetPgTapState,
  toCoverageTestReport,
} from "./pgtap.js";
export { buildCoverageResult } from "./results.js";
export type {
  CoverageClientFactory,
  CoverageExecutionSnapshot,
  CoverageRoutine,
  CoverageRunnerState,
  CoverageRunnerStatus,
  CoverageRunRequest,
  CoverageRunResult,
  CoverageStatusListener,
  CoverageSuiteRoutineResult,
  CoverageSuiteRunRequest,
  CoverageSuiteRunResult,
  CoverageTestCaseResult,
  CoverageTestClient,
  CoverageTestReport,
} from "./runner.js";
export {
  CoverageCancelledError,
  CoverageRoutineUnavailableError,
  CoverageRunIdBusyError,
  CoverageRunner,
  CoverageRunnerError,
  CoverageTargetBusyError,
  CoverageTimeoutError,
  CoverageTransactionControlError,
  isCleanCoverageCancellation,
  PgTapUnavailableError,
} from "./runner.js";
export {
  analyzeCoverageSyntax,
  analyzeCoverageWithSyntaxParser,
} from "./syntaxAnalyzer.js";
export { instrumentCoverageSyntaxBody } from "./syntaxInstrumenter.js";
export type {
  CoverageInstrumentationRequest,
  CoverageSourceAnalysis,
  CoverageSyntaxService,
} from "./syntaxService.js";
export { createCoverageSyntaxService } from "./syntaxService.js";
