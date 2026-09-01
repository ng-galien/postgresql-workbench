import type { Client } from "pg";
import * as vscode from "vscode";
import {
  buildCoverageResult,
  type CoverageAnalysis,
  type CoverageResult,
  type CoverageRoutine,
  CoverageRunner,
  type CoverageSuiteRoutineResult,
  type CoverageTestClient,
  type CoverageTestReport,
  coverageAsJson,
  coverageAsLcov,
  coverageDelta,
  createCoverageSyntaxService,
  type ExportedCoverageFile,
  executePgTapTest,
  indexCoverageSnapshot,
  isCleanCoverageCancellation,
  mapCoverageToSource,
  matchesCoveragePatterns,
  type PgTapReport,
  type PgTapSourceRoutine,
  type PgTapTestRoutine,
  resetPgTapState,
  toCoverageTestReport,
} from "../../../packages/coverage/src/index.js";
import { destroyClientSocket } from "../../../packages/rows/src/closingClient.js";
import type { SyntaxParser } from "../../../packages/sql/src/analysis/syntaxTree.js";
import type { ConnectionManager } from "../connection/index.js";
import { errorMessage } from "../errorMessage.js";
import { openCoverageClient } from "./client.js";

export interface PgTapCoverageTarget {
  item: vscode.TestItem;
  connectionId: string;
  test: PgTapTestRoutine;
  routine?: PgTapSourceRoutine;
  explicit: boolean;
}

export interface PgTapCoverageSnapshot {
  run: vscode.TestRun;
  files: readonly vscode.FileCoverage[];
  outcomes: ReadonlyMap<string, "passed" | "failed" | "errored" | "skipped">;
}

interface CoverageAggregate {
  symbolUri: string;
  connectionId: string;
  routine: CoverageRoutine;
  analysis: CoverageAnalysis;
  executions: Map<string, number>;
  bodyStartLine: number;
  tests: Map<string, { item: vscode.TestItem; executions: Map<string, number> }>;
}

interface CoverageFileMetadata {
  connectionId: string;
  routineOid: number;
  ddl: string;
  details: vscode.FileCoverageDetail[];
  detailsByTestId: Map<string, vscode.FileCoverageDetail[]>;
}

interface CoverageProfileSettings {
  include: string[];
  exclude: string[];
  maxRoutines: number;
  maxOutputLines: number;
  maxOutputBytes: number;
  maxParallelDatabases: number;
  timeoutMs: number;
}

interface CoverageGroupRunContext {
  run: vscode.TestRun;
  signal: AbortSignal;
  outcomes: Map<string, "passed" | "failed" | "errored" | "skipped">;
  aggregates: Map<string, CoverageAggregate>;
  settings: CoverageProfileSettings;
}

export interface PgTapCoverageProfileOptions {
  controller: vscode.TestController;
  connections: ConnectionManager;
  output: vscode.OutputChannel;
  syntaxParser: () => Promise<SyntaxParser>;
  resolveRequest: (request: vscode.TestRunRequest) => Promise<void>;
  collectTargets: (request: vscode.TestRunRequest) => PgTapCoverageTarget[];
  resolveRoutineSymbolUri: (connectionId: string, oid: number) => string | undefined;
  resolveDocumentUri: (symbolUri: string) => vscode.Uri | undefined;
}

export class PgTapCoverageProfile implements vscode.Disposable {
  readonly profile: vscode.TestRunProfile;
  private readonly fileMetadata = new WeakMap<vscode.FileCoverage, CoverageFileMetadata>();
  private readonly _onDidComplete = new vscode.EventEmitter<PgTapCoverageSnapshot>();
  private lastFiles: readonly vscode.FileCoverage[] = [];
  readonly onDidComplete = this._onDidComplete.event;
  private readonly controller: vscode.TestController;
  private readonly connections: ConnectionManager;
  private readonly output: vscode.OutputChannel;
  private readonly syntaxParser: () => Promise<SyntaxParser>;
  private readonly resolveRequest: (request: vscode.TestRunRequest) => Promise<void>;
  private readonly collectTargets: (request: vscode.TestRunRequest) => PgTapCoverageTarget[];
  private readonly resolveRoutineSymbolUri: (
    connectionId: string,
    oid: number,
  ) => string | undefined;
  private readonly resolveDocumentUri: (symbolUri: string) => vscode.Uri | undefined;

  constructor(options: PgTapCoverageProfileOptions) {
    this.controller = options.controller;
    this.connections = options.connections;
    this.output = options.output;
    this.syntaxParser = options.syntaxParser;
    this.resolveRequest = options.resolveRequest;
    this.collectTargets = options.collectTargets;
    this.resolveRoutineSymbolUri = options.resolveRoutineSymbolUri;
    this.resolveDocumentUri = options.resolveDocumentUri;
    const handler = async (
      request: vscode.TestRunRequest,
      token: vscode.CancellationToken,
    ): Promise<void> => {
      await this.run(request, token);
    };
    this.profile = this.controller.createRunProfile(
      "Run pgTAP Tests with Coverage",
      vscode.TestRunProfileKind.Coverage,
      handler,
      true,
    );
    this.profile.loadDetailedCoverage = (run, file, token) => this.loadDetails(run, file, token);
    this.profile.loadDetailedCoverageForTest = (run, file, test, token) =>
      this.loadDetailsForTest(run, file, test, token);
  }

  dispose(): void {
    this.profile.dispose();
    this._onDidComplete.dispose();
  }

  invalidate(): void {
    this.lastFiles = [];
  }

  async exportLastCoverage(): Promise<boolean> {
    const exportFiles: ExportedCoverageFile[] = [];
    const validation = new vscode.CancellationTokenSource();
    try {
      for (const file of this.lastFiles) {
        const metadata = this.fileMetadata.get(file);
        if (!metadata) continue;
        await assertSourceCurrent(this.connections, metadata, validation.token);
        exportFiles.push(toExportedCoverage(file, metadata.details));
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Coverage export is stale: ${errorMessage(error)}`);
      this.invalidate();
      return false;
    } finally {
      validation.dispose();
    }
    if (exportFiles.length === 0) {
      await vscode.window.showInformationMessage("Run pgTAP tests with coverage before exporting.");
      return false;
    }
    const format = await vscode.window.showQuickPick(
      [
        { label: "LCOV", description: "Compatible with common coverage tools", extension: "lcov" },
        { label: "JSON", description: "PL/pgSQL coverage details", extension: "json" },
      ],
      { placeHolder: "Coverage export format" },
    );
    if (!format) return false;
    const defaultUri = vscode.workspace.workspaceFolders?.[0]
      ? vscode.Uri.joinPath(
          vscode.workspace.workspaceFolders[0].uri,
          `postgresql-workbench-coverage.${format.extension}`,
        )
      : undefined;
    const destination = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { [format.label]: [format.extension] },
      saveLabel: "Export Coverage",
    });
    if (!destination) return false;
    const content =
      format.label === "LCOV" ? coverageAsLcov(exportFiles) : coverageAsJson(exportFiles);
    await vscode.workspace.fs.writeFile(destination, new TextEncoder().encode(content));
    return true;
  }

  async run(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    const run = this.controller.createTestRun(request, "PL/pgSQL Coverage");
    const outcomes = new Map<string, "passed" | "failed" | "errored" | "skipped">();
    const aggregates = new Map<string, CoverageAggregate>();
    const files: vscode.FileCoverage[] = [];
    const abort = new AbortController();
    const settings = readCoverageSettings();
    const cancellationTokens = [token, run.token];
    const cancellationSubscriptions = cancellationTokens.map((candidate) =>
      candidate.onCancellationRequested(() => abort.abort(new Error("Coverage run cancelled."))),
    );
    if (cancellationTokens.some((candidate) => candidate.isCancellationRequested)) {
      abort.abort(new Error("Coverage run cancelled."));
    }
    try {
      await this.resolveRequest(request);
      const targets = this.collectTargets(request);
      for (const target of targets) run.enqueued(target.item);
      const runnableTargets: Array<PgTapCoverageTarget & { routine: PgTapSourceRoutine }> = [];
      for (const target of targets) {
        if (abort.signal.aborted) {
          run.skipped(target.item);
          outcomes.set(target.item.id, "skipped");
          continue;
        }
        if (!target.test.runnable || !target.routine) {
          const message = !target.test.runnable
            ? `Requires arguments: ${target.test.identityArguments}`
            : "No PL/pgSQL source routine is mapped to this pgTAP test.";
          if (target.explicit) {
            run.errored(target.item, new vscode.TestMessage(message));
            outcomes.set(target.item.id, "errored");
          } else {
            run.skipped(target.item);
            outcomes.set(target.item.id, "skipped");
          }
          continue;
        }
        if (!matchesCoveragePatterns(target.routine, settings.include, settings.exclude)) {
          run.skipped(target.item);
          outcomes.set(target.item.id, "skipped");
          continue;
        }
        runnableTargets.push({ ...target, routine: target.routine });
      }
      const routineCount = new Set(
        runnableTargets.flatMap(({ connectionId, test }) =>
          test.sourceRoutines
            .filter((routine) =>
              matchesCoveragePatterns(routine, settings.include, settings.exclude),
            )
            .map((routine) => `${connectionId}:${routine.oid}`),
        ),
      ).size;
      if (routineCount > settings.maxRoutines) {
        const message = `Coverage selection contains ${routineCount} routines; the configured limit is ${settings.maxRoutines}.`;
        for (const { item } of runnableTargets) {
          run.errored(item, new vscode.TestMessage(message));
          outcomes.set(item.id, "errored");
        }
        runnableTargets.length = 0;
        this.output.appendLine(`[Coverage] ${message}`);
      }
      const targetsByConnection = groupTargetsByConnection(runnableTargets);
      await runBounded(
        [...targetsByConnection.values()],
        settings.maxParallelDatabases,
        async (connectionTargets) => {
          if (abort.signal.aborted) {
            for (const { item } of connectionTargets) {
              run.skipped(item);
              outcomes.set(item.id, "skipped");
            }
            return;
          }
          await this.runTargetGroup(connectionTargets, {
            run,
            signal: abort.signal,
            outcomes,
            aggregates,
            settings,
          });
        },
      );
      for (const aggregate of aggregates.values()) {
        const file = this.publishCoverage(run, aggregate);
        files.push(file);
      }
    } finally {
      for (const subscription of cancellationSubscriptions) {
        subscription.dispose();
      }
      run.end();
      this.lastFiles = files;
      this._onDidComplete.fire({ run, files, outcomes });
    }
  }

  private async runTargetGroup(
    targets: Array<PgTapCoverageTarget & { routine: PgTapSourceRoutine }>,
    context: CoverageGroupRunContext,
  ): Promise<void> {
    const { run, signal, outcomes, aggregates, settings } = context;
    const startedAt = Date.now();
    for (const { item } of targets) run.started(item);
    const first = targets[0];
    if (!first) return;
    const tests = [...new Map(targets.map(({ test }) => [test.oid, test])).values()];
    const routineOids = [
      ...new Set(
        targets.flatMap(({ test }) =>
          test.sourceRoutines
            .filter((routine) =>
              matchesCoveragePatterns(routine, settings.include, settings.exclude),
            )
            .map(({ oid }) => oid),
        ),
      ),
    ];
    const reports = new Map<number, PgTapReport>();
    const testErrors = new Map<number, unknown>();
    const testExecutions = new Map<number, Map<number, Map<string, number>>>();
    try {
      const syntax = createCoverageSyntaxService(() => this.syntaxParser());
      const runner = new CoverageRunner(
        () =>
          openCoverageClient(this.connections, first.connectionId, {
            applicationName: "postgresql-workbench:coverage-runner",
            statementTimeoutMs: 0,
          }),
        syntax,
      );
      const result = await runner.runSuite({
        connectionId: first.connectionId,
        routineOids,
        testSchema: [...new Set(tests.map(({ schema }) => schema))].join(", "),
        signal,
        timeoutMs: settings.timeoutMs,
        executeTests: (client) =>
          executeTestSuite(client, tests, settings, reports, testErrors, testExecutions),
      });
      for (const routine of result.routines) {
        const symbolUri = this.resolveRoutineSymbolUri(first.connectionId, routine.routine.oid);
        if (!symbolUri) {
          throw new Error(
            `Code Moniker identity is missing for ${routine.routine.schema}.${routine.routine.name}(${routine.routine.identityArguments}).`,
          );
        }
        mergeCoverage(aggregates, first.connectionId, symbolUri, routine);
      }
      for (const target of targets) {
        for (const routine of target.test.sourceRoutines.filter((candidate) =>
          matchesCoveragePatterns(candidate, settings.include, settings.exclude),
        )) {
          const symbolUri = this.resolveRoutineSymbolUri(target.connectionId, routine.oid);
          const aggregate = symbolUri ? aggregates.get(symbolUri) : undefined;
          const executions = testExecutions.get(target.test.oid)?.get(routine.oid);
          if (aggregate && executions) {
            aggregate.tests.set(target.item.id, { item: target.item, executions });
          }
        }
        const testError = testErrors.get(target.test.oid);
        if (testError) {
          run.errored(
            target.item,
            new vscode.TestMessage(errorMessage(testError)),
            Date.now() - startedAt,
          );
          outcomes.set(target.item.id, "errored");
          continue;
        }
        const report = reports.get(target.test.oid);
        if (!report)
          throw new Error(`pgTAP test OID ${target.test.oid} completed without a report.`);
        appendTapOutput(run, target.item, report, settings.maxOutputLines);
        markReport(run, target.item, report, Date.now() - startedAt, outcomes);
      }
    } catch (error) {
      for (const target of targets) {
        if (isCleanCoverageCancellation(error)) {
          run.skipped(target.item);
          outcomes.set(target.item.id, "skipped");
        } else {
          run.errored(
            target.item,
            new vscode.TestMessage(errorMessage(error)),
            Date.now() - startedAt,
          );
          outcomes.set(target.item.id, "errored");
        }
      }
      this.output.appendLine(
        `[Coverage] Suite on ${first.connectionId} for ${routineOids.length} routine(s): ${errorMessage(error)}`,
      );
    }
  }

  private publishCoverage(run: vscode.TestRun, aggregate: CoverageAggregate): vscode.FileCoverage {
    const coverage = buildCoverageResult(aggregate.analysis, aggregate.executions);
    const uri = this.resolveDocumentUri(aggregate.symbolUri);
    if (!uri) {
      throw new Error(`Missing PostgreSQL source presentation for ${aggregate.symbolUri}`);
    }
    const details = toNativeDetails(aggregate.routine.ddl, aggregate.bodyStartLine, coverage);
    const counts = vscode.FileCoverage.fromDetails(uri, details);
    const includedTests = [...aggregate.tests.values()].map(({ item }) => item);
    const file = new vscode.FileCoverage(
      uri,
      counts.statementCoverage,
      counts.branchCoverage,
      counts.declarationCoverage,
      includedTests,
    );
    const detailsByTestId = new Map(
      [...aggregate.tests.entries()].map(([testId, test]) => [
        testId,
        toNativeDetails(
          aggregate.routine.ddl,
          aggregate.bodyStartLine,
          buildCoverageResult(aggregate.analysis, test.executions),
        ),
      ]),
    );
    this.fileMetadata.set(file, {
      connectionId: aggregate.connectionId,
      routineOid: aggregate.routine.oid,
      ddl: aggregate.routine.ddl,
      details,
      detailsByTestId,
    });
    run.addCoverage(file);
    const branchCoverage = file.branchCoverage;
    this.output.appendLine(
      `[Coverage] ${aggregate.routine.schema}.${aggregate.routine.name}(${aggregate.routine.identityArguments}): ${file.statementCoverage.covered}/${file.statementCoverage.total} statements, ${branchCoverage?.covered ?? 0}/${branchCoverage?.total ?? 0} branches`,
    );
    return file;
  }

  private async loadDetails(
    _run: vscode.TestRun,
    file: vscode.FileCoverage,
    token: vscode.CancellationToken,
  ): Promise<vscode.FileCoverageDetail[]> {
    const metadata = this.fileMetadata.get(file);
    if (!metadata) throw new Error("Coverage details are no longer available.");
    await assertSourceCurrent(this.connections, metadata, token);
    return metadata.details;
  }

  private async loadDetailsForTest(
    _run: vscode.TestRun,
    file: vscode.FileCoverage,
    test: vscode.TestItem,
    token: vscode.CancellationToken,
  ): Promise<vscode.FileCoverageDetail[]> {
    const metadata = this.fileMetadata.get(file);
    if (!metadata) throw new Error("Coverage details are no longer available.");
    const details = metadata.detailsByTestId.get(test.id);
    if (!details) throw new Error(`Test ${test.label} did not generate coverage for this routine.`);
    await assertSourceCurrent(this.connections, metadata, token);
    return details;
  }
}

function groupTargetsByConnection(
  targets: Array<PgTapCoverageTarget & { routine: PgTapSourceRoutine }>,
): Map<string, Array<PgTapCoverageTarget & { routine: PgTapSourceRoutine }>> {
  const groups = new Map<string, Array<PgTapCoverageTarget & { routine: PgTapSourceRoutine }>>();
  for (const target of targets) {
    const group = groups.get(target.connectionId) ?? [];
    group.push(target);
    groups.set(target.connectionId, group);
  }
  return groups;
}

// The six logical parameters are over-counted because nested Map type arguments contain commas.
// code-moniker: ignore[code-single-responsibility-flags-long-parameter-lists]
async function executeTestSuite(
  client: CoverageTestClient,
  tests: readonly PgTapTestRoutine[],
  settings: CoverageProfileSettings,
  reports: Map<number, PgTapReport>,
  testErrors: Map<number, unknown>,
  testExecutions: Map<number, Map<number, Map<string, number>>>,
): Promise<CoverageTestReport> {
  const testReports: CoverageTestReport[] = [];
  let previous = indexCoverageSnapshot(client.captureCoverage());
  for (const test of tests) {
    try {
      const report = await client.runIsolated(async () => {
        const executed = await executePgTapTest(
          client,
          test,
          settings.maxOutputLines,
          settings.maxOutputBytes,
        );
        await resetPgTapState(client);
        return executed;
      });
      reports.set(test.oid, report);
      testReports.push(toCoverageTestReport(report));
    } catch (error) {
      testErrors.set(test.oid, error);
      testReports.push({
        passed: 0,
        failed: 1,
        total: 1,
        tests: [
          {
            name: `${test.schema}.${test.name}`,
            passed: false,
            message: errorMessage(error),
          },
        ],
      });
    } finally {
      const current = indexCoverageSnapshot(client.captureCoverage());
      testExecutions.set(test.oid, coverageDelta(previous, current));
      previous = current;
    }
  }
  return {
    passed: testReports.reduce((sum, report) => sum + report.passed, 0),
    failed: testReports.reduce((sum, report) => sum + report.failed, 0),
    total: testReports.reduce((sum, report) => sum + report.total, 0),
    tests: testReports.flatMap((report) => report.tests),
  };
}

function mergeCoverage(
  aggregates: Map<string, CoverageAggregate>,
  connectionId: string,
  symbolUri: string,
  result: CoverageSuiteRoutineResult,
): void {
  const existing = aggregates.get(symbolUri);
  if (!existing) {
    aggregates.set(symbolUri, {
      symbolUri,
      connectionId,
      routine: result.routine,
      analysis: result.analysis,
      bodyStartLine: result.bodyStartLine,
      executions: new Map(
        result.coverage.points.map(({ point, executed }) => [point.id, executed]),
      ),
      tests: new Map(),
    });
    return;
  }
  if (existing.routine.sourceHash !== result.routine.sourceHash) {
    throw new Error(
      `Routine ${result.routine.schema}.${result.routine.name} changed during the coverage run.`,
    );
  }
  if (existing.bodyStartLine !== result.bodyStartLine) {
    throw new Error(
      `Routine ${result.routine.schema}.${result.routine.name} changed its source mapping during the coverage run.`,
    );
  }
  for (const { point, executed } of result.coverage.points) {
    existing.executions.set(point.id, (existing.executions.get(point.id) ?? 0) + executed);
  }
}

function toNativeDetails(
  ddl: string,
  bodyStartLine: number,
  coverage: CoverageResult,
): vscode.FileCoverageDetail[] {
  const mapped = mapCoverageToSource(bodyStartLine, coverage);
  const lines = ddl.split(/\r?\n/);
  return mapped.statements.map((statement) => {
    const location = statementRange(lines, statement.line, statement.endLine);
    const branches = statement.branches.map(
      (branch) =>
        new vscode.BranchCoverage(branch.executed, lineRange(lines, branch.line), branch.label),
    );
    return new vscode.StatementCoverage(statement.executed, location, branches);
  });
}

function statementRange(
  lines: readonly string[],
  requestedStartLine: number,
  requestedEndLine: number,
): vscode.Range {
  const lastLine = Math.max(0, lines.length - 1);
  const startLine = Math.max(0, Math.min(requestedStartLine, lastLine));
  const endLine = Math.max(startLine, Math.min(requestedEndLine, lastLine));
  return new vscode.Range(startLine, 0, endLine, lines[endLine]?.length ?? 0);
}

function lineRange(lines: readonly string[], requestedLine: number): vscode.Range {
  const line = Math.max(0, Math.min(requestedLine, Math.max(0, lines.length - 1)));
  return new vscode.Range(line, 0, line, lines[line]?.length ?? 0);
}

function toExportedCoverage(
  file: vscode.FileCoverage,
  details: readonly vscode.FileCoverageDetail[],
): ExportedCoverageFile {
  const statements = details.flatMap((detail) => {
    if (!(detail instanceof vscode.StatementCoverage)) return [];
    return [
      {
        line: coverageLocationLine(detail.location),
        executed: Number(detail.executed),
        branches: detail.branches.map((branch) => ({
          line: coverageLocationLine(branch.location ?? detail.location),
          executed: Number(branch.executed),
          label: branch.label,
        })),
      },
    ];
  });
  return { uri: file.uri.toString(), statements };
}

function coverageLocationLine(location: vscode.Position | vscode.Range): number {
  return location instanceof vscode.Range ? location.start.line : location.line;
}

function markReport(
  run: vscode.TestRun,
  item: vscode.TestItem,
  report: PgTapReport,
  durationMs: number,
  outcomes: Map<string, "passed" | "failed" | "errored" | "skipped">,
): void {
  if (!report.valid) {
    run.errored(
      item,
      report.errors.map((message) => new vscode.TestMessage(message)),
      durationMs,
    );
    outcomes.set(item.id, "errored");
  } else if (report.failed > 0) {
    run.failed(
      item,
      report.assertions
        .filter(({ status }) => status === "failed")
        .map(
          (assertion) => new vscode.TestMessage(assertion.message ?? `${assertion.name} failed`),
        ),
      durationMs,
    );
    outcomes.set(item.id, "failed");
  } else {
    run.passed(item, durationMs);
    outcomes.set(item.id, "passed");
  }
}

function appendTapOutput(
  run: vscode.TestRun,
  item: vscode.TestItem,
  report: PgTapReport,
  maxLines: number,
): void {
  const lines = report.output.slice(0, maxLines);
  const suffix =
    report.truncated || report.output.length > lines.length ? "\r\n… output truncated" : "";
  run.appendOutput(`${lines.join("\r\n")}${suffix}\r\n`, undefined, item);
}

function readCoverageSettings(): CoverageProfileSettings {
  const configuration = vscode.workspace.getConfiguration("postgresql-workbench.coverage");
  return {
    include: configuration.get<string[]>("include", []),
    exclude: configuration.get<string[]>("exclude", []),
    maxRoutines: configuration.get<number>("maxRoutines", 200),
    maxOutputLines: configuration.get<number>("maxOutputLines", 200),
    maxOutputBytes: configuration.get<number>("maxOutputBytes", 1_048_576),
    maxParallelDatabases: configuration.get<number>("maxParallelDatabases", 2),
    timeoutMs: configuration.get<number>("timeoutMs", 300_000),
  };
}

async function runBounded<T>(
  values: readonly T[],
  concurrency: number,
  action: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next;
      next++;
      await action(values[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, () => worker()),
  );
}

async function assertSourceCurrent(
  connections: ConnectionManager,
  metadata: CoverageFileMetadata,
  token: vscode.CancellationToken,
): Promise<void> {
  if (token.isCancellationRequested) throw new Error("Coverage detail loading cancelled.");
  const client = await openClientWithCancellation(
    () =>
      openCoverageClient(connections, metadata.connectionId, {
        applicationName: "postgresql-workbench:coverage-details",
        statementTimeoutMs: 10_000,
      }),
    token,
  );
  const cancellation = token.onCancellationRequested(() => destroyClientSocket(client));
  try {
    const result = await client.query<{ ddl: string }>(
      "SELECT pg_catalog.pg_get_functiondef($1::oid) AS ddl",
      [metadata.routineOid],
    );
    const currentDdl = result.rows[0]?.ddl;
    if (!currentDdl) throw new Error("The covered PL/pgSQL routine no longer exists.");
    if (currentDdl !== metadata.ddl) {
      throw new Error("The deployed PL/pgSQL routine changed after coverage was collected.");
    }
  } finally {
    cancellation.dispose();
    await client.end().catch(() => destroyClientSocket(client));
  }
}

async function openClientWithCancellation(
  openClient: () => Promise<Client>,
  token: vscode.CancellationToken,
): Promise<Client> {
  const pending = openClient();
  let rejectCancellation: ((error: Error) => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
  });
  const subscription = token.onCancellationRequested(() => {
    pending.then((client) => client.end().catch(() => destroyClientSocket(client))).catch(() => {});
    rejectCancellation?.(new Error("Coverage detail loading cancelled."));
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    subscription.dispose();
  }
}
