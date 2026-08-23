import crypto from "node:crypto";
import type { Client, QueryResult, QueryResultRow } from "pg";
import type { NoticeMessage } from "pg-protocol/dist/messages.js";
import { parseCoverageMarker } from "./markers.js";
import type { CoverageAnalysis, CoverageResult } from "./model.js";
import { buildCoverageResult } from "./results.js";
import type { CoverageSyntaxService } from "./syntaxService.js";

export type CoverageRunnerState =
  | "idle"
  | "preparing"
  | "transaction-open"
  | "instrumenting"
  | "running-tests"
  | "collecting"
  | "rolling-back"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed-out";

export interface CoverageRunnerStatus {
  runId: string;
  connectionId: string;
  routineOid: number;
  routineOids?: readonly number[];
  state: CoverageRunnerState;
  startedAt: number;
  backendPid?: number;
  testSchema?: string;
  routine?: {
    schema: string;
    name: string;
    identityArguments: string;
  };
  routines?: readonly {
    oid: number;
    schema: string;
    name: string;
    identityArguments: string;
  }[];
  error?: string;
}

export interface CoverageTestCaseResult {
  name: string;
  passed: boolean;
  message?: string;
}

export interface CoverageTestReport {
  passed: number;
  failed: number;
  total: number;
  tests: CoverageTestCaseResult[];
}

export interface CoverageRoutine {
  oid: number;
  schema: string;
  name: string;
  identityArguments: string;
  kind: "function" | "procedure";
  language: "plpgsql";
  ddl: string;
  body: string;
  sourceHash: string;
}

export interface CoverageRunRequest {
  connectionId: string;
  routineOid: number;
  executeTests: (client: CoverageTestClient, signal: AbortSignal) => Promise<CoverageTestReport>;
  signal?: AbortSignal;
  requirePgTap?: boolean;
  lockTimeoutMs?: number;
  timeoutMs?: number;
  testSchema?: string;
  runId?: string;
}

export interface CoverageRunResult {
  runId: string;
  routine: CoverageRoutine;
  analysis: CoverageAnalysis;
  coverage: CoverageResult;
  bodyStartLine: number;
  tests: CoverageTestReport;
  state: "completed";
  startedAt: number;
  durationMs: number;
}

export interface CoverageSuiteRunRequest {
  connectionId: string;
  routineOids: readonly number[];
  executeTests: (client: CoverageTestClient, signal: AbortSignal) => Promise<CoverageTestReport>;
  signal?: AbortSignal;
  requirePgTap?: boolean;
  lockTimeoutMs?: number;
  timeoutMs?: number;
  testSchema?: string;
  runId?: string;
}

export interface CoverageSuiteRoutineResult {
  routine: CoverageRoutine;
  analysis: CoverageAnalysis;
  coverage: CoverageResult;
  bodyStartLine: number;
}

export interface CoverageSuiteRunResult {
  runId: string;
  routines: CoverageSuiteRoutineResult[];
  tests: CoverageTestReport;
  state: "completed";
  startedAt: number;
  durationMs: number;
}

export type CoverageClientFactory = () => Promise<Client>;
export type CoverageStatusListener = (status: CoverageRunnerStatus) => void;

export interface CoverageExecutionSnapshot {
  routineOid: number;
  executions: ReadonlyMap<string, number>;
}

export interface CoverageTestClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
  runIsolated<T>(action: () => Promise<T>): Promise<T>;
  captureCoverage(): readonly CoverageExecutionSnapshot[];
}

export class CoverageRunnerError extends Error {}

export class CoverageTargetBusyError extends CoverageRunnerError {
  constructor(connectionId: string, routineOid: number) {
    super(`Coverage is already running for ${connectionId} routine OID ${routineOid}.`);
    this.name = "CoverageTargetBusyError";
  }
}

export class CoverageCancelledError extends CoverageRunnerError {
  constructor(message = "Coverage run cancelled.", options?: ErrorOptions) {
    super(message, options);
    this.name = "CoverageCancelledError";
  }
}

export function isCleanCoverageCancellation(error: unknown): error is CoverageCancelledError {
  return error instanceof CoverageCancelledError;
}

export class CoverageTimeoutError extends CoverageRunnerError {
  constructor(
    readonly timeoutMs: number,
    message = `Coverage run timed out after ${timeoutMs}ms.`,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CoverageTimeoutError";
  }
}

export class CoverageRunIdBusyError extends CoverageRunnerError {
  constructor(runId: string) {
    super(`Coverage run ID ${runId} is already active.`);
    this.name = "CoverageRunIdBusyError";
  }
}

export class CoverageTransactionControlError extends CoverageRunnerError {
  constructor() {
    super("Coverage test execution cannot issue PostgreSQL transaction-control statements.");
    this.name = "CoverageTransactionControlError";
  }
}

export class PgTapUnavailableError extends CoverageRunnerError {
  constructor() {
    super("pgTAP is not installed in the selected database.");
    this.name = "PgTapUnavailableError";
  }
}

export class CoverageRoutineUnavailableError extends CoverageRunnerError {
  constructor(oid: number, reason: string) {
    super(`Routine OID ${oid} cannot be covered: ${reason}`);
    this.name = "CoverageRoutineUnavailableError";
  }
}

interface PreparedCoverageRoutine {
  routine: CoverageRoutine;
  analysis: CoverageAnalysis;
  executions: Map<string, number>;
  markerRunId: string;
  bodyStartLine: number;
}

type AnalyzedCoverageRoutine = Omit<PreparedCoverageRoutine, "bodyStartLine">;

interface CoverageRunOutcome {
  routines: PreparedCoverageRoutine[];
  tests: CoverageTestReport;
}

interface CoverageRunContext {
  request: CoverageSuiteRunRequest;
  targetKeys: string[];
  runId: string;
  startedAt: number;
  deadline: CoverageDeadline;
  signal: AbortSignal;
  status: CoverageRunnerStatus;
  client?: Client;
  transactionOpen: boolean;
  cancellation?: CancellationHandle;
  noticeListener?: (notice: NoticeMessage) => void;
  connectionErrorListener?: (error: Error) => void;
  connectionError?: Error;
  outcome?: CoverageRunOutcome;
  failure?: unknown;
}

export class CoverageRunner {
  private readonly activeTargets = new Set<string>();
  private readonly activeRunIds = new Set<string>();
  private readonly statuses = new Map<string, CoverageRunnerStatus>();

  constructor(
    private readonly openClient: CoverageClientFactory,
    private readonly syntax: CoverageSyntaxService,
    private readonly onStatus?: CoverageStatusListener,
  ) {}

  get activeStatuses(): readonly CoverageRunnerStatus[] {
    return [...this.statuses.values()];
  }

  async run(request: CoverageRunRequest): Promise<CoverageRunResult> {
    const suite = await this.runSuite({
      ...request,
      routineOids: [request.routineOid],
    });
    const result = suite.routines[0];
    if (!result) {
      throw new CoverageRunnerError("Coverage run finished without a routine result.");
    }
    return {
      runId: suite.runId,
      ...result,
      tests: suite.tests,
      state: "completed",
      startedAt: suite.startedAt,
      durationMs: suite.durationMs,
    };
  }

  async runSuite(request: CoverageSuiteRunRequest): Promise<CoverageSuiteRunResult> {
    const context = this.admit(request);
    try {
      await this.execute(context);
    } catch (error) {
      context.failure = context.signal.aborted ? abortError(context.signal) : error;
    } finally {
      await this.cleanup(context);
    }
    return this.finish(context);
  }

  private admit(request: CoverageSuiteRunRequest): CoverageRunContext {
    const routineOids = [...new Set(request.routineOids)].sort((left, right) => left - right);
    if (routineOids.length === 0) {
      throw new CoverageRunnerError("Coverage requires at least one routine OID.");
    }
    const targetKeys = routineOids.map((oid) => `${request.connectionId}:${oid}`);
    const busyIndex = targetKeys.findIndex((targetKey) => this.activeTargets.has(targetKey));
    if (busyIndex >= 0) {
      throw new CoverageTargetBusyError(request.connectionId, routineOids[busyIndex]);
    }
    const runId = request.runId ?? crypto.randomUUID();
    if (this.activeRunIds.has(runId)) {
      throw new CoverageRunIdBusyError(runId);
    }
    const deadline = new CoverageDeadline(request.signal, request.timeoutMs ?? 300_000);
    for (const targetKey of targetKeys) this.activeTargets.add(targetKey);
    this.activeRunIds.add(runId);
    const startedAt = Date.now();
    return {
      request: { ...request, routineOids },
      targetKeys,
      runId,
      startedAt,
      deadline,
      signal: deadline.signal,
      transactionOpen: false,
      status: {
        runId,
        connectionId: request.connectionId,
        routineOid: routineOids[0],
        routineOids,
        state: "idle",
        startedAt,
        testSchema: request.testSchema,
      },
    };
  }

  private async execute(context: CoverageRunContext): Promise<void> {
    const { request, signal, runId } = context;
    this.transition(context, "preparing");
    throwIfAborted(signal);
    const clientPromise = this.openClient();
    closeLateClientAfterAbort(clientPromise, signal);
    const client = await raceWithAbort(clientPromise, signal);
    context.client = client;
    context.connectionErrorListener = (error: Error) => {
      if (!context.connectionError) context.connectionError = error;
    };
    client.on("error", context.connectionErrorListener);
    const backendPid = await queryBackendPid(client);
    context.status = { ...context.status, backendPid };
    context.cancellation = installCancellation(signal, backendPid, this.openClient, client);
    await this.openTransaction(context);

    const analyzedRoutines: AnalyzedCoverageRoutine[] = [];
    for (const routineOid of request.routineOids) {
      const routine = await queryCoverageRoutine(client, routineOid);
      const sourceAnalysis = await raceWithAbort(this.syntax.analyze(routine.body), signal);
      if (routine.kind === "procedure" && sourceAnalysis.procedureTransactionControl) {
        throw new CoverageRoutineUnavailableError(
          routine.oid,
          "procedures with transaction control require an isolated database backend",
        );
      }
      const { analysis } = sourceAnalysis;
      rejectAnalysisErrors(routine, analysis);
      analyzedRoutines.push({
        routine,
        analysis,
        executions: new Map(),
        markerRunId: `${runId}_${routine.oid}`,
      });
    }
    context.status = {
      ...context.status,
      routine: {
        schema: analyzedRoutines[0].routine.schema,
        name: analyzedRoutines[0].routine.name,
        identityArguments: analyzedRoutines[0].routine.identityArguments,
      },
      routines: analyzedRoutines.map(({ routine }) => ({
        oid: routine.oid,
        schema: routine.schema,
        name: routine.name,
        identityArguments: routine.identityArguments,
      })),
    };
    const instrumented = await raceWithAbort(
      Promise.all(
        analyzedRoutines.map(({ routine, analysis, markerRunId }) =>
          this.syntax.instrument({
            ddl: routine.ddl,
            source: routine.body,
            analysis,
            runId: markerRunId,
          }),
        ),
      ),
      signal,
    );
    const routines: PreparedCoverageRoutine[] = analyzedRoutines.map((routine, index) => {
      const source = instrumented[index];
      if (!source) throw new CoverageRunnerError("Coverage instrumentation result is incomplete.");
      return { ...routine, bodyStartLine: source.bodyStartLine };
    });
    context.noticeListener = createSuiteNoticeListener(routines);
    client.on("notice", context.noticeListener);

    this.transition(context, "instrumenting");
    throwIfAborted(signal);
    for (const source of instrumented) {
      throwIfAborted(signal);
      await client.query(source.ddl);
    }
    this.transition(context, "running-tests");
    throwIfAborted(signal);
    const tests = await raceWithAbort(
      request.executeTests(
        new TransactionBoundTestClient(client, signal, this.syntax, () =>
          routines.map(({ routine, executions }) => ({
            routineOid: routine.oid,
            executions: new Map(executions),
          })),
        ),
        signal,
      ),
      signal,
    );
    throwIfAborted(signal);
    this.transition(context, "collecting");
    context.outcome = { routines, tests };
  }

  private async openTransaction(context: CoverageRunContext): Promise<void> {
    const { client, request, signal } = context;
    if (!client) throw new CoverageRunnerError("Coverage client is not available.");
    if (request.requirePgTap !== false && !(await hasPgTap(client))) {
      throw new PgTapUnavailableError();
    }
    throwIfAborted(signal);
    await client.query("BEGIN");
    context.transactionOpen = true;
    this.transition(context, "transaction-open");
    const lockTimeoutMs = boundedTimeout(request.lockTimeoutMs ?? 2_000);
    await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
    for (const routineOid of request.routineOids) {
      const admitted = await acquireTargetLock(client, routineOid);
      if (!admitted) {
        throw new CoverageTargetBusyError(request.connectionId, routineOid);
      }
    }
  }

  private async cleanup(context: CoverageRunContext): Promise<void> {
    const { client, cancellation, noticeListener, connectionErrorListener } = context;
    if (client && noticeListener) client.removeListener("notice", noticeListener);
    cancellation?.dispose();
    const cancellationOutcome = await cancellation?.wait();
    this.applyCancellationOutcome(context, cancellationOutcome);
    if (context.transactionOpen && client) {
      this.transition(context, "rolling-back");
      await this.rollback(context);
    }
    if (client) {
      try {
        await client.end();
      } catch (closeError) {
        context.failure = combineErrors(
          context.failure,
          closeError,
          "Coverage client close failed",
        );
      }
      if (context.connectionError && context.failure === undefined) {
        context.failure = context.connectionError;
      }
      if (connectionErrorListener) client.removeListener("error", connectionErrorListener);
    }
    context.deadline.dispose();
    for (const targetKey of context.targetKeys) this.activeTargets.delete(targetKey);
    this.activeRunIds.delete(context.runId);
  }

  private applyCancellationOutcome(
    context: CoverageRunContext,
    outcome: CancellationOutcome | undefined,
  ): void {
    if (outcome?.forcedDisconnect) {
      context.transactionOpen = false;
      if (outcome.gracefulError) {
        context.failure = withForcedDisconnectDetail(context.failure, outcome.gracefulError);
      }
    }
    if (outcome?.forceError) {
      context.failure = combineErrors(
        context.failure,
        outcome.forceError,
        "Coverage cancellation and forced disconnect failed",
      );
    }
  }

  private async rollback(context: CoverageRunContext): Promise<void> {
    const { client } = context;
    if (!client) return;
    const timeoutMs = context.signal.aborted ? 500 : 3_000;
    try {
      await withTimeout(client.query("ROLLBACK"), timeoutMs, "Coverage rollback timed out");
      context.transactionOpen = false;
    } catch (rollbackError) {
      const forceOutcome = await forceTerminateOrDisconnect(
        this.openClient,
        context.status.backendPid,
        client,
      );
      if (forceOutcome.forcedDisconnect) {
        context.transactionOpen = false;
        const cause = forceOutcome.gracefulError
          ? new AggregateError(
              [rollbackError, forceOutcome.gracefulError],
              "Rollback and backend termination failed before socket disconnect",
            )
          : rollbackError;
        context.failure = withForcedDisconnectDetail(context.failure, cause);
      }
      if (forceOutcome.forceError) {
        context.failure = combineErrors(
          context.failure,
          forceOutcome.forceError,
          "Coverage rollback and forced backend cleanup failed",
        );
      } else if (!forceOutcome.forcedDisconnect) {
        context.failure = combineErrors(context.failure, rollbackError, "Coverage rollback failed");
      }
    }
  }

  private finish(context: CoverageRunContext): CoverageSuiteRunResult {
    const { failure, outcome, runId, startedAt } = context;
    if (failure) {
      this.transition(context, terminalFailureState(failure), failure);
      throw failure;
    }
    if (!outcome) {
      const error = new CoverageRunnerError("Coverage run finished without a result.");
      this.transition(context, "failed", error);
      throw error;
    }
    this.transition(context, "completed");
    return {
      runId,
      routines: outcome.routines.map(({ routine, analysis, executions, bodyStartLine }) => ({
        routine,
        analysis,
        coverage: buildCoverageResult(analysis, executions),
        bodyStartLine,
      })),
      tests: outcome.tests,
      state: "completed",
      startedAt,
      durationMs: Date.now() - startedAt,
    };
  }

  private transition(
    context: CoverageRunContext,
    state: CoverageRunnerState,
    error?: unknown,
  ): void {
    context.status = {
      ...context.status,
      state,
      error: error === undefined ? undefined : errorMessage(error),
    };
    if (isTerminal(state)) this.statuses.delete(context.runId);
    else this.statuses.set(context.runId, context.status);
    notifyStatus(this.onStatus, context.status);
  }
}

function rejectAnalysisErrors(routine: CoverageRoutine, analysis: CoverageAnalysis): void {
  const errors = analysis.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    throw new CoverageRoutineUnavailableError(
      routine.oid,
      errors.map((diagnostic) => diagnostic.message).join("; "),
    );
  }
}

function createSuiteNoticeListener(
  routines: readonly PreparedCoverageRoutine[],
): (notice: NoticeMessage) => void {
  return (notice: NoticeMessage) => {
    if (!notice.message) return;
    for (const { markerRunId, executions } of routines) {
      const marker = parseCoverageMarker(notice.message, markerRunId);
      if (!marker) continue;
      executions.set(marker.pointId, (executions.get(marker.pointId) ?? 0) + 1);
      return;
    }
  };
}

async function queryBackendPid(client: Client): Promise<number> {
  const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return Number(result.rows[0]?.pid);
}

async function hasPgTap(client: Client): Promise<boolean> {
  const result = await client.query<{ installed: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pgtap') AS installed",
  );
  return result.rows[0]?.installed ?? false;
}

async function acquireTargetLock(client: Client, oid: number): Promise<boolean> {
  const result = await client.query<{ admitted: boolean }>(
    `SELECT pg_try_advisory_xact_lock(
              1347175247,
              ($1::bigint - CASE WHEN $1::bigint > 2147483647 THEN 4294967296 ELSE 0 END)::int
            ) AS admitted`,
    [oid],
  );
  return result.rows[0]?.admitted ?? false;
}

async function queryCoverageRoutine(client: Client, oid: number): Promise<CoverageRoutine> {
  const result = await client.query<{
    oid: string;
    schema: string;
    name: string;
    identity_arguments: string;
    kind: "f" | "p";
    language: string;
    ddl: string;
    body: string;
    can_replace: boolean;
  }>(
    `SELECT p.oid::bigint::text AS oid,
            n.nspname AS schema,
            p.proname AS name,
            pg_get_function_identity_arguments(p.oid) AS identity_arguments,
            p.prokind AS kind,
            l.lanname AS language,
            pg_get_functiondef(p.oid) AS ddl,
            p.prosrc AS body,
            pg_has_role(current_user, p.proowner, 'MEMBER') AS can_replace
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_language l ON l.oid = p.prolang
      WHERE p.oid = $1::oid`,
    [oid],
  );
  const row = result.rows[0];
  if (!row) throw new CoverageRoutineUnavailableError(oid, "routine not found");
  if (row.language !== "plpgsql") {
    throw new CoverageRoutineUnavailableError(oid, `language ${row.language} is not PL/pgSQL`);
  }
  if (!row.can_replace) {
    throw new CoverageRoutineUnavailableError(oid, "the connected role does not own the routine");
  }
  return {
    oid: Number(row.oid),
    schema: row.schema,
    name: row.name,
    identityArguments: row.identity_arguments,
    kind: row.kind === "p" ? "procedure" : "function",
    language: "plpgsql",
    ddl: row.ddl,
    body: row.body,
    sourceHash: crypto.createHash("sha256").update(row.ddl).digest("hex"),
  };
}

function installCancellation(
  signal: AbortSignal | undefined,
  backendPid: number,
  openClient: CoverageClientFactory,
  targetClient: Client,
): CancellationHandle | undefined {
  if (!signal) return undefined;
  let promise: Promise<CancellationOutcome> | undefined;
  const cancel = () => {
    promise ??= cancelOrDisconnect(openClient, backendPid, targetClient);
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  return {
    wait: () => promise,
    dispose: () => signal.removeEventListener("abort", cancel),
  };
}

interface CancellationHandle {
  wait(): Promise<CancellationOutcome> | undefined;
  dispose(): void;
}

interface CancellationOutcome {
  forcedDisconnect: boolean;
  gracefulError?: unknown;
  forceError?: unknown;
}

async function cancelOrDisconnect(
  openClient: CoverageClientFactory,
  backendPid: number,
  targetClient: Client,
): Promise<CancellationOutcome> {
  try {
    await withTimeout(
      cancelBackend(openClient, backendPid),
      2_000,
      "Coverage cancellation timed out",
    );
    return { forcedDisconnect: false };
  } catch (gracefulError) {
    try {
      await withTimeout(
        terminateBackend(openClient, backendPid),
        3_000,
        "Coverage backend termination timed out",
      );
      return { forcedDisconnect: true, gracefulError };
    } catch (terminateError) {
      try {
        await withTimeout(
          targetClient.end(),
          2_000,
          "Coverage backend forced disconnect timed out",
        );
        return {
          forcedDisconnect: true,
          gracefulError: new AggregateError(
            [gracefulError, terminateError],
            "Graceful cancellation and backend termination failed",
          ),
        };
      } catch (forceError) {
        return {
          forcedDisconnect: false,
          gracefulError,
          forceError: new AggregateError(
            [terminateError, forceError],
            "Coverage backend termination and socket disconnect failed",
          ),
        };
      }
    }
  }
}

async function cancelBackend(openClient: CoverageClientFactory, backendPid: number): Promise<void> {
  const control = await openClient();
  try {
    const result = await control.query<{ cancelled: boolean }>(
      "SELECT pg_cancel_backend($1) AS cancelled",
      [backendPid],
    );
    if (!result.rows[0]?.cancelled) {
      throw new CoverageRunnerError(`PostgreSQL backend ${backendPid} could not be cancelled.`);
    }
  } finally {
    await control.end();
  }
}

async function terminateBackend(
  openClient: CoverageClientFactory,
  backendPid: number,
): Promise<void> {
  const control = await openClient();
  try {
    const result = await control.query<{ terminated: boolean }>(
      "SELECT pg_terminate_backend($1, 2000) AS terminated",
      [backendPid],
    );
    if (!result.rows[0]?.terminated) {
      throw new CoverageRunnerError(`PostgreSQL backend ${backendPid} could not be terminated.`);
    }
  } finally {
    await control.end();
  }
}

async function forceTerminateOrDisconnect(
  openClient: CoverageClientFactory,
  backendPid: number | undefined,
  targetClient: Client,
): Promise<CancellationOutcome> {
  let terminateError: unknown;
  if (backendPid !== undefined) {
    try {
      await withTimeout(
        terminateBackend(openClient, backendPid),
        3_000,
        "Coverage backend termination timed out",
      );
      return { forcedDisconnect: true };
    } catch (error) {
      terminateError = error;
    }
  }
  try {
    await withTimeout(targetClient.end(), 2_000, "Coverage backend disconnect timed out");
    return { forcedDisconnect: true, gracefulError: terminateError };
  } catch (forceError) {
    return { forcedDisconnect: false, gracefulError: terminateError, forceError };
  }
}

class TransactionBoundTestClient implements CoverageTestClient {
  private savepointSequence = 0;

  constructor(
    private readonly client: Client,
    private readonly signal: AbortSignal,
    private readonly syntax: CoverageSyntaxService,
    private readonly coverageSnapshot: () => readonly CoverageExecutionSnapshot[],
  ) {}

  captureCoverage(): readonly CoverageExecutionSnapshot[] {
    return this.coverageSnapshot();
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>> {
    throwIfAborted(this.signal);
    if (await raceWithAbort(this.syntax.containsSqlTransactionControl(text), this.signal)) {
      throw new CoverageTransactionControlError();
    }
    throwIfAborted(this.signal);
    return this.client.query<R, unknown[]>(text, values);
  }

  async runIsolated<T>(action: () => Promise<T>): Promise<T> {
    throwIfAborted(this.signal);
    this.savepointSequence++;
    const savepoint = `plpgsql_dap_coverage_test_${this.savepointSequence}`;
    await this.client.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await action();
      await this.client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await this.client.query(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new CoverageRunnerError(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function notifyStatus(
  listener: CoverageStatusListener | undefined,
  status: CoverageRunnerStatus,
): void {
  try {
    listener?.(status);
  } catch {}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

function boundedTimeout(value: number): number {
  if (!Number.isFinite(value) || value < 1 || value > 60_000) {
    throw new CoverageRunnerError(`Invalid coverage lock timeout: ${value}`);
  }
  return Math.floor(value);
}

function combineErrors(primary: unknown, cleanup: unknown, message: string): unknown {
  if (primary === undefined) return new CoverageRunnerError(`${message}: ${errorMessage(cleanup)}`);
  return new AggregateError([primary, cleanup], message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTerminal(state: CoverageRunnerState): boolean {
  return (
    state === "completed" || state === "failed" || state === "cancelled" || state === "timed-out"
  );
}

class CoverageDeadline {
  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  private readonly forwardParentAbort: (() => void) | undefined;

  constructor(
    private readonly parent: AbortSignal | undefined,
    readonly timeoutMs: number,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
      throw new CoverageRunnerError(`Invalid coverage run timeout: ${timeoutMs}`);
    }
    this.timer = setTimeout(
      () => this.controller.abort(new CoverageTimeoutError(timeoutMs)),
      Math.floor(timeoutMs),
    );
    this.forwardParentAbort = parent
      ? () => this.controller.abort(new CoverageCancelledError())
      : undefined;
    if (parent && this.forwardParentAbort) {
      parent.addEventListener("abort", this.forwardParentAbort, { once: true });
      if (parent.aborted) this.forwardParentAbort();
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  dispose(): void {
    clearTimeout(this.timer);
    if (this.parent && this.forwardParentAbort) {
      this.parent.removeEventListener("abort", this.forwardParentAbort);
    }
  }
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function closeLateClientAfterAbort(clientPromise: Promise<Client>, signal: AbortSignal): void {
  clientPromise
    .then(async (client) => {
      if (signal.aborted) await client.end();
    })
    .catch(() => {});
}

function abortError(signal: AbortSignal): CoverageRunnerError {
  return signal.reason instanceof CoverageRunnerError
    ? signal.reason
    : new CoverageCancelledError();
}

function withForcedDisconnectDetail(failure: unknown, cause: unknown): unknown {
  if (failure instanceof CoverageTimeoutError) {
    return new CoverageTimeoutError(
      failure.timeoutMs,
      `${failure.message} Graceful cancellation failed and the dedicated backend was disconnected.`,
      { cause },
    );
  }
  if (failure instanceof CoverageCancelledError) {
    return new CoverageCancelledError(
      "Coverage run cancelled; graceful cancellation failed and the dedicated backend was disconnected.",
      { cause },
    );
  }
  return failure;
}

function terminalFailureState(failure: unknown): CoverageRunnerState {
  if (failure instanceof CoverageCancelledError) return "cancelled";
  if (failure instanceof CoverageTimeoutError) return "timed-out";
  return "failed";
}
