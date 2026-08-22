import type { Client } from "pg";
import * as vscode from "vscode";
import { getConnectionName } from "../../../packages/catalog/src/savedConnection.js";
import {
  DEFAULT_PGTAP_TEST_PATTERNS,
  discoverPgTapTests,
  executePgTapTest,
  type PgTapReport,
  type PgTapRoutineDependencyResolver,
  type PgTapSourceRoutine,
  type PgTapTestRoutine,
} from "../../../packages/coverage/src/index.js";
import { destroyClientSocket, withTimeout } from "../../../packages/rows/src/closingClient.js";
import { countLabel } from "../../../packages/rows/src/countLabel.js";
import type { SyntaxParser } from "../../../packages/sql/src/analysis/syntaxTree.js";
import type { ConnectionManager } from "../connection/index.js";
import { errorMessage } from "../errorMessage.js";
import { CODE_MONIKER_URI_SCHEME } from "../sources/index.js";
import { openCoverageClient } from "./client.js";
import { PgTapCoverageProfile, type PgTapCoverageTarget } from "./runProfile.js";

type TestItemData =
  | { kind: "connection"; serverId: string }
  | { kind: "schema"; serverId: string; schema: string }
  | { kind: "routine"; serverId: string; routine?: PgTapSourceRoutine }
  | {
      kind: "test";
      serverId: string;
      test: PgTapTestRoutine;
      routine?: PgTapSourceRoutine;
    };

export type PgTapTestOutcome = "passed" | "failed" | "errored" | "skipped";

class PgTapCancellationCleanupError extends Error {}

interface LinkedCancellation {
  token: vscode.CancellationToken;
  dispose(): void;
}

export interface PgTapTestControllerOptions {
  connections: ConnectionManager;
  output: vscode.OutputChannel;
  syntaxParser: () => Promise<SyntaxParser>;
  indexedDependencies?: (
    serverId: string,
    routine: Parameters<PgTapRoutineDependencyResolver>[0],
  ) => ReturnType<PgTapRoutineDependencyResolver>;
  indexDatabase: (serverId: string, client: Client) => Promise<void>;
  resolveRoutineSymbolUri: (serverId: string, oid: number) => string | undefined;
  resolveDocumentUri: (symbolUri: string) => vscode.Uri | undefined;
  resolveSource: (uri: vscode.Uri) => { serverId: string; oid: number } | undefined;
}

export class PgTapTestController implements vscode.Disposable {
  readonly controller = vscode.tests.createTestController(
    "postgresql-workbench-pgtap",
    "PL/pgSQL pgTAP",
  );
  readonly runProfile: vscode.TestRunProfile;
  readonly coverageProfile: PgTapCoverageProfile;
  private readonly _onDidCompleteRun = new vscode.EventEmitter<
    ReadonlyMap<string, PgTapTestOutcome>
  >();
  readonly onDidCompleteRun = this._onDidCompleteRun.event;
  private readonly data = new WeakMap<vscode.TestItem, TestItemData>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private generation = 0;
  private readonly connections: ConnectionManager;
  private readonly output: vscode.OutputChannel;
  private readonly syntaxParser: () => Promise<SyntaxParser>;
  private readonly indexedDependencies: PgTapTestControllerOptions["indexedDependencies"];
  private readonly indexDatabase: (serverId: string, client: Client) => Promise<void>;
  private readonly resolveRoutineSymbolUri: (serverId: string, oid: number) => string | undefined;
  private readonly resolveDocumentUri: (symbolUri: string) => vscode.Uri | undefined;
  private readonly resolveSource: (
    uri: vscode.Uri,
  ) => { serverId: string; oid: number } | undefined;

  constructor(options: PgTapTestControllerOptions) {
    this.connections = options.connections;
    this.output = options.output;
    this.syntaxParser = options.syntaxParser;
    this.indexedDependencies = options.indexedDependencies;
    this.indexDatabase = options.indexDatabase;
    this.resolveRoutineSymbolUri = options.resolveRoutineSymbolUri;
    this.resolveDocumentUri = options.resolveDocumentUri;
    this.resolveSource = options.resolveSource;
    this.controller.resolveHandler = (item) => (item ? this.resolveItem(item) : undefined);
    this.runProfile = this.controller.createRunProfile(
      "Run pgTAP Tests",
      vscode.TestRunProfileKind.Run,
      async (request, token) => {
        await this.run(request, token);
      },
      true,
    );
    this.coverageProfile = new PgTapCoverageProfile({
      controller: this.controller,
      connections: this.connections,
      output: this.output,
      syntaxParser: this.syntaxParser,
      resolveRequest: (request) => this.resolveRequestedConnections(request),
      collectTargets: (request) => collectCoverageTargets(this.controller, this.data, request),
      resolveRoutineSymbolUri: (serverId, oid) => this.resolveRoutineSymbolUri(serverId, oid),
      resolveDocumentUri: (symbolUri) => this.resolveDocumentUri(symbolUri),
    });
    this.subscriptions.push(
      this.connections.onChanged(() => this.refreshConnections()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("postgresql-workbench.tests.patterns")) {
          this.refreshConnections();
        }
      }),
      this._onDidCompleteRun,
      this.coverageProfile,
      this.controller,
    );
    this.refreshConnections();
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  refresh(): void {
    this.refreshConnections();
  }

  async revealRoutine(serverId: string, routineOid: number): Promise<boolean> {
    const routine = await this.findRoutineItem(serverId, routineOid);
    if (!routine) return false;
    await vscode.commands.executeCommand("vscode.revealTestInExplorer", routine);
    return true;
  }

  async hasMappedTests(serverId: string, routineOid: number): Promise<boolean> {
    return (await this.findRoutineItem(serverId, routineOid)) !== undefined;
  }

  async runRoutineTests(
    serverId: string,
    routineOid: number,
    withCoverage: boolean,
    token?: vscode.CancellationToken,
  ): Promise<boolean> {
    const routine = await this.findRoutineItem(serverId, routineOid);
    if (!routine) return false;
    const profile = withCoverage ? this.coverageProfile.profile : this.runProfile;
    const request = new vscode.TestRunRequest([routine], undefined, profile);
    const execute = async (cancellation: vscode.CancellationToken): Promise<boolean> => {
      await profile.runHandler(request, cancellation);
      return true;
    };
    if (token) {
      return execute(token);
    }
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: withCoverage
          ? "Running mapped pgTAP tests with coverage"
          : "Running mapped pgTAP tests",
        cancellable: true,
      },
      (_progress, cancellation) => execute(cancellation),
    );
  }

  private async findRoutineItem(
    serverId: string,
    routineOid: number,
  ): Promise<vscode.TestItem | undefined> {
    const connection = this.controller.items.get(connectionItemId(serverId));
    if (!connection) return undefined;
    if (connection.children.size === 0) await this.resolveItem(connection);
    return findItem(connection, (item) => {
      const data = this.data.get(item);
      return data?.kind === "routine" && data.routine?.oid === routineOid;
    });
  }

  async revealActiveRoutine(): Promise<boolean> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== CODE_MONIKER_URI_SCHEME) return false;
    const source = this.resolveSource?.(editor.document.uri);
    return source ? this.revealRoutine(source.serverId, source.oid) : false;
  }

  private refreshConnections(): void {
    this.generation++;
    this.coverageProfile?.invalidate();
    this.controller.invalidateTestResults();
    const items = this.connections.servers.map((server) => {
      const item = this.controller.createTestItem(
        connectionItemId(server.id),
        getConnectionName(server),
      );
      item.description = `${server.host}:${server.port}/${server.database}`;
      item.canResolveChildren = true;
      this.data.set(item, { kind: "connection", serverId: server.id });
      return item;
    });
    this.controller.items.replace(items);
  }

  private async resolveItem(item: vscode.TestItem): Promise<void> {
    const data = this.data.get(item);
    if (data?.kind !== "connection") return;
    const generation = this.generation;
    item.busy = true;
    item.error = undefined;
    let client: Client | undefined;
    try {
      client = await openCoverageClient(this.connections, data.serverId);
      await this.indexDatabase(data.serverId, client);
      const patterns = pgTapTestPatterns();
      const indexedDependencies = this.indexedDependencies;
      const discovery = await discoverPgTapTests(
        client,
        await this.syntaxParser(),
        indexedDependencies ? (routine) => indexedDependencies(data.serverId, routine) : undefined,
        patterns,
      );
      if (generation !== this.generation) return;
      if (!discovery.available) {
        item.description = "pgTAP not installed";
        item.error = "Install the pgTAP extension in this database to discover tests.";
        item.children.replace([]);
        return;
      }
      item.children.replace(this.buildHierarchy(data.serverId, discovery.tests));
      item.description =
        discovery.tests.length === 0
          ? "No pgTAP tests"
          : countLabel(discovery.tests.length, "pgTAP test");
      this.output.appendLine(
        `[pgTAP] Discovered ${discovery.tests.length} test(s) on ${item.label} with ${patterns.join(", ") || "<no patterns>"}`,
      );
    } catch (error) {
      if (generation !== this.generation) return;
      item.error = errorMessage(error);
      item.children.replace([]);
      this.output.appendLine(`[pgTAP] Discovery failed on ${item.label}: ${errorMessage(error)}`);
    } finally {
      item.busy = false;
      await client?.end().catch(() => {});
    }
  }

  private buildHierarchy(serverId: string, tests: readonly PgTapTestRoutine[]): vscode.TestItem[] {
    const schemas = new Map<string, vscode.TestItem>();
    const routines = new Map<string, vscode.TestItem>();
    for (const test of tests) {
      const mappedRoutines: Array<PgTapSourceRoutine | undefined> =
        test.sourceRoutines.length > 0 ? test.sourceRoutines : [undefined];
      for (const routine of mappedRoutines) {
        const schema = getOrCreateSchema(
          this.controller,
          this.data,
          schemas,
          serverId,
          routine?.schema ?? test.schema,
        );
        const routineItem = getOrCreateRoutine({
          controller: this.controller,
          data: this.data,
          routines,
          schemaItem: schema,
          serverId,
          routine,
          symbolUri: routine
            ? requireSymbolUri(this.resolveRoutineSymbolUri, serverId, routine.oid)
            : undefined,
          documentUri: routine
            ? requireDocumentUri(
                this.resolveDocumentUri,
                requireSymbolUri(this.resolveRoutineSymbolUri, serverId, routine.oid),
              )
            : undefined,
        });
        const testSymbolUri = requireSymbolUri(this.resolveRoutineSymbolUri, serverId, test.oid);
        const routineSymbolUri = routine
          ? requireSymbolUri(this.resolveRoutineSymbolUri, serverId, routine.oid)
          : undefined;
        const testItem = this.controller.createTestItem(
          `test:${testSymbolUri}:source:${routineSymbolUri ?? "unmapped"}`,
          test.name,
          requireDocumentUri(this.resolveDocumentUri, testSymbolUri),
        );
        testItem.description = test.schema;
        if (!test.runnable) {
          testItem.error = `Requires arguments: ${test.identityArguments}`;
        }
        this.data.set(testItem, { kind: "test", serverId, test, routine });
        routineItem.children.add(testItem);
      }
    }
    return [...schemas.values()].sort((left, right) => left.label.localeCompare(right.label));
  }

  async run(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<ReadonlyMap<string, PgTapTestOutcome>> {
    const run = this.controller.createTestRun(request);
    const cancellation = linkCancellationTokens(token, run.token);
    const outcomes = new Map<string, PgTapTestOutcome>();
    try {
      await this.resolveRequestedConnections(request);
      const tests = collectRequestedTests(this.controller, this.data, request);
      for (const entry of tests) {
        for (const item of entry.items) run.enqueued(item);
      }
      for (const entry of tests) {
        if (!entry.data.test.runnable) {
          for (const item of entry.items) {
            if (entry.explicit) {
              run.errored(
                item,
                new vscode.TestMessage(`Requires arguments: ${entry.data.test.identityArguments}`),
              );
              outcomes.set(item.id, "errored");
            } else {
              run.skipped(item);
              outcomes.set(item.id, "skipped");
            }
          }
          continue;
        }
        if (cancellation.token.isCancellationRequested) {
          for (const item of entry.items) {
            run.skipped(item);
            outcomes.set(item.id, "skipped");
          }
          continue;
        }
        await this.runTest(run, entry.items, entry.data, cancellation.token, outcomes);
      }
      return outcomes;
    } finally {
      run.end();
      cancellation.dispose();
      this._onDidCompleteRun.fire(outcomes);
    }
  }

  private async resolveRequestedConnections(request: vscode.TestRunRequest): Promise<void> {
    const roots: vscode.TestItem[] = [];
    if (request.include) roots.push(...request.include);
    else
      this.controller.items.forEach((item) => {
        roots.push(item);
      });
    for (const root of roots) {
      const data = this.data.get(root);
      if (data?.kind === "connection" && root.children.size === 0) {
        await this.resolveItem(root);
      }
    }
  }

  private async runTest(
    run: vscode.TestRun,
    items: readonly vscode.TestItem[],
    data: Extract<TestItemData, { kind: "test" }>,
    token: vscode.CancellationToken,
    outcomes: Map<string, PgTapTestOutcome>,
  ): Promise<void> {
    const startedAt = Date.now();
    for (const item of items) run.started(item);
    let client: Client | undefined;
    try {
      client = await openCoverageClient(this.connections, data.serverId);
      client.on("error", (error) => {
        this.output.appendLine(
          `[pgTAP] PostgreSQL client error for ${data.test.schema}.${data.test.name}: ${errorMessage(error)}`,
        );
      });
      const report = await executeWithCancellation(
        client,
        () =>
          executePgTapTest(
            client as Client,
            data.test,
            vscode.workspace
              .getConfiguration("postgresql-workbench.coverage")
              .get<number>("maxOutputLines", 200),
            vscode.workspace
              .getConfiguration("postgresql-workbench.coverage")
              .get<number>("maxOutputBytes", 1_048_576),
          ),
        token,
        () => openCoverageClient(this.connections, data.serverId),
      );
      for (const item of items) appendTapOutput(run, item, report);
      if (!report.valid) {
        for (const item of items) {
          run.errored(
            item,
            report.errors.map((message) => new vscode.TestMessage(message)),
            Date.now() - startedAt,
          );
          outcomes.set(item.id, "errored");
        }
      } else if (report.failed > 0) {
        for (const item of items) {
          run.failed(item, failureMessages(report), Date.now() - startedAt);
          outcomes.set(item.id, "failed");
        }
      } else {
        for (const item of items) {
          run.passed(item, Date.now() - startedAt);
          outcomes.set(item.id, "passed");
        }
      }
      this.output.appendLine(
        `[pgTAP] ${data.test.schema}.${data.test.name}: ${report.valid ? (report.failed === 0 ? "passed" : "failed") : "invalid TAP"} (${report.total} assertion(s))`,
      );
    } catch (error) {
      if (token.isCancellationRequested && !(error instanceof PgTapCancellationCleanupError)) {
        for (const item of items) {
          run.skipped(item);
          outcomes.set(item.id, "skipped");
        }
      } else {
        for (const item of items) {
          run.errored(item, new vscode.TestMessage(errorMessage(error)), Date.now() - startedAt);
          outcomes.set(item.id, "errored");
        }
      }
      this.output.appendLine(
        `[pgTAP] ${data.test.schema}.${data.test.name}: ${errorMessage(error)}`,
      );
    } finally {
      if (client) {
        await withTimeout(client.end(), 2_000, "PostgreSQL test client close timed out").catch(() =>
          destroyClientSocket(client as Client),
        );
      }
    }
  }
}

function requireSymbolUri(
  resolve: (serverId: string, oid: number) => string | undefined,
  serverId: string,
  oid: number,
): string {
  const symbolUri = resolve(serverId, oid);
  if (!symbolUri) {
    throw new Error(
      `Code Moniker did not provide a canonical symbol URI for PostgreSQL OID ${oid}`,
    );
  }
  return symbolUri;
}

function getOrCreateSchema(
  controller: vscode.TestController,
  data: WeakMap<vscode.TestItem, TestItemData>,
  schemas: Map<string, vscode.TestItem>,
  serverId: string,
  schema: string,
): vscode.TestItem {
  const key = `${serverId}:${schema}`;
  const existing = schemas.get(key);
  if (existing) return existing;
  const item = controller.createTestItem(`schema:${serverId}:${schema}`, schema);
  data.set(item, { kind: "schema", serverId, schema });
  schemas.set(key, item);
  return item;
}

interface RoutineItemOptions {
  controller: vscode.TestController;
  data: WeakMap<vscode.TestItem, TestItemData>;
  routines: Map<string, vscode.TestItem>;
  schemaItem: vscode.TestItem;
  serverId: string;
  routine?: PgTapSourceRoutine;
  symbolUri?: string;
  documentUri?: vscode.Uri;
}

function getOrCreateRoutine(options: RoutineItemOptions): vscode.TestItem {
  const { controller, data, routines, schemaItem, serverId, routine, symbolUri, documentUri } =
    options;
  const key = symbolUri ?? `${schemaItem.id}:unmapped`;
  const existing = routines.get(key);
  if (existing) return existing;
  const label = routine ? `${routine.name}(${routine.identityArguments})` : "Unmapped pgTAP tests";
  const item = controller.createTestItem(
    symbolUri ? `routine:${symbolUri}` : `routine:${schemaItem.id}:unmapped`,
    label,
    documentUri,
  );
  item.canResolveChildren = false;
  data.set(item, { kind: "routine", serverId, routine });
  schemaItem.children.add(item);
  routines.set(key, item);
  return item;
}

function requireDocumentUri(
  resolve: (symbolUri: string) => vscode.Uri | undefined,
  symbolUri: string,
): vscode.Uri {
  const uri = resolve(symbolUri);
  if (!uri) throw new Error(`Missing PostgreSQL source presentation for ${symbolUri}`);
  return uri;
}

function collectRequestedTests(
  controller: vscode.TestController,
  data: WeakMap<vscode.TestItem, TestItemData>,
  request: vscode.TestRunRequest,
): Array<{
  items: vscode.TestItem[];
  data: Extract<TestItemData, { kind: "test" }>;
  explicit: boolean;
}> {
  const roots: vscode.TestItem[] = [];
  if (request.include) roots.push(...request.include);
  else
    controller.items.forEach((item) => {
      roots.push(item);
    });
  const excluded = new Set(request.exclude ?? []);
  const result = new Map<
    string,
    {
      items: vscode.TestItem[];
      data: Extract<TestItemData, { kind: "test" }>;
      explicit: boolean;
    }
  >();
  const explicitlyIncluded = new Set(request.include ?? []);
  const visit = (item: vscode.TestItem): void => {
    if (excluded.has(item)) return;
    const itemData = data.get(item);
    if (itemData?.kind === "test") {
      const key = `${itemData.serverId}:${itemData.test.oid}`;
      const entry = result.get(key);
      if (entry) {
        entry.items.push(item);
        entry.explicit ||= explicitlyIncluded.has(item);
      } else {
        result.set(key, {
          items: [item],
          data: itemData,
          explicit: explicitlyIncluded.has(item),
        });
      }
      return;
    }
    item.children.forEach(visit);
  };
  for (const root of roots) visit(root);
  return [...result.values()];
}

function collectCoverageTargets(
  controller: vscode.TestController,
  data: WeakMap<vscode.TestItem, TestItemData>,
  request: vscode.TestRunRequest,
): PgTapCoverageTarget[] {
  const roots: vscode.TestItem[] = [];
  if (request.include) roots.push(...request.include);
  else
    controller.items.forEach((item) => {
      roots.push(item);
    });
  const excluded = new Set(request.exclude ?? []);
  const explicitlyIncluded = new Set(request.include ?? []);
  const targets = new Map<string, PgTapCoverageTarget>();
  const visit = (item: vscode.TestItem): void => {
    if (excluded.has(item)) return;
    const itemData = data.get(item);
    if (itemData?.kind === "test") {
      if (!targets.has(item.id)) {
        targets.set(item.id, {
          item,
          serverId: itemData.serverId,
          test: itemData.test,
          routine: itemData.routine,
          explicit: explicitlyIncluded.has(item),
        });
      }
      return;
    }
    item.children.forEach(visit);
  };
  for (const root of roots) visit(root);
  return [...targets.values()];
}

async function executeWithCancellation<T>(
  client: Client,
  action: () => Promise<T>,
  token: vscode.CancellationToken,
  openControl: () => Promise<Client>,
): Promise<T> {
  const backend = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  const pid = backend.rows[0]?.pid;
  if (token.isCancellationRequested) throw new Error("pgTAP run cancelled.");
  const actionPromise = action();
  let cancellation: Promise<void> | undefined;
  let rejectCancellation: ((error: Error) => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
  });
  const subscription = token.onCancellationRequested(() => {
    cancellation = pid ? cancelBackend(openControl, pid, client, actionPromise) : client.end();
    rejectCancellation?.(new Error("pgTAP run cancelled."));
  });
  let result: T | undefined;
  let failure: unknown;
  try {
    result = await Promise.race([actionPromise, cancelled]);
  } catch (error) {
    failure = error;
  }
  subscription.dispose();
  try {
    await cancellation;
  } catch (error) {
    failure = new PgTapCancellationCleanupError(
      `pgTAP cancellation cleanup failed: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (failure) throw failure;
  return result as T;
}

async function cancelBackend(
  openControl: () => Promise<Client>,
  pid: number,
  target: Client,
  action: Promise<unknown>,
): Promise<void> {
  let control: Client | undefined;
  let cancellationError: unknown;
  try {
    control = await openBoundedControlClient(openControl);
    const cancellation = await withTimeout(
      control.query<{ cancelled: boolean }>("SELECT pg_cancel_backend($1) AS cancelled", [pid]),
      2_000,
      "PostgreSQL query cancellation timed out",
    );
    if (cancellation.rows[0]?.cancelled && (await settlesWithin(action, 500))) {
      return;
    }
    const termination = await withTimeout(
      control.query<{ terminated: boolean }>(
        "SELECT pg_terminate_backend($1, 2000) AS terminated",
        [pid],
      ),
      3_000,
      "PostgreSQL backend termination timed out",
    );
    if (!termination.rows[0]?.terminated) {
      throw new Error(`PostgreSQL backend ${pid} could not be terminated.`);
    }
    if (!(await settlesWithin(action, 2_500))) {
      throw new Error(`PostgreSQL backend ${pid} terminated but its test query did not settle.`);
    }
  } catch (error) {
    cancellationError = error;
  } finally {
    if (control) {
      await withTimeout(
        control.end(),
        1_000,
        "PostgreSQL cancellation connection close timed out",
      ).catch(() => destroyClientSocket(control as Client));
    }
  }
  if (cancellationError) {
    destroyClientSocket(target);
    if (!(await settlesWithin(action, 500))) {
      throw new AggregateError(
        [cancellationError],
        `PostgreSQL backend ${pid} cancellation failed and its socket did not settle.`,
      );
    }
    throw cancellationError;
  }
}

export async function openBoundedControlClient(
  openControl: () => Promise<Client>,
  timeoutMs = 2_000,
): Promise<Client> {
  const pending = openControl();
  try {
    return await withTimeout(pending, timeoutMs, "PostgreSQL cancellation connection timed out");
  } catch (error) {
    closeLateClient(pending);
    throw error;
  }
}

function linkCancellationTokens(
  ...tokens: readonly vscode.CancellationToken[]
): LinkedCancellation {
  const source = new vscode.CancellationTokenSource();
  const subscriptions = tokens.map((token) => token.onCancellationRequested(() => source.cancel()));
  if (tokens.some((token) => token.isCancellationRequested)) {
    source.cancel();
  }
  return {
    token: source.token,
    dispose: () => {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
      source.dispose();
    },
  };
}

function closeLateClient(pending: Promise<Client>): void {
  pending
    .then(async (client) => {
      await withTimeout(
        client.end(),
        1_000,
        "Late PostgreSQL cancellation connection close timed out",
      ).catch(() => destroyClientSocket(client));
    })
    .catch(() => {});
}

async function settlesWithin(action: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      action.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function appendTapOutput(run: vscode.TestRun, item: vscode.TestItem, report: PgTapReport): void {
  const lines = report.output.slice(0, 200);
  const suffix = report.output.length > lines.length ? "\r\n… output truncated" : "";
  run.appendOutput(`${lines.join("\r\n")}${suffix}\r\n`, undefined, item);
}

function failureMessages(report: PgTapReport): vscode.TestMessage[] {
  const failed = report.assertions.filter(({ status }) => status === "failed");
  return failed.map(
    (assertion) => new vscode.TestMessage(assertion.message ?? `${assertion.name} failed`),
  );
}

function findItem(
  root: vscode.TestItem,
  predicate: (item: vscode.TestItem) => boolean,
): vscode.TestItem | undefined {
  if (predicate(root)) return root;
  let found: vscode.TestItem | undefined;
  root.children.forEach((child) => {
    if (!found) found = findItem(child, predicate);
  });
  return found;
}

function connectionItemId(serverId: string): string {
  return `connection:${serverId}`;
}

export function pgTapTestPatterns(): string[] {
  const configured = vscode.workspace
    .getConfiguration("postgresql-workbench.tests")
    .get<unknown>("patterns", [...DEFAULT_PGTAP_TEST_PATTERNS]);
  return normalizePgTapTestPatterns(configured);
}

export function normalizePgTapTestPatterns(configured: unknown): string[] {
  if (!Array.isArray(configured) || configured.some((pattern) => typeof pattern !== "string")) {
    throw new Error(
      "postgresql-workbench.tests.patterns must be an array of schema.function glob strings.",
    );
  }
  return configured.map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);
}
