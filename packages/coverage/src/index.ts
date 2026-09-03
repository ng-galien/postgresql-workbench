export {
  coverageAsJson,
  coverageAsLcov,
  type ExportedCoverageFile,
} from "./coverageReport.js";
export { coverageDelta, indexCoverageSnapshot } from "./delta.js";
export { mapCoverageToSource, mapPlpgsqlBodyLineToSource } from "./mapToSource.js";
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
export { matchesCoveragePatterns } from "./selection.js";
export type {
  CoverageInstrumentationRequest,
  CoverageSourceAnalysis,
  CoverageSyntaxService,
} from "./syntaxService.js";
export { createCoverageSyntaxService } from "./syntaxService.js";
