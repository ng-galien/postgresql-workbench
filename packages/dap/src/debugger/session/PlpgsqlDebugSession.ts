import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BreakpointEvent,
  Event,
  InitializedEvent,
  LoggingDebugSession,
  OutputEvent,
  Scope,
  Source,
  StackFrame,
  StoppedEvent,
  TerminatedEvent,
  Thread,
} from "@vscode/debugadapter";
import type { DebugProtocol } from "@vscode/debugprotocol";
import { Client, type ClientConfig } from "pg";
import { plpgsqlRoutineBodyStartLine } from "../../../../sql/src/analysis/plpgsqlDocument.js";
import type { SyntaxParser } from "../../../../sql/src/analysis/syntaxTree.js";
import {
  analyzeFunction,
  type PlRecordField,
  type PlSourceAnalysis,
} from "../../../../sql/src/functionSource.js";
import {
  clampDebugResultRows,
  createDebugResultContext,
  DEBUG_RESULT_EVENT,
  DEBUG_RESULT_LIMITS,
  DEBUG_RESULT_STATUS_EVENT,
  type DebugResult,
  type DebugResultContext,
  type DebugResultError,
  type DebugResultPending,
  type DebugResultSource,
} from "../launch/debugResult.js";
import {
  DEBUG_SESSION_STATUS_EVENT,
  type DebugSessionRuntimeState,
  type DebugSessionSource,
  type DebugSessionStatus,
} from "../launch/debugSessionStatus.js";
import type { DebugLaunchRoutineArgument, DebugLaunchRoutineTarget } from "../launch/index.js";
import {
  DebugLaunchError,
  type PreparedDebugLaunch,
  prepareDebugLaunch,
  startDebugTarget,
} from "../launch/startDebugLaunch.js";
import type { PlApiFunctionDef, PlApiStackVariable, PostgresDebugger } from "../postgres/index.js";
import { DebugSessionLifecycle } from "./DebugSessionLifecycle.js";
import { clientSourceUris } from "./sourceRegistry.js";

const logFile = path.join(os.tmpdir(), "postgresql-workbench.log");
const log = (msg: string) =>
  fs.appendFileSync(logFile, `${new Date().toISOString()} [adapter] ${msg}\n`);

const THREAD_ID = 1;

function inferType(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "numeric";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "text";
  if (Array.isArray(value)) return "array";
  return "record";
}

/** What a `launch` request carries for this adapter, beyond the fields the protocol declares. */
export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
  name?: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sql?: string;
  entryRoutine?: DebugLaunchRoutineTarget;
  routine?: DebugLaunchRoutineTarget;
  routineArgs?: DebugLaunchRoutineArgument[];
  ssl?: boolean | "require" | "prefer" | "disable";
  /** Max time to wait for the target to hit the entry breakpoint (default 30s). */
  attachTimeoutMs?: number;
  /** Whether to expose the entry suspension before running to another breakpoint. */
  stopOnEntry?: boolean;
  /** Maximum result rows retained for display. Hard-clamped to the adapter safety range. */
  resultMaxRows?: number;
  resultLabel?: string;
  resultSource?: DebugResultSource;
  /** Optional indexed source identities supplied by an integrating host such as the Workbench. */
  sourceUris?: Record<string, string>;
}

interface BreakpointSourceIdentity {
  path?: string;
  sourceReference: number;
}

interface PendingBreakpointRequest {
  source: BreakpointSourceIdentity;
  breakpoints: Array<{ id: number; line: number; condition?: string; logMessage?: string }>;
}

const DEFAULT_ATTACH_TIMEOUT_MS = 30_000;

/**
 * Cleanup/shutdown timing budget. PostgreSQL phases run sequentially while the
 * syntax worker stops in parallel. The hard exit deadline must exceed both
 * bounded paths so it does not orphan the worker during its forced shutdown.
 */
export const TIMEOUTS = {
  /** pldbg_abort_target on an idle listener */
  ABORT_MS: 2_000,
  /** waiting for the target query to drain after abort/terminate */
  TARGET_DRAIN_MS: 3_000,
  /** closing the pg clients */
  CLOSE_MS: 1_000,
  /** grace for a step command to settle after the target query ends */
  STEP_SETTLE_GRACE_MS: 750,
  /** hard process-exit deadline on SIGTERM/SIGINT */
  SHUTDOWN_BUDGET_MS: 8_000,
} as const;

/** Resolve with the promise's value, or undefined once `ms` elapses — never rejects. */
function withTimeout<T>(promise: Promise<T> | undefined, ms: number): Promise<T | undefined> {
  if (!promise) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

function isConnectionLostError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string })?.code ?? "";
  return (
    code === "ECONNRESET" ||
    code === "57P01" ||
    code === "57P02" ||
    msg.includes("Connection terminated") ||
    msg.includes("terminating connection")
  );
}

function fallbackResultLabel(args: LaunchRequestArguments, query: string): string {
  const named = typeof args.name === "string" ? args.name.replace(/^Debug\s+/i, "").trim() : "";
  return args.resultLabel?.trim() || named || query;
}

interface DebugResultLifecycle {
  id: string;
  timestamp: string;
  context: DebugResultContext;
  pending: DebugResultPending;
  succeed(): void;
  fail(error: unknown): void;
}

function createDebugResultLifecycle(
  args: LaunchRequestArguments,
  query: string,
  sessionSuffix: string,
  onError: (event: DebugResultError) => void,
): DebugResultLifecycle {
  const id = `${sessionSuffix}-${Date.now()}`;
  const timestamp = new Date().toISOString();
  const context = createDebugResultContext(
    fallbackResultLabel(args, query),
    query,
    args.resultSource,
  );
  const startedAt = Date.now();
  let settled = false;
  return {
    id,
    timestamp,
    context,
    pending: { id, status: "pending", ...context, timestamp },
    succeed() {
      settled = true;
    },
    fail(error) {
      if (settled) return;
      settled = true;
      const failure = error instanceof Error ? error : new Error(String(error));
      onError({
        id,
        status: "error",
        ...context,
        message: failure.message.slice(0, DEBUG_RESULT_LIMITS.MAX_ERROR_CHARS),
        durationMs: Math.max(0, Date.now() - startedAt),
        timestamp,
      });
    },
  };
}

interface CachedSource {
  funcDef: PlApiFunctionDef;
  analysis: PlSourceAnalysis;
  /** Lines before the body in pg_get_functiondef output — used to map pldbgapi line numbers */
  bodyLineOffset: number;
}

interface BreakpointInfo {
  /** Conditional breakpoint expression (F4) */
  condition?: string;
  /** Logpoint message template with {var} interpolation (F5) */
  logMessage?: string;
}

interface ScopeReference {
  dapFrameId: number;
  postgresFrameLevel: number;
  kind: "arguments" | "locals";
}

interface DebugStopPosition {
  oid: number;
  line: number;
}

type ExecutionStopPolicy = "first-suspension" | "skip-technical-entry";

// The DAP framework requires one stateful session owner for protocol ordering and request handlers;
// parsing, PostgreSQL access, source registration, and launch orchestration already live in helpers.
// code-moniker: ignore[code-single-responsibility-flags-large-classes]
export class PlpgsqlDebugSession extends LoggingDebugSession {
  private listenerExecutor!: PostgresDebugger;
  private targetClient!: Client;
  private sourceCache = new Map<number, CachedSource>();
  private frameAnalyses = new Map<number, PlSourceAnalysis>();
  private frameIdByLevel = new Map<number, number>();
  private frameLevelById = new Map<number, number>();
  private nextFrameId = 1;
  private selectedFrameAnalysis: PlSourceAnalysis | undefined;
  /** PostgreSQL resets debugger focus to the deepest frame at every stop. */
  private selectedPostgresFrameLevel: number | undefined;
  private entryOid: number = 0;
  private entryBreakpointReleased = false;
  private entryFunctionBreakpointRequested = false;
  private stopOnEntry = true;
  private targetQueryPromise: Promise<void> | undefined;
  private expandableVars = new Map<number, DebugProtocol.Variable[]>();
  private nextVarRef = 10;
  private scopeReferences = new Map<number, ScopeReference>();
  private inspectionTail: Promise<void> = Promise.resolve();
  /** Resolves when the target has hit the global breakpoint and is ready for stepping. */
  private targetReady!: Promise<void>;
  private resolveTargetReady!: () => void;
  /** Active breakpoints per OID — maps body line to breakpoint info (condition/logMessage) */
  private activeBreakpoints = new Map<number, Map<number, BreakpointInfo>>();
  /** Active exception breakpoint filters */
  private exceptionFilters = new Set<string>();
  /** Cached variables for completions (updated on variablesRequest/evaluateRequest) */
  private lastKnownVariables: PlApiStackVariable[] = [];
  /** One immutable variable snapshot per frame while the target is suspended. */
  private variablesByPostgresFrameLevel = new Map<number, PlApiStackVariable[]>();
  /** Unique per-session suffix for application_name — keeps concurrent sessions from interfering. */
  private sessionSuffix = crypto.randomBytes(4).toString("hex");
  /** Connection config kept for the auxiliary connection used to terminate blocked backends. */
  private pgConfig: ClientConfig | undefined;
  /** Backend pid of the target connection — non-zero only while its query runs. */
  private targetPid = 0;
  /** Settles (never rejects) when the target query ends — reused by every step command. */
  private targetEndSignal: Promise<void> | undefined;
  /** setBreakpoints requests received before the listener session was ready — replayed after attach (latest request per source wins). */
  private pendingBreakpointRequests = new Map<string, PendingBreakpointRequest>();
  /** Function breakpoints arrive before launch in the normal DAP sequence. */
  private pendingFunctionBreakpoints: Array<{ id: number; name: string }> = [];
  private nextBreakpointId = 1;
  private readonly lifecycle = new DebugSessionLifecycle();
  private cleanupPromise: Promise<void> | undefined;
  private terminationPromise: Promise<void> | undefined;
  private terminatedEventSent = false;
  private preparedLaunch: PreparedDebugLaunch | undefined;
  private listenerPid = 0;
  private targetBackendPid = 0;
  private entrySource: DebugSessionSource | undefined;
  /** Exact PostgreSQL position of the temporary global entry stop. */
  private entryStopPosition: DebugStopPosition | undefined;
  private sourceUris = new Map<number, string>();
  private sourceOids = new Map<string, number>();
  private sourceReferences = new Map<number, number>();
  private sourceReferenceByOid = new Map<number, number>();
  private nextSourceReference = 1;

  constructor(private readonly syntaxParser: () => Promise<SyntaxParser>) {
    super("postgresql-workbench-debug.log");
    // PostgreSQL and pldebugger report one-based lines. DAP clients advertise
    // their own convention during initialize, so every protocol boundary must
    // use DebugSession's conversion helpers instead of assuming a shared base.
    this.setDebuggerLinesStartAt1(true);
  }

  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
    _args: DebugProtocol.InitializeRequestArguments,
  ): void {
    response.body = {
      supportsConfigurationDoneRequest: true,
      supportsFunctionBreakpoints: true,
      supportsConditionalBreakpoints: true,
      supportsStepBack: false,
      supportsSetVariable: true,
      supportsRestartFrame: false,
      supportsGotoTargetsRequest: false,
      supportsCompletionsRequest: true,
      supportsStepInTargetsRequest: true,
      supportsValueFormattingOptions: true,
      supportsEvaluateForHovers: true,
    };
    (response.body as any).supportsInlineValues = true;
    (response.body as any).supportsLogPoints = true;
    response.body.exceptionBreakpointFilters = [
      { filter: "all", label: "All Exceptions", default: false },
      { filter: "raise", label: "RAISE EXCEPTION", default: true },
    ];
    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());
  }

  protected async launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: LaunchRequestArguments,
  ): Promise<void> {
    log(
      `launchRequest host=${args.host} port=${args.port} db=${args.database} user=${args.user} passwordSet=${Boolean(args.password)}`,
    );
    if (this.lifecycle.state !== "idle") {
      this.sendErrorResponse(
        response,
        5,
        `Cannot launch while the debug session is ${this.lifecycle.state}`,
      );
      return;
    }
    this.lifecycle.transition("preparing");
    this.stopOnEntry = args.stopOnEntry !== false;
    this.entryBreakpointReleased = false;
    this.entryFunctionBreakpointRequested = false;
    this.entryStopPosition = undefined;
    this.sendLifecycleOutput("Preparing PL/pgSQL debug session");
    this.sendSessionStatus("preparing", {
      query: args.sql,
      routine:
        args.routine?.oid !== undefined
          ? {
              oid: args.routine.oid,
              schema: args.routine.schema,
              name: args.routine.name,
              kind: args.routine.kind,
            }
          : undefined,
    });

    this.targetReady = new Promise((resolve) => {
      this.resolveTargetReady = resolve;
    });

    try {
      const prepared = await prepareDebugLaunch(
        args,
        this.sessionSuffix,
        {
          listenerReady: (debuggerBackend) => {
            this.listenerExecutor = debuggerBackend;
          },
          entryResolved: (entryOid) => {
            this.entryOid = entryOid;
          },
          targetClientReady: (client) => {
            this.targetClient = client;
          },
          replayFunctionBreakpoints: async () => {
            if (this.pendingFunctionBreakpoints.length > 0) {
              await this.replayPendingFunctionBreakpoints();
            }
          },
          listenerError: (error) => log(`listener client error: ${error.message}`),
          targetError: (error) => log(`target client error: ${error.message}`),
          notice: (severity, message) => {
            this.sendEvent(new OutputEvent(`[${severity}] ${message}\n`, "console"));
          },
        },
        this.syntaxParser,
      );
      this.startPreparedTarget(response, args, prepared);
    } catch (err) {
      const code = err instanceof DebugLaunchError ? err.responseCode : 5;
      const message = `Failed to start debug session: ${err instanceof Error ? err.message : String(err)}`;
      await this.terminateSession(message, true, false);
      this.sendErrorResponse(response, code, message);
      if (!this.terminatedEventSent) {
        this.terminatedEventSent = true;
        this.sendEvent(new TerminatedEvent());
      }
    }
  }

  private startPreparedTarget(
    response: DebugProtocol.LaunchResponse,
    args: LaunchRequestArguments,
    prepared: PreparedDebugLaunch,
  ): void {
    this.preparedLaunch = prepared;
    this.pgConfig = prepared.pgConfig;
    this.entryOid = prepared.execution.entryOid;
    this.sourceUris = clientSourceUris(args.sourceUris);
    this.sourceOids = new Map([...this.sourceUris].map(([oid, symbolUri]) => [symbolUri, oid]));
    log(`sourceRegistry: ${JSON.stringify(Object.fromEntries(this.sourceUris))}`);
    this.sourceReferences.clear();
    this.sourceReferenceByOid.clear();
    this.nextSourceReference = 1;
    this.targetPid = prepared.targetPid;
    this.targetBackendPid = prepared.targetPid;
    this.listenerPid = prepared.debuggerBackend.getBackendPid();
    const resultLifecycle = createDebugResultLifecycle(
      args,
      prepared.execution.queryText,
      this.sessionSuffix,
      (event) => this.sendEvent(new Event(DEBUG_RESULT_STATUS_EVENT, event)),
    );

    log("launch: target connected, sending response");
    this.sendResponse(response);
    this.sendEvent(new Event(DEBUG_RESULT_STATUS_EVENT, resultLifecycle.pending));
    this.lifecycle.transition("waitingForTarget");
    this.sendSessionStatus("waitingForTarget");
    this.sendLifecycleOutput(
      `Waiting for ${prepared.execution.queryText.slice(0, 120)} to reach the debug entry`,
    );

    const running = startDebugTarget(
      prepared,
      {
        attachTimeoutMs: args.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS,
        resultId: resultLifecycle.id,
        resultLabel: resultLifecycle.context.label,
        resultSource: resultLifecycle.context.source,
        resultTimestamp: resultLifecycle.timestamp,
        maxResultRows: clampDebugResultRows(args.resultMaxRows),
      },
      (result) => {
        resultLifecycle.succeed();
        this.sendEvent(new Event(DEBUG_RESULT_EVENT, result));
        this.sendEvent(new OutputEvent(`${this.formatDebugResultSummary(result)}\n`, "console"));
      },
      (error) => {
        resultLifecycle.fail(error);
        if (!isConnectionLostError(error)) {
          this.sendEvent(new OutputEvent(`Target SQL error: ${error.message}\n`, "stderr"));
        }
      },
      () => {
        this.targetPid = 0;
      },
    );
    this.targetQueryPromise = running.query;
    this.targetEndSignal = running.query;

    running.ready
      .then(async () => {
        log("launch: target hit breakpoint — ready");
        if (this.lifecycle.state !== "waitingForTarget") {
          this.resolveTargetReady();
          return;
        }
        this.lifecycle.transition("suspended");
        this.entryStopPosition = await this.currentStopPosition().catch(() => undefined);
        this.entrySource = this.entryStopPosition
          ? await this.sourceForPosition(
              this.entryStopPosition.oid,
              this.entryStopPosition.line,
            ).catch(() => undefined)
          : undefined;
        this.sendLifecycleOutput(`Attached to PostgreSQL backend ${prepared.targetPid}`);
        this.resolveTargetReady();
      })
      .catch(async (err) => {
        log(`launch: waitForTarget failed — ${err}`);
        resultLifecycle.fail(err);
        await this.terminateSession(
          `Launch failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
        this.resolveTargetReady();
      });
  }

  protected async setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments,
  ): Promise<void> {
    response.body = { breakpoints: [] };
    const source: BreakpointSourceIdentity = {
      path: args.source?.path,
      sourceReference: args.source?.sourceReference ?? 0,
    };
    const sourceKey = source.path ?? `reference:${source.sourceReference}`;
    const requested = (args.breakpoints ?? []).map((bp) => ({
      id: this.nextBreakpointId++,
      line: bp.line,
      condition: bp.condition,
      logMessage: bp.logMessage,
    }));
    log(
      `setBreakPointsRequest: source=${source.path ?? `reference:${source.sourceReference}`} lines=${requested.map((breakpoint) => breakpoint.line).join(",") || "<none>"} listenerReady=${Boolean(this.listenerExecutor)}`,
    );

    if (!this.listenerExecutor) {
      this.pendingBreakpointRequests.set(sourceKey, { source, breakpoints: requested });
      for (const bp of requested) {
        response.body.breakpoints.push({ id: bp.id, verified: false, line: bp.line });
      }
      this.sendResponse(response);
      return;
    }

    try {
      response.body.breakpoints = await this.applyBreakpoints(source, requested);
      this.sendResponse(response);
    } catch (err) {
      log(`setBreakPointsRequest: error — ${err}`);
      for (const bp of requested) {
        response.body.breakpoints.push({ id: bp.id, verified: false, line: bp.line });
      }
      this.sendResponse(response);
      await this.handlePossibleConnectionLoss(err);
    }
  }

  /** Apply a full breakpoint set for one source — shared by setBreakPointsRequest and the pending-breakpoint replay. */
  private async applyBreakpoints(
    source: BreakpointSourceIdentity,
    breakpoints: Array<{ id: number; line: number; condition?: string; logMessage?: string }>,
  ): Promise<DebugProtocol.Breakpoint[]> {
    const oid =
      this.sourceReferences.get(source.sourceReference) ??
      (source.path ? this.sourceOids.get(source.path) : undefined);
    if (!oid) {
      throw new Error(
        `Unknown debug source: ${source.path ?? `reference ${source.sourceReference}`}`,
      );
    }

    const cached = oid ? await this.getSource(oid) : null;
    const bodyOffset = cached?.bodyLineOffset ?? 0;
    const steppable = cached?.analysis.steppableLines;

    const results: DebugProtocol.Breakpoint[] = [];
    const newBodyLines = new Map<number, BreakpointInfo>();
    const serverBodyLines = new Set(
      (await this.listenerExecutor.getBreakpoints())
        .filter((breakpoint) => breakpoint.oid === oid && breakpoint.line > 0)
        .map((breakpoint) => breakpoint.line),
    );

    for (const bp of breakpoints) {
      const debuggerLine = this.convertClientLineToDebugger(bp.line);
      const bodyLine = debuggerLine - bodyOffset;

      if (bodyLine < 1 || (steppable && !steppable.has(bodyLine))) {
        results.push({ id: bp.id, verified: false, line: bp.line });
        continue;
      }

      const ok =
        serverBodyLines.has(bodyLine) || (await this.listenerExecutor.setBreakpoint(oid, bodyLine));
      if (ok) {
        serverBodyLines.add(bodyLine);
        newBodyLines.set(bodyLine, {
          condition: bp.condition,
          logMessage: bp.logMessage,
        });
      }
      results.push({ id: bp.id, verified: ok, line: bp.line });
    }

    const prevLines = this.activeBreakpoints.get(oid);
    const linesToReconcile = new Set([...serverBodyLines, ...(prevLines ? prevLines.keys() : [])]);
    for (const line of linesToReconcile) {
      if (!newBodyLines.has(line)) {
        await this.listenerExecutor.dropBreakpoint(oid, line);
      }
    }
    this.activeBreakpoints.set(oid, newBodyLines);

    return results;
  }

  /** Replay setBreakpoints requests that arrived before the listener session was ready. */
  private async replayPendingBreakpoints(): Promise<void> {
    const pending = [...this.pendingBreakpointRequests.entries()];
    log(`replayPendingBreakpoints: requests=${pending.length}`);
    for (const [sourceKey, request] of pending) {
      try {
        const results = await this.applyBreakpoints(request.source, request.breakpoints);
        log(
          `replayPendingBreakpoints: source=${sourceKey} verified=${results.filter((breakpoint) => breakpoint.verified).length}/${results.length}`,
        );
        if (this.pendingBreakpointRequests.get(sourceKey) === request) {
          this.pendingBreakpointRequests.delete(sourceKey);
        }
        for (const bp of results) {
          this.sendEvent(new BreakpointEvent("changed", bp as DebugProtocol.Breakpoint));
        }
      } catch (err) {
        log(`replayPendingBreakpoints: error for ${sourceKey} — ${err}`);
      }
    }
  }

  /**
   * Shared shape for read-only DAP handlers: bail out with the pre-set empty
   * response body when no session exists, and on error send that body, log,
   * and terminate the session if the connection was lost.
   * The caller pre-sets `response.body` to its empty default; `fn` fills it
   * and must NOT send the response itself.
   */
  private async guarded(
    name: string,
    response: DebugProtocol.Response,
    fn: () => Promise<void>,
  ): Promise<void> {
    if (!this.listenerExecutor) {
      this.sendResponse(response);
      return;
    }
    try {
      await fn();
      this.sendResponse(response);
    } catch (err) {
      log(`${name}: error — ${err}`);
      this.sendResponse(response);
      await this.handlePossibleConnectionLoss(err);
    }
  }

  /** Terminate the session if the error indicates a lost connection/session — otherwise do nothing. */
  private async handlePossibleConnectionLoss(err: unknown): Promise<void> {
    if (!isConnectionLostError(err) || !this.listenerExecutor) return;
    log("connection lost — terminating session");
    await this.terminateSession("PostgreSQL connection lost — debug session ended", true);
  }

  protected async setFunctionBreakPointsRequest(
    response: DebugProtocol.SetFunctionBreakpointsResponse,
    args: DebugProtocol.SetFunctionBreakpointsArguments,
  ): Promise<void> {
    const requested = (args.breakpoints ?? []).map((bp) => ({
      id: this.nextBreakpointId++,
      name: bp.name,
    }));

    if (!this.listenerExecutor) {
      this.pendingFunctionBreakpoints = requested;
      response.body = {
        breakpoints: requested.map((bp) => ({
          id: bp.id,
          verified: false,
          message: "Waiting for the debug session to start",
        })),
      };
      this.sendResponse(response);
      return;
    }

    response.body = { breakpoints: await this.applyFunctionBreakpoints(requested) };
    this.sendResponse(response);
  }

  private async applyFunctionBreakpoints(
    requested: Array<{ id: number; name: string }>,
  ): Promise<DebugProtocol.Breakpoint[]> {
    const breakpoints: DebugProtocol.Breakpoint[] = [];
    let entryRequested = false;
    for (const bp of requested) {
      const parts = bp.name.split(".");
      const schema = parts.length >= 2 ? parts[0] : "public";
      const funcName = parts.length >= 2 ? parts[1] : parts[0];

      try {
        const callArgs = await this.listenerExecutor.getCallArgs(schema, funcName);
        if (callArgs.length > 0) {
          const oid = callArgs[0].oid;
          if (oid === this.entryOid) entryRequested = true;
          if (oid !== this.entryOid || this.entryBreakpointReleased) {
            await this.listenerExecutor.setGlobalBreakpoint(oid);
          }
          breakpoints.push({
            id: bp.id,
            verified: true,
            message: `${schema}.${funcName} (oid ${oid})`,
          });
        } else {
          breakpoints.push({
            id: bp.id,
            verified: false,
            message: `Function not found: ${bp.name}`,
          });
        }
      } catch (err) {
        breakpoints.push({
          id: bp.id,
          verified: false,
          message: `Error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    this.entryFunctionBreakpointRequested = entryRequested;
    return breakpoints;
  }

  private async replayPendingFunctionBreakpoints(): Promise<void> {
    const pending = this.pendingFunctionBreakpoints;
    this.pendingFunctionBreakpoints = [];
    const results = await this.applyFunctionBreakpoints(pending);
    for (const breakpoint of results) {
      this.sendEvent(new BreakpointEvent("changed", breakpoint));
    }
  }

  protected setExceptionBreakPointsRequest(
    response: DebugProtocol.SetExceptionBreakpointsResponse,
    args: DebugProtocol.SetExceptionBreakpointsArguments,
  ): void {
    this.exceptionFilters = new Set(args.filters);
    response.body = {};
    this.sendResponse(response);
  }

  protected async configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse,
    _args: DebugProtocol.ConfigurationDoneArguments,
  ): Promise<void> {
    this.sendResponse(response);

    log("configurationDone: waiting for targetReady");
    await this.targetReady;
    log(`configurationDone: targetReady resolved, listenerExecutor=${!!this.listenerExecutor}`);
    if (!this.listenerExecutor) return;

    if (this.pendingBreakpointRequests.size > 0) {
      await this.replayPendingBreakpoints();
    }

    const entryLineBreakpoints = this.activeBreakpoints.get(this.entryOid)?.size ?? 0;
    if (this.stopOnEntry && entryLineBreakpoints === 0) {
      log("configurationDone: sending StoppedEvent(entry)");
      this.sendStoppedAndReset("entry", this.entrySource);
      return;
    }

    await this.releaseEntryBreakpoint();

    if (this.entryFunctionBreakpointRequested) {
      log("configurationDone: exposing the current entry as the requested function breakpoint");
      this.sendStoppedAndReset("function breakpoint", this.entrySource);
      return;
    }

    if (entryLineBreakpoints > 0) {
      log(
        `configurationDone: skipping technical entry stop and continuing to ${entryLineBreakpoints} user breakpoint(s)`,
      );
    }

    if (this.lifecycle.beginExecution()) {
      this.sendSessionStatus("resuming");
      await this.continueToVisibleStop();
    }
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    log("threadsRequest received");
    response.body = {
      threads: [new Thread(THREAD_ID, "PL/pgSQL")],
    };
    this.sendResponse(response);
  }

  protected async stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    _args: DebugProtocol.StackTraceArguments,
  ): Promise<void> {
    response.body = { stackFrames: [], totalFrames: 0 };
    await this.guarded("stackTraceRequest", response, async () => {
      const stackFrames = await this.runInspection(async () => {
        const frames = await this.listenerExecutor.getStack();
        const result: StackFrame[] = [];
        this.frameAnalyses.clear();
        for (const frame of frames) {
          let frameId = this.frameIdByLevel.get(frame.level);
          if (frameId === undefined) {
            frameId = this.nextFrameId++;
            this.frameIdByLevel.set(frame.level, frameId);
            this.frameLevelById.set(frameId, frame.level);
          }
          const cached = await this.getSource(frame.oid);
          if (cached) this.frameAnalyses.set(frameId, cached.analysis);
          const funcDef = cached?.funcDef;
          const documentUri = funcDef ? this.sourceUris.get(frame.oid) : undefined;
          const source = funcDef
            ? new Source(
                `${funcDef.schema}.${funcDef.name}`,
                documentUri,
                this.sourceReference(frame.oid, documentUri),
              )
            : undefined;

          const absLine = this.convertDebuggerLineToClient(
            frame.line + (cached?.bodyLineOffset ?? 0),
          );
          result.push(
            new StackFrame(frameId, funcDef?.name ?? `<oid:${frame.oid}>`, source, absLine),
          );
        }
        return result;
      });

      response.body = {
        stackFrames,
        totalFrames: stackFrames.length,
      };
    });
  }

  protected scopesRequest(
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments,
  ): void {
    const postgresFrameLevel = this.frameLevelById.get(args.frameId);
    if (postgresFrameLevel === undefined) {
      log(`scopesRequest: ignored stale frameId=${args.frameId}`);
      response.body = { scopes: [] };
      this.sendResponse(response);
      return;
    }
    const argumentsReference = this.nextVarRef++;
    const localsReference = this.nextVarRef++;
    this.scopeReferences.set(argumentsReference, {
      dapFrameId: args.frameId,
      postgresFrameLevel,
      kind: "arguments",
    });
    this.scopeReferences.set(localsReference, {
      dapFrameId: args.frameId,
      postgresFrameLevel,
      kind: "locals",
    });
    response.body = {
      scopes: [
        new Scope("Arguments", argumentsReference, false),
        new Scope("Local Variables", localsReference, false),
      ],
    };
    this.sendResponse(response);
  }

  protected async variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments,
  ): Promise<void> {
    const scopeRef = args.variablesReference;

    if (this.expandableVars.has(scopeRef)) {
      response.body = { variables: this.expandableVars.get(scopeRef)! };
      this.sendResponse(response);
      return;
    }

    response.body = { variables: [] };
    await this.guarded("variablesRequest", response, async () => {
      const scope = this.scopeReferences.get(scopeRef);
      if (!scope || this.lifecycle.state !== "suspended") return;
      const vars = await this.runInspection(async () => {
        if (this.lifecycle.state !== "suspended" || this.scopeReferences.get(scopeRef) !== scope) {
          return [];
        }
        this.selectedFrameAnalysis = this.frameAnalyses.get(scope.dapFrameId);
        return this.frameVariables(scope.postgresFrameLevel);
      });
      if (this.scopeReferences.get(scopeRef) !== scope) return;
      this.lastKnownVariables = vars;

      const filtered =
        scope.kind === "arguments" ? vars.filter((v) => v.isArg) : vars.filter((v) => !v.isArg);

      const byName = new Map<string, (typeof filtered)[number]>();
      for (const v of filtered) {
        const existing = byName.get(v.value.name);
        if (!existing || (existing.value.value === "NULL" && v.value.value !== "NULL")) {
          byName.set(v.value.name, v);
        }
      }
      const unique = [...byName.values()];

      response.body = {
        variables: unique.map((v) => {
          return this.buildVariable(
            v.value.name,
            this.displayValue(v.value),
            v.value.type,
            this.selectedFrameAnalysis?.recordFields.get(v.value.name),
          );
        }),
      };
    });
  }

  protected async sourceRequest(
    response: DebugProtocol.SourceResponse,
    args: DebugProtocol.SourceArguments,
  ): Promise<void> {
    const sourcePath = args.source?.path;
    const sourceReference = args.sourceReference || args.source?.sourceReference || 0;
    log(
      `sourceRequest reference=${sourceReference} path=${sourcePath ?? "<none>"} knownReferences=${this.sourceReferences.size}`,
    );
    const oid =
      this.sourceReferences.get(sourceReference) ??
      (sourcePath ? this.sourceOids.get(sourcePath) : undefined);
    if (oid === undefined) {
      this.sendErrorResponse(response, 9, "Unknown debug source URI");
      return;
    }
    const cached = await this.getSource(oid);
    if (!cached) {
      this.sendErrorResponse(
        response,
        9,
        `Source is unavailable for ${sourcePath ?? `reference ${sourceReference}`}`,
      );
      return;
    }
    response.body = {
      content: cached.funcDef.source,
      mimeType: "text/x-plpgsql",
    };
    this.sendResponse(response);
  }

  /**
   * stepInTargets: tell the client which function calls on this line
   * can be stepped into.
   */
  protected async stepInTargetsRequest(
    response: DebugProtocol.StepInTargetsResponse,
    args: DebugProtocol.StepInTargetsArguments,
  ): Promise<void> {
    response.body = { targets: [] };
    await this.guarded("stepInTargetsRequest", response, async () => {
      const frames = await this.listenerExecutor.getStack();
      const postgresFrameLevel = this.frameLevelById.get(args.frameId);
      const selectedFrame = frames.find((f) => f.level === postgresFrameLevel) ?? frames[0];
      const cached = selectedFrame ? await this.getSource(selectedFrame.oid) : null;
      const targets: DebugProtocol.StepInTarget[] = [];

      if (cached && selectedFrame) {
        const calls = cached.analysis.functionCalls.filter((c) => c.line === selectedFrame.line);
        calls.forEach((call, idx) => {
          targets.push({ id: idx + 1, label: call.name });
        });
      }

      response.body = { targets };
    });
  }

  protected async continueRequest(
    response: DebugProtocol.ContinueResponse,
    _args: DebugProtocol.ContinueArguments,
  ): Promise<void> {
    log("continueRequest received");
    await this.runExecutionRequest(
      response,
      () => this.listenerExecutor.stepContinue(),
      "breakpoint",
      "continue",
      "skip-technical-entry",
    );
  }

  protected async nextRequest(
    response: DebugProtocol.NextResponse,
    _args: DebugProtocol.NextArguments,
  ): Promise<void> {
    await this.runExecutionRequest(
      response,
      () => this.listenerExecutor.stepOver(),
      "step",
      "step over",
      "first-suspension",
    );
  }

  protected async stepInRequest(
    response: DebugProtocol.StepInResponse,
    _args: DebugProtocol.StepInArguments,
  ): Promise<void> {
    await this.runExecutionRequest(
      response,
      () => this.listenerExecutor.stepInto(),
      "step",
      "step into",
      "first-suspension",
    );
  }

  protected async stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    _args: DebugProtocol.StepOutArguments,
  ): Promise<void> {
    await this.runExecutionRequest(
      response,
      () => this.listenerExecutor.stepContinue(),
      "step",
      "step out",
      "first-suspension",
    );
  }

  protected async evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments,
  ): Promise<void> {
    const expr = args.expression;
    try {
      const vars = await this.runInspection(async () => {
        if (this.lifecycle.state !== "suspended") return [];
        const postgresFrameLevel = this.postgresFrameLevelForEvaluation(args.frameId);
        if (postgresFrameLevel === undefined) return [];
        return this.frameVariables(postgresFrameLevel);
      });
      this.lastKnownVariables = vars;
      const resolved = this.resolveExpression(expr, vars);
      if (resolved) {
        const built = this.buildVariable(expr, resolved.value, resolved.type);
        response.body = {
          result: built.value,
          variablesReference: built.variablesReference,
        };
      } else if (args.context === "repl") {
        try {
          const result = await this.listenerExecutor.evaluateSql(expr);
          response.body = {
            result: this.formatQueryResult(result),
            variablesReference: 0,
          };
        } catch (err) {
          response.body = {
            result: `Error: ${err instanceof Error ? err.message : String(err)}`,
            variablesReference: 0,
          };
        }
      } else {
        response.body = {
          result: `<unknown: ${expr}>`,
          variablesReference: 0,
        };
      }
    } catch (err) {
      response.body = {
        result: `<error evaluating: ${expr}>`,
        variablesReference: 0,
      };
      this.sendResponse(response);
      await this.handlePossibleConnectionLoss(err);
      return;
    }
    this.sendResponse(response);
  }

  protected async completionsRequest(
    response: DebugProtocol.CompletionsResponse,
    args: DebugProtocol.CompletionsArguments,
  ): Promise<void> {
    const targets: DebugProtocol.CompletionItem[] = [];
    const text = args.text.slice(0, args.column);
    const prefix = text.split(/\s/).pop()?.toLowerCase() ?? "";

    const seen = new Set<string>();
    for (const v of this.lastKnownVariables) {
      if (seen.has(v.value.name)) continue;
      seen.add(v.value.name);
      if (!prefix || v.value.name.toLowerCase().startsWith(prefix)) {
        targets.push({ label: v.value.name, type: "variable", text: v.value.name });
      }
    }

    for (const kw of ["SELECT", "WHERE", "AND", "OR", "NOT", "IS", "NULL", "TRUE", "FALSE"]) {
      if (!prefix || kw.toLowerCase().startsWith(prefix)) {
        targets.push({ label: kw, type: "keyword" });
      }
    }

    response.body = { targets };
    this.sendResponse(response);
  }

  protected async setVariableRequest(
    response: DebugProtocol.SetVariableResponse,
    args: DebugProtocol.SetVariableArguments,
  ): Promise<void> {
    try {
      const target = this.lastKnownVariables.find((v) => v.value.name === args.name);

      if (!target) {
        this.sendErrorResponse(response, 100, `Variable not found: ${args.name}`);
        return;
      }

      const stack = await this.listenerExecutor.getStack();
      const currentLine = stack[0]?.line ?? 0;

      const ok = await this.listenerExecutor.depositValue(target.varNo, currentLine, args.value);
      if (!ok) {
        this.sendErrorResponse(response, 101, `Failed to set ${args.name}`);
        return;
      }

      this.variablesByPostgresFrameLevel.clear();
      const updated = await this.frameVariables(this.selectedPostgresFrameLevel ?? 0);
      const u = updated.find((v) => v.value.name === args.name);
      const displayValue = u ? this.displayValue(u.value) : args.value;

      const built = this.buildVariable(args.name, displayValue, target.value.type);
      response.body = {
        value: built.value,
        type: target.value.type,
        variablesReference: built.variablesReference,
      };
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(
        response,
        102,
        `Error setting variable: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.handlePossibleConnectionLoss(err);
    }
  }

  protected async disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    _args: DebugProtocol.DisconnectArguments,
  ): Promise<void> {
    await this.terminateSession("Debug session disconnected", false, false);
    this.sendResponse(response);
  }

  /** External shutdown entry point (SIGTERM/SIGINT/stdin close) — cleans up and never throws. */
  public async shutdown(): Promise<void> {
    await this.terminateSession("Debug adapter stopped", false, false).catch(() => {});
  }

  private async cleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = this.cleanupResources();
    return this.cleanupPromise;
  }

  private async cleanupResources(): Promise<void> {
    const listener = this.listenerExecutor;
    const target = this.targetClient;
    this.listenerExecutor = undefined!;
    this.targetClient = undefined!;
    target?.removeAllListeners("notice");

    if (listener?.isBusy()) {
      await this.terminateBackends([listener.getBackendPid(), this.targetPid].filter(Boolean));
    } else if (listener) {
      try {
        await withTimeout(listener.abort(), TIMEOUTS.ABORT_MS);
      } catch {}
    }
    await withTimeout(this.targetQueryPromise, TIMEOUTS.TARGET_DRAIN_MS);
    await withTimeout(
      Promise.all([listener?.close().catch(() => {}), target?.end().catch(() => {})]),
      TIMEOUTS.CLOSE_MS,
    );
    this.sourceCache.clear();
    this.frameAnalyses.clear();
    this.selectedFrameAnalysis = undefined;
    this.activeBreakpoints.clear();
  }

  /** Terminate PostgreSQL backends via a short-lived auxiliary connection — never touches the (possibly blocked) session connections. */
  private async terminateBackends(pids: number[]): Promise<void> {
    if (!this.pgConfig || pids.length === 0) return;
    const aux = new Client({
      ...this.pgConfig,
      application_name: `plpgsql_dap_aux_${this.sessionSuffix}`,
      connectionTimeoutMillis: 5_000,
    });
    try {
      await aux.connect();
      log(`cleanup: pg_terminate_backend(${pids.join(", ")})`);
      await aux.query("SELECT pg_terminate_backend(p) FROM unnest($1::int[]) AS p", [pids]);
    } catch (err) {
      log(`cleanup: auxiliary connection failed — ${err}`);
    } finally {
      await aux.end().catch(() => {});
    }
  }

  private sendLifecycleOutput(message: string, failed = false): void {
    this.sendEvent(new OutputEvent(`[PL/pgSQL] ${message}\n`, failed ? "stderr" : "console"));
  }

  private sendSessionStatus(
    state: DebugSessionRuntimeState,
    overrides: Partial<DebugSessionStatus> = {},
  ): void {
    const execution = this.preparedLaunch?.execution;
    const status: DebugSessionStatus = {
      sessionId: this.sessionSuffix,
      state,
      timestamp: new Date().toISOString(),
      ...(execution ? { routine: execution.routine, query: execution.queryText } : {}),
      ...(this.listenerPid > 0 ? { listenerPid: this.listenerPid } : {}),
      ...(this.targetBackendPid > 0 ? { targetPid: this.targetBackendPid } : {}),
      ...overrides,
    };
    this.sendEvent(new Event(DEBUG_SESSION_STATUS_EVENT, status));
  }

  private async currentStopPosition(): Promise<DebugStopPosition | undefined> {
    if (!this.listenerExecutor) return undefined;
    const frame = (await this.listenerExecutor.getStack())[0];
    return frame ? { oid: frame.oid, line: frame.line } : undefined;
  }

  private async sourceForPosition(
    oid: number,
    bodyLine: number,
  ): Promise<DebugSessionSource | undefined> {
    const cached = await this.getSource(oid);
    if (!cached) return undefined;
    const documentUri = this.sourceUris.get(oid);
    return {
      name: `${cached.funcDef.schema}.${cached.funcDef.name}`,
      ...(documentUri ? { path: documentUri } : {}),
      sourceReference: this.sourceReference(oid, documentUri),
      line: bodyLine + cached.bodyLineOffset,
    };
  }

  private async terminateSession(
    message: string,
    failed: boolean,
    emitTerminated = true,
  ): Promise<void> {
    if (this.terminationPromise) return this.terminationPromise;
    if (!this.lifecycle.beginTermination()) return;

    this.terminationPromise = (async () => {
      this.sendSessionStatus("terminating", { message });
      this.sendLifecycleOutput(message, failed);
      await this.cleanup();
      this.lifecycle.finishTermination(failed);
      this.sendSessionStatus(failed ? "failed" : "terminated", { message });
      if (emitTerminated && !this.terminatedEventSent) {
        this.terminatedEventSent = true;
        this.sendEvent(new TerminatedEvent());
      }
    })();
    return this.terminationPromise;
  }

  private async runExecutionRequest(
    response: DebugProtocol.Response,
    stepFn: () => Promise<import("../postgres/index.js").PlApiStep | null>,
    reason: string,
    command: string,
    stopPolicy: ExecutionStopPolicy,
  ): Promise<void> {
    if (!this.listenerExecutor || this.lifecycle.state !== "suspended") {
      this.sendErrorResponse(
        response,
        103,
        `Cannot ${command} while the debug session is ${this.lifecycle.state}`,
      );
      return;
    }
    if (!this.lifecycle.beginExecution()) return;
    await this.inspectionTail;
    try {
      await this.releaseEntryBreakpoint();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendErrorResponse(response, 104, message);
      await this.terminateSession(message, true);
      return;
    }
    this.sendSessionStatus("resuming");
    this.sendResponse(response);
    await this.safeStep(stepFn, reason, stopPolicy);
  }

  private async safeStep(
    stepFn: () => Promise<import("../postgres/index.js").PlApiStep | null>,
    reason: string,
    stopPolicy: ExecutionStopPolicy,
  ): Promise<void> {
    log(`safeStep: starting (reason=${reason}, policy=${stopPolicy})`);
    if (!this.listenerExecutor) return;
    try {
      let step = await this.runStepCommand(stepFn);
      while (step && step.oid !== 0) {
        // pldbg_continue() and pldbg_get_stack() do not always report the same
        // line for a suspension. The stack is what DAP clients display, so it is
        // the authoritative identity for breakpoints and the technical entry.
        const stop = (await this.currentStopPosition().catch(() => undefined)) ?? step;
        log(`safeStep: stopped raw=${step.oid}:${step.line} stack=${stop.oid}:${stop.line}`);
        const bpInfo = this.getBreakpointInfo(stop.oid, stop.line);
        const source = await this.sourceForPosition(stop.oid, stop.line).catch(() => undefined);

        let exceptionConditions: string[] | undefined;
        if (this.exceptionFilters.size > 0) {
          const cached = await this.getSource(stop.oid);
          if (cached) {
            const handler = cached.analysis.exceptionHandlers.find(
              (eh) => stop.line === eh.startLine,
            );
            if (handler) {
              const shouldStop =
                this.exceptionFilters.has("all") ||
                (this.exceptionFilters.has("raise") &&
                  handler.conditions.some((c) => c === "others" || c.includes("exception")));
              if (shouldStop) {
                exceptionConditions = handler.conditions;
              }
            }
          }
        }

        const logMessage = bpInfo?.logMessage;
        const condition =
          stopPolicy === "skip-technical-entry" && !exceptionConditions && !logMessage
            ? bpInfo?.condition
            : undefined;
        if (logMessage || condition) {
          const vars = await this.listenerExecutor.getVariables();
          this.lastKnownVariables = vars;

          if (logMessage) {
            this.emitLogpoint(logMessage, vars);
            if (stopPolicy === "skip-technical-entry" && !exceptionConditions) {
              step = await this.runStepCommand(() => this.listenerExecutor.stepContinue());
              continue;
            }
          }

          if (condition) {
            const condMet = await this.evaluateCondition(condition, vars);
            if (!condMet) {
              step = await this.runStepCommand(() => this.listenerExecutor.stepContinue());
              continue;
            }
          }
        }

        if (exceptionConditions) {
          this.sendEvent(
            new OutputEvent(`Exception caught: ${exceptionConditions.join(", ")}\n`, "console"),
          );
          this.sendStoppedAndReset("exception", source);
          return;
        }

        if (stopPolicy === "skip-technical-entry" && this.isTechnicalEntryStop(stop, bpInfo)) {
          log(`safeStep: Continue ignored residual entry stop oid=${stop.oid} line=${stop.line}`);
          step = await this.runStepCommand(() => this.listenerExecutor.stepContinue());
          continue;
        }

        this.sendStoppedAndReset(reason, source);
        return;
      }
      log("safeStep: step returned null/oid=0 — terminating");
      await this.terminateSession("Execution completed", false);
    } catch (err) {
      log(`safeStep: error — ${err}`);
      await this.terminateSession(
        `Debug command failed: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    }
  }

  /**
   * Continue past only the exact temporary entry position captured at attach.
   * Every other PostgreSQL suspension remains visible, even when the adapter
   * cannot associate it with a registered line breakpoint. Step commands use
   * the separate first-suspension policy and are never auto-chained.
   */
  private async continueToVisibleStop(): Promise<void> {
    await this.safeStep(
      () => this.listenerExecutor.stepContinue(),
      "breakpoint",
      "skip-technical-entry",
    );
  }

  private isTechnicalEntryStop(
    stop: DebugStopPosition,
    breakpoint: BreakpointInfo | undefined,
  ): boolean {
    const entry = this.entryStopPosition;
    return (
      this.entryBreakpointReleased &&
      !this.entryFunctionBreakpointRequested &&
      !breakpoint &&
      entry !== undefined &&
      stop.oid === entry.oid &&
      stop.line === entry.line
    );
  }

  private postgresFrameLevelForEvaluation(frameId: number | undefined): number | undefined {
    if (frameId === undefined || frameId === 0) {
      return this.selectedPostgresFrameLevel ?? 0;
    }
    return this.frameLevelById.get(frameId);
  }

  /**
   * Run a step command, racing it against the end of the target query.
   * A step command blocks the listener connection while the target runs; when the
   * target finishes, pldbgapi can leave the command hanging for ~10s before failing.
   * Detecting the target's completion directly makes end-of-function immediate.
   * (PostgresDebugger tracks the in-flight blocking command via isBusy() for cleanup().)
   */
  private async runStepCommand(
    stepFn: () => Promise<import("../postgres/index.js").PlApiStep | null>,
  ): Promise<import("../postgres/index.js").PlApiStep | null> {
    const stepPromise = stepFn();
    stepPromise.catch(() => {});
    if (!this.targetEndSignal) return stepPromise;

    let graceTimer: NodeJS.Timeout | undefined;
    const targetEnd: Promise<null> = this.targetEndSignal.then(
      () =>
        new Promise((r) => {
          graceTimer = setTimeout(() => r(null), TIMEOUTS.STEP_SETTLE_GRACE_MS);
          graceTimer.unref?.();
        }),
    );
    try {
      return await Promise.race([stepPromise, targetEnd]);
    } finally {
      if (graceTimer) clearTimeout(graceTimer);
    }
  }

  private getBreakpointInfo(oid: number, bodyLine: number): BreakpointInfo | undefined {
    return this.activeBreakpoints.get(oid)?.get(bodyLine);
  }

  private async evaluateCondition(
    condition: string,
    vars: import("../postgres/index.js").PlApiStackVariable[],
  ): Promise<boolean> {
    try {
      let sql = condition;
      for (const v of vars) {
        const re = new RegExp(`\\b${v.value.name}\\b`, "g");
        const val =
          v.value.value.toUpperCase() === "NULL"
            ? "NULL"
            : `'${v.value.value.replace(/'/g, "''")}'`;
        sql = sql.replace(re, val);
      }
      const result = await this.listenerExecutor.evaluateSql(`SELECT (${sql})::boolean AS result`);
      return result.rows[0]?.result === true;
    } catch {
      return true;
    }
  }

  private emitLogpoint(
    template: string,
    vars: import("../postgres/index.js").PlApiStackVariable[],
  ): void {
    const message = template.replace(/\{(\w+)\}/g, (_, name) => {
      const v = vars.find((v) => v.value.name === name);
      if (!v) return `{${name}}`;
      return this.displayValue(v.value);
    });
    this.sendEvent(new OutputEvent(`${message}\n`, "console"));
  }

  private sendStoppedAndReset(reason: string, source?: DebugSessionSource): void {
    if (this.lifecycle.state === "resuming") {
      this.lifecycle.transition("suspended");
    }
    this.expandableVars.clear();
    this.scopeReferences.clear();
    this.frameAnalyses.clear();
    this.frameIdByLevel.clear();
    this.frameLevelById.clear();
    this.selectedFrameAnalysis = undefined;
    this.selectedPostgresFrameLevel = 0;
    this.variablesByPostgresFrameLevel.clear();
    this.sendEvent(new StoppedEvent(reason, THREAD_ID));
    this.sendSessionStatus("suspended", { source });
  }

  private runInspection<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.inspectionTail.then(operation);
    this.inspectionTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async selectPostgresFrame(frame: number): Promise<void> {
    if (this.selectedPostgresFrameLevel === frame) return;
    await this.listenerExecutor.selectFrame(frame);
    this.selectedPostgresFrameLevel = frame;
  }

  private async frameVariables(frame: number): Promise<PlApiStackVariable[]> {
    const cached = this.variablesByPostgresFrameLevel.get(frame);
    if (cached) return cached;
    await this.selectPostgresFrame(frame);
    const variables = await this.listenerExecutor.getVariables();
    this.variablesByPostgresFrameLevel.set(frame, variables);
    return variables;
  }

  private displayValue(v: import("../postgres/index.js").PlApiValue): string {
    return v.pretty && v.pretty !== v.value ? v.pretty : v.value;
  }

  private formatQueryResult(result: import("pg").QueryResult): string {
    if (result.rows.length === 0) return "(no rows)";
    if (result.rows.length === 1 && result.fields.length === 1) {
      return this.formatQueryResultCell(Object.values(result.rows[0])[0]);
    }
    const cols = result.fields.map((f) => f.name);
    const lines = [cols.join(" | ")];
    lines.push(cols.map((c) => "-".repeat(c.length)).join("-+-"));
    for (const row of result.rows.slice(0, 50)) {
      lines.push(cols.map((c) => this.formatQueryResultCell(row[c])).join(" | "));
    }
    if (result.rows.length > 50) lines.push(`... (${result.rows.length} rows total)`);
    return lines.join("\n");
  }

  private formatQueryResultCell(value: unknown): string {
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  private formatDebugResultSummary(result: DebugResult): string {
    if (
      result.rowCount === 1 &&
      result.columns.length === 1 &&
      result.rows.length === 1 &&
      !result.truncated
    ) {
      return `SQL result:\n${result.rows[0][0]?.value ?? "NULL"}`;
    }
    if (result.columns.length === 0 || result.rowCount === 0) {
      return `SQL result: ${result.command} — ${result.rowCount} rows`;
    }
    const dimensions = `${result.rowCount} rows × ${result.columns.length} columns`;
    const preview = result.truncated
      ? ` — showing ${result.capturedRowCount} rows (truncated)`
      : "";
    return `SQL result: ${dimensions}${preview}`;
  }

  /**
   * Resolve an expression against current variables.
   * Supports: exact name, dotted access (rec.field), array indexing (arr[0]).
   */
  private resolveExpression(
    expr: string,
    vars: import("../postgres/index.js").PlApiStackVariable[],
  ): { value: string; type: string } | null {
    const v = vars.find((v) => v.value.name === expr);
    if (v) {
      return { value: this.displayValue(v.value), type: v.value.type };
    }

    const dotMatch = expr.match(/^(\w+)\.(\w+)$/);
    if (dotMatch) {
      const parent = vars.find((v) => v.value.name === dotMatch[1]);
      if (parent) {
        try {
          const parsed = JSON.parse(parent.value.pretty || parent.value.value);
          if (parsed && typeof parsed === "object" && dotMatch[2] in parsed) {
            return {
              value: JSON.stringify(parsed[dotMatch[2]]),
              type: inferType(parsed[dotMatch[2]]),
            };
          }
        } catch {}
      }
    }

    const arrMatch = expr.match(/^(\w+)\[(\d+)\]$/);
    if (arrMatch) {
      const arrVar = vars.find((v) => v.value.name === arrMatch[1]);
      if (arrVar) {
        try {
          const parsed = JSON.parse(arrVar.value.pretty || arrVar.value.value);
          if (Array.isArray(parsed)) {
            const idx = Number(arrMatch[2]);
            if (idx >= 0 && idx < parsed.length) {
              return { value: JSON.stringify(parsed[idx]), type: inferType(parsed[idx]) };
            }
          }
        } catch {}
      }
    }

    return null;
  }

  private buildVariable(
    name: string,
    value: string,
    type: string,
    recordFields?: PlRecordField[],
    evaluateName = name,
  ): DebugProtocol.Variable {
    if (value === "NULL" || value === "") {
      return { name, value, type, variablesReference: 0, evaluateName };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return { name, value, type, variablesReference: 0, evaluateName };
    }

    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const ref = this.nextVarRef++;
      const hints = new Map(recordFields?.map((field) => [field.name, field.type]));
      const children = Object.entries(parsed as Record<string, unknown>).map(([k, v]) => {
        return this.buildVariable(
          k,
          JSON.stringify(v),
          hints.get(k) ?? inferType(v),
          undefined,
          `${evaluateName}.${k}`,
        );
      });
      this.expandableVars.set(ref, children);
      return {
        name,
        value: children.length > 0 ? "{…}" : "{}",
        type,
        variablesReference: ref,
        evaluateName,
      };
    }

    if (Array.isArray(parsed)) {
      const ref = this.nextVarRef++;
      const children = parsed.map((elem, idx) =>
        this.buildVariable(
          `[${idx}]`,
          JSON.stringify(elem),
          inferType(elem),
          undefined,
          `${evaluateName}[${idx}]`,
        ),
      );
      this.expandableVars.set(ref, children);
      return {
        name,
        value: children.length > 0 ? "[…]" : "[]",
        type,
        variablesReference: ref,
        evaluateName,
      };
    }

    return { name, value: String(parsed), type, variablesReference: 0, evaluateName };
  }

  private async getSource(oid: number): Promise<CachedSource | null> {
    if (this.sourceCache.has(oid)) {
      return this.sourceCache.get(oid)!;
    }
    const funcDef = await this.listenerExecutor.getFunctionDef(oid);
    if (!funcDef) return null;

    const parser = await this.syntaxParser();
    const [analysis, bodyLineOffset] = await Promise.all([
      analyzeFunction(funcDef.body, parser),
      plpgsqlRoutineBodyStartLine(funcDef.source, parser),
    ]);
    if (bodyLineOffset === undefined) {
      throw new Error(`Cannot locate the PL/pgSQL body of routine OID ${oid}.`);
    }
    const cached: CachedSource = { funcDef, analysis, bodyLineOffset };
    this.sourceCache.set(oid, cached);
    return cached;
  }

  private async releaseEntryBreakpoint(): Promise<void> {
    if (this.entryBreakpointReleased) return;
    const released = await this.listenerExecutor.dropGlobalBreakpoint(this.entryOid);
    if (!released) {
      throw new Error(
        `Cannot release the PL/pgSQL entry breakpoint for routine OID ${this.entryOid}`,
      );
    }
    this.entryBreakpointReleased = true;
    if (this.entryFunctionBreakpointRequested) {
      const restored = await this.listenerExecutor.setBreakpoint(this.entryOid, -1);
      if (!restored) {
        throw new Error(
          `Cannot restore the PL/pgSQL function breakpoint for routine OID ${this.entryOid}`,
        );
      }
    }
  }

  private sourceReference(oid: number, documentUri?: string): number {
    if (documentUri && this.sourceUris.get(oid) === documentUri) return 0;
    const existing = this.sourceReferenceByOid.get(oid);
    if (existing) return existing;
    const reference = this.nextSourceReference++;
    this.sourceReferenceByOid.set(oid, reference);
    this.sourceReferences.set(reference, oid);
    return reference;
  }
}
