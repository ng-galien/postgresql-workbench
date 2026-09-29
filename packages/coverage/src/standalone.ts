import { StatelessCodeMonikerSyntaxRuntime } from "../../sql/src/localCodeMonikerSyntax.js";
import { withDiscoveryClient } from "./discoveryClient.js";
import {
  type CoverageClientFactory,
  CoverageRunner,
  type CoverageStatusListener,
  type CoverageSuiteRunRequest,
  type CoverageSuiteRunResult,
  CoverageTimeoutError,
} from "./runner.js";
import {
  type SchemaCoverageResult,
  type SelectedCoverageRequest,
  schemaTestExecutor,
  selectSchemaCoverage,
  summarizeSchemaCoverage,
} from "./schema.js";
import { createCoverageSyntaxService } from "./syntaxService.js";

export * from "./index.js";
export type {
  CoverageScope,
  ExcludedCoverageRoutine,
  SchemaCoverageResult,
  SelectedCoverageRequest,
} from "./schema.js";

export interface SchemaCoverageRequest {
  schema: string;
  testSchemas?: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface StandaloneCoverageOptions {
  syntaxTimeoutMs?: number;
  onStatus?: CoverageStatusListener;
}

/** Owns a lazy syntax worker; PostgreSQL clients come from the caller's factory. */
export class StandaloneCoverage extends CoverageRunner {
  private readonly shutdown = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private disposal?: Promise<void>;

  constructor(
    private readonly openStandaloneClient: CoverageClientFactory,
    options: StandaloneCoverageOptions = {},
  ) {
    const runtime = new StatelessCodeMonikerSyntaxRuntime({ timeoutMs: options.syntaxTimeoutMs });
    super(
      openStandaloneClient,
      createCoverageSyntaxService(() => runtime.parser()),
      options.onStatus,
    );
    this.runtime = runtime;
  }

  private readonly runtime: StatelessCodeMonikerSyntaxRuntime;

  async runSchema(request: SchemaCoverageRequest): Promise<SchemaCoverageResult> {
    return this.runSelected({
      scope: { schemas: [request.schema] },
      ...(request.testSchemas ? { tests: { schemas: request.testSchemas } } : {}),
      signal: request.signal,
      timeoutMs: request.timeoutMs,
    });
  }

  async runSelected(request: SelectedCoverageRequest): Promise<SchemaCoverageResult> {
    if (this.shutdown.signal.aborted) throw new Error("Coverage instance has been disposed.");
    const timeoutMs = request.timeoutMs ?? 300_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
      throw new Error("Invalid coverage timeout.");
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new CoverageTimeoutError(timeoutMs)), timeoutMs);
    const signals = [this.shutdown.signal, deadline.signal];
    if (request.signal) signals.push(request.signal);
    const operation = this.executeSchema({ ...request, signal: AbortSignal.any(signals) });
    this.pending.add(operation);
    try {
      return await operation;
    } finally {
      clearTimeout(timer);
      this.pending.delete(operation);
    }
  }

  private async executeSchema(
    request: SelectedCoverageRequest & { signal: AbortSignal },
  ): Promise<SchemaCoverageResult> {
    const selection = await withDiscoveryClient(
      this.openStandaloneClient,
      request.signal,
      (client) => selectSchemaCoverage(client, request),
    );
    const result = await this.runSuite({
      connectionId: "standalone",
      routineOids: selection.routineOids,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
      requirePgTap: true,
      executeTests: schemaTestExecutor(selection.tests),
    });
    return {
      ...result,
      scope: request.scope,
      testScope: selection.testScope,
      excluded: selection.excluded,
      summary: summarizeSchemaCoverage(result),
    };
  }

  override async runSuite(request: CoverageSuiteRunRequest): Promise<CoverageSuiteRunResult> {
    if (this.shutdown.signal.aborted) throw new Error("Coverage instance has been disposed.");
    const operation = super.runSuite({
      ...request,
      signal: request.signal
        ? AbortSignal.any([request.signal, this.shutdown.signal])
        : this.shutdown.signal,
    });
    this.pending.add(operation);
    try {
      return await operation;
    } finally {
      this.pending.delete(operation);
    }
  }

  /** Cancels active runs, waits for database cleanup, then stops the syntax worker. */
  dispose(): Promise<void> {
    this.disposal ??= this.close();
    return this.disposal;
  }

  private async close(): Promise<void> {
    this.shutdown.abort();
    await Promise.allSettled([...this.pending]);
    await this.runtime.dispose();
  }
}
