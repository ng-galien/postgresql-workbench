import type { Client } from "pg";
import { createCodeMonikerSyntaxParser } from "../../sql/src/analysis/codeMonikerSyntax.js";
import type { SyntaxParser } from "../../sql/src/analysis/syntaxTree.js";
import type { SqlAuthoringSnapshot, SqlAuthoringTrigger } from "../../sql/src/snapshot.js";
import {
  type CodeMonikerClient,
  type CodeMonikerGraphResult,
  type CodeMonikerIdentityGraphPage,
  type CodeMonikerIdentitySegment,
  type CodeMonikerSymbol,
  ensureLocalCodeMonikerWorkspace,
  type LocalCodeMonikerSession,
} from "./localCodeMoniker.js";
import {
  buildWorkbenchObjects,
  buildWorkbenchTableMembers,
  type WorkbenchObjectModel,
  workbenchObjectFromSymbol,
} from "./objectModel.js";
import {
  buildPostgresSourceSet,
  type CatalogQueryClient,
  mergePostgresCatalogRelations,
  PostgresCatalogFullRefreshRequired,
  type PostgresCatalogObjectOrigin,
  type PostgresCatalogPatch,
  type PostgresCatalogSnapshot,
  type PostgresForeignKey,
  type PostgresViewDependency,
  postgresDatabaseDocumentGlob,
  postgresDatabaseDocumentRoot,
  readPostgresCatalog,
  readPostgresCatalogDocuments,
  type VirtualSqlDocument,
  type VirtualSqlSourceSet,
} from "./postgresCatalog.js";
import type { PostgresDdlObject } from "./postgresDdlSync.js";
import {
  buildPostgresResourceIndex,
  directPostgresDocumentUris,
  type IndexedPostgresResource,
} from "./postgresSourceProvider.js";
import {
  buildWorkbenchRelationGroups,
  classifyWorkbenchRelationFailure,
  isWorkbenchRelationSnapshotCurrent,
  mergeWorkbenchRelationGroups,
  type WorkbenchRelationGroup,
} from "./relations.js";
import type { ConnectionConfig } from "./savedConnection.js";
/** What indexing needs from the open Connections; `IndexConnections` satisfies it. */
export interface IndexConnections {
  readonly store: { get(connectionId: string): ConnectionConfig | undefined };
  isConnectionConnected(connectionId: string): boolean;
  getClient(connectionId: string): Client | undefined;
  onChanged(listener: (change: { connectionIds: readonly string[] }) => void): { dispose(): void };
}

export type WorkbenchIndexStatus =
  | "not-indexed"
  | "indexing"
  | "available"
  | "stale"
  | "cancelled"
  | "error";

export type WorkbenchIndexPhase =
  | "reading-catalog"
  | "connecting-index"
  | "publishing-sources"
  | "reading-symbols"
  | "checking-relations"
  | "cancelling";

export interface WorkbenchIndexProgress {
  phase: WorkbenchIndexPhase;
  completed?: number;
  total?: number;
  unit?: "sources" | "symbols";
}

export interface WorkbenchIndexState {
  status: WorkbenchIndexStatus;
  connectionId?: string;
  message?: string;
  result?: WorkbenchIndexResult;
  progress?: WorkbenchIndexProgress;
  change?: {
    kind: "full" | "incremental";
    schemas: string[];
    sourceUris: string[];
  };
}

export interface WorkbenchIndexAcceptanceEvent {
  sequence: number;
  runId?: number;
  status: WorkbenchIndexStatus;
  phase?: WorkbenchIndexPhase;
  generation?: number | null;
  changeKind?: "full" | "incremental";
  message?: string;
  connectionId?: string;
}

export interface WorkbenchIndexAcceptanceActiveRun {
  cancelled: boolean;
  id: number;
  retainedGeneration?: number | null;
  scope: string;
  connectionId: string;
}

export interface WorkbenchIndexAcceptanceSnapshot {
  /** First entry of `activeRuns`, retained for single-Connection scenarios. */
  activeRun?: WorkbenchIndexAcceptanceActiveRun;
  activeRuns: WorkbenchIndexAcceptanceActiveRun[];
  /** True while any scope still has a queued or executing operation. */
  currentRunPending: boolean;
  /** Scopes with a queued or executing operation. */
  pendingRuns: Array<{ scope: string; connectionId: string }>;
  events: WorkbenchIndexAcceptanceEvent[];
  gate?: {
    nextPhase?: WorkbenchIndexPhase;
    phases: WorkbenchIndexPhase[];
    reachedPhase?: WorkbenchIndexPhase;
    runId?: number;
  };
  lastSettledRun?: {
    id: number;
    status: WorkbenchIndexStatus;
  };
  runSequence: number;
  sourceMutationsActive: number;
  states: WorkbenchIndexState[];
  /** Most recent event, retained only for phase-gate diagnostics. */
  state: WorkbenchIndexState;
}

export interface WorkbenchIndexResult {
  connectionId: string;
  database: string;
  revision: string;
  documents: number;
  symbols: number;
  generation: number | null;
  introspectionMs: number;
  materializationMs: number;
  publicationMs: number;
  symbolQueryMs: number;
  indexingMs: number;
  graphQueryMs: number;
}

export type WorkbenchIndexSnapshot = Pick<
  WorkbenchIndexResult,
  "connectionId" | "database" | "revision" | "generation"
>;

export interface WorkbenchSyntaxRuntimeConfiguration {
  runtimePath: string;
  timeoutMs: number;
}

export type WorkbenchRelationsResult =
  | { status: "available"; groups: WorkbenchRelationGroup[]; sourceLimited: boolean }
  | { status: "empty"; sourceLimited: boolean }
  | { status: "stale" | "missing" | "ambiguous" | "error"; message: string };

export interface WorkbenchIdentityGraphPage extends CodeMonikerIdentityGraphPage {
  generation: number | null;
}

export interface WorkbenchGraphSourcePreview {
  symbol: CodeMonikerSymbol;
  source: NonNullable<CodeMonikerSymbol["source"]>;
}

export interface WorkbenchSourceDescriptor {
  symbolUri: string;
  sourceUri: string;
  connectionId: string;
  database: string;
  schema: string;
  documentKind: "schema" | "table" | "view" | "routine" | "trigger";
  oid: number;
  name: string;
  signature: string;
  symbolKind: string;
  plpgsql: boolean;
  revision: string;
  generation: number | null;
  content: string;
}

interface PublishedSourceSet {
  scope: string;
  connectionId: string;
  srcset: string;
}

interface IndexedPostgresRegistry {
  result: WorkbenchIndexResult;
  symbols: CodeMonikerSymbol[];
  sourceSet: VirtualSqlSourceSet;
  documents: Map<string, VirtualSqlDocument>;
  origins: Map<string, PostgresCatalogObjectOrigin>;
  foreignKeys: PostgresForeignKey[];
  viewDependencies: PostgresViewDependency[];
  resources: Map<string, IndexedPostgresResource>;
}

interface ActiveIndexRun {
  cancelled: boolean;
  id: number;
  retainedResult?: WorkbenchIndexResult;
  scope: string;
  connectionId: string;
}

interface AcceptanceIndexPhaseGate {
  phases: WorkbenchIndexPhase[];
  next: number;
  reached?: WorkbenchIndexPhase;
  release?: () => void;
  runId?: number;
}

class WorkbenchIndexCancelledError extends Error {
  constructor() {
    super("PostgreSQL source indexing was cancelled");
    this.name = "WorkbenchIndexCancelledError";
  }
}

/**
 * What indexing needs from its host: where to log, where the Code Moniker runtime lives, which
 * folders to index, how long a command may take, and whether acceptance control is armed. The
 * Extension Host answers all five from VS Code.
 */
export interface WorkbenchIndexHost {
  log(message: string): void;
  runtimePath(): string;
  workspaceRoots(): string[];
  commandTimeoutMs(): number;
  acceptanceControlEnabled(): boolean;
}

/** One listener registration, released by the caller. */
interface Subscription {
  dispose(): void;
}

// Explicit debt exception: this snapshot owner still exposes registry lookup, Code Moniker
// runtime/session access, graph queries, catalog publication, and DDL synchronization. These
// capabilities must be split behind snapshot-bound ports before removing this exception.
// code-moniker: ignore[code-single-responsibility-flags-large-classes,code-single-responsibility-flags-method-size-disharmony]
export class WorkbenchIndexController {
  private readonly stateListeners = new Set<(state: WorkbenchIndexState) => void>();

  /** Index lifecycle is owned per exact Connection/database scope. */
  private readonly states = new Map<string, WorkbenchIndexState>();
  /** Last event is diagnostic-only for acceptance telemetry; product code never reads it. */
  private lastEventState: WorkbenchIndexState = { status: "not-indexed" };
  private sessionPromise?: Promise<LocalCodeMonikerSession>;
  private activeSession?: LocalCodeMonikerSession;
  private removeSessionCloseListener?: () => void;
  private sessionEpoch = 0;
  private syntaxParserPromise?: Promise<SyntaxParser>;
  /** Serialized index/DDL operations, one queue per exact Connection/database scope. */
  private readonly scopeRuns = new Map<string, { connectionId: string; tail: Promise<unknown> }>();
  /** Runs currently executing, one at most per scope. */
  private readonly activeIndexRuns = new Map<string, ActiveIndexRun>();
  private readonly published = new Map<string, PublishedSourceSet>();
  private readonly registries = new Map<string, IndexedPostgresRegistry>();
  private readonly staleScopes = new Set<string>();
  private readonly sqlAuthoringSnapshots = new Map<
    string,
    { registry: IndexedPostgresRegistry; snapshot: SqlAuthoringSnapshot }
  >();
  private readonly scopeRefreshEpochs = new Map<string, number>();
  private sourceMutation: Promise<void> = Promise.resolve();
  private sourceMutationsActive = 0;
  private indexRunSequence = 0;
  private indexStateSequence = 0;
  private readonly acceptanceEvents: WorkbenchIndexAcceptanceEvent[] = [];
  private acceptancePhaseGate?: AcceptanceIndexPhaseGate;
  private lastSettledRun?: { id: number; status: WorkbenchIndexStatus };
  private readonly connectionSubscription: Subscription;
  private readonly observedConnectedConnectionIds = new Set<string>();
  private disposed = false;

  constructor(
    private readonly host: WorkbenchIndexHost,
    private readonly connections: IndexConnections,
  ) {
    this.connectionSubscription = connections.onChanged((change) =>
      this.observeConnections(change.connectionIds),
    );
  }

  acceptanceSnapshot(): WorkbenchIndexAcceptanceSnapshot {
    this.requireAcceptanceControl();
    const activeRuns = [...this.activeIndexRuns.values()].map((run) => ({
      cancelled: run.cancelled,
      id: run.id,
      retainedGeneration: run.retainedResult?.generation,
      scope: run.scope,
      connectionId: run.connectionId,
    }));
    const gate = this.acceptancePhaseGate;
    return {
      activeRun: activeRuns[0],
      activeRuns,
      currentRunPending: this.scopeRuns.size > 0,
      pendingRuns: [...this.scopeRuns.entries()].map(([scope, { connectionId }]) => ({
        scope,
        connectionId,
      })),
      events: this.acceptanceEvents.map((event) => ({ ...event })),
      gate: gate
        ? {
            nextPhase: gate.phases[gate.next],
            phases: [...gate.phases],
            reachedPhase: gate.reached,
            runId: gate.runId,
          }
        : undefined,
      lastSettledRun: this.lastSettledRun && { ...this.lastSettledRun },
      runSequence: this.indexRunSequence,
      sourceMutationsActive: this.sourceMutationsActive,
      states: [...this.states.values()].map((state) => ({
        ...state,
        change: state.change && {
          ...state.change,
          schemas: [...state.change.schemas],
          sourceUris: [...state.change.sourceUris],
        },
        progress: state.progress && { ...state.progress },
        result: state.result && { ...state.result },
      })),
      state: {
        ...this.lastEventState,
        change: this.lastEventState.change && {
          ...this.lastEventState.change,
          schemas: [...this.lastEventState.change.schemas],
          sourceUris: [...this.lastEventState.change.sourceUris],
        },
        progress: this.lastEventState.progress && { ...this.lastEventState.progress },
        result: this.lastEventState.result && { ...this.lastEventState.result },
      },
    };
  }

  armAcceptancePhaseGate(phases: readonly WorkbenchIndexPhase[]): void {
    this.requireAcceptanceControl();
    if (phases.length === 0) throw new Error("An index phase gate requires at least one phase");
    if (this.acceptancePhaseGate) throw new Error("An index phase gate is already armed");
    this.acceptancePhaseGate = { phases: [...phases], next: 0 };
  }

  releaseAcceptancePhaseGate(runId: number, phase: WorkbenchIndexPhase): void {
    this.requireAcceptanceControl();
    const gate = this.acceptancePhaseGate;
    if (!gate || gate.runId !== runId || gate.reached !== phase || !gate.release) {
      throw new Error(`Index phase gate ${runId}:${phase} is not waiting`);
    }
    const release = gate.release;
    gate.release = undefined;
    gate.reached = undefined;
    gate.next += 1;
    if (gate.next >= gate.phases.length) this.acceptancePhaseGate = undefined;
    release();
  }

  async settleAcceptanceOperations(): Promise<void> {
    this.requireAcceptanceControl();
    // Only a run held by the phase gate is abandoned; automatic refreshes of
    // any Connection settle normally so the next scenario finds a fresh index.
    const heldRunId = this.acceptancePhaseGate?.runId;
    this.clearAcceptancePhaseGate();
    if (heldRunId !== undefined) {
      for (const run of this.activeIndexRuns.values()) {
        if (run.id === heldRunId) this.cancelDatabaseIndex(run.connectionId);
      }
    }
    await Promise.all([...this.scopeRuns.values()].map(({ tail }) => tail.catch(() => undefined)));
    await this.sourceMutation;
  }

  databaseState(identity: { connectionId: string; database: string }): WorkbenchIndexState {
    const scope = databaseScope(identity.connectionId, identity.database);
    const state = this.states.get(scope);
    if (state) return state;
    const registry = this.registries.get(scope);
    if (!registry) return { status: "not-indexed", connectionId: identity.connectionId };
    return {
      status: this.staleScopes.has(scope) ? "stale" : "available",
      connectionId: identity.connectionId,
      result: registry.result,
    };
  }

  databaseSymbols(identity: {
    connectionId: string;
    database: string;
  }): readonly CodeMonikerSymbol[] {
    return (
      this.registries.get(databaseScope(identity.connectionId, identity.database))?.symbols ?? []
    );
  }

  databaseObjectOrigin(
    identity: { connectionId: string; database: string },
    sourceUri: string,
  ): PostgresCatalogObjectOrigin | undefined {
    return this.registries
      .get(databaseScope(identity.connectionId, identity.database))
      ?.origins.get(sourceUri);
  }

  sqlAuthoringSnapshot(identity: {
    connectionId: string;
    database: string;
  }): SqlAuthoringSnapshot | undefined {
    const scope = databaseScope(identity.connectionId, identity.database);
    const registry = this.registries.get(scope);
    if (!registry) {
      this.sqlAuthoringSnapshots.delete(scope);
      return undefined;
    }
    const status: SqlAuthoringSnapshot["status"] = this.staleScopes.has(scope)
      ? "stale"
      : "available";
    const cached = this.sqlAuthoringSnapshots.get(scope);
    if (
      cached &&
      cached.registry === registry &&
      cached.snapshot.status === status &&
      cached.snapshot.revision === registry.result.revision &&
      cached.snapshot.generation === registry.result.generation
    ) {
      return cached.snapshot;
    }
    const snapshot = buildSqlAuthoringSnapshot(registry, identity, status);
    this.sqlAuthoringSnapshots.set(scope, { registry, snapshot });
    return snapshot;
  }

  private invalidateSqlAuthoringSnapshot(scope?: string): void {
    if (scope === undefined) this.sqlAuthoringSnapshots.clear();
    else this.sqlAuthoringSnapshots.delete(scope);
  }

  symbol(symbolUri: string): CodeMonikerSymbol | undefined {
    for (const registry of this.registries.values()) {
      const symbol = registry.symbols.find((candidate) => candidate.uri === symbolUri);
      if (symbol) return symbol;
    }
    return undefined;
  }

  routineSymbol(connectionId: string, oid: number): CodeMonikerSymbol | undefined {
    for (const registry of this.registries.values()) {
      const symbol = registry.symbols.find(
        (candidate) =>
          candidate.postgres?.connectionId === connectionId &&
          candidate.postgres.oid === oid &&
          (candidate.kind === "function" || candidate.kind === "procedure"),
      );
      if (symbol) return symbol;
    }
    return undefined;
  }

  routineSourceUris(connectionId: string): Record<string, string> {
    return Object.fromEntries(
      [...this.registries.values()]
        .flatMap(({ symbols }) => symbols)
        .flatMap((symbol) =>
          symbol.postgres?.connectionId === connectionId &&
          (symbol.kind === "function" || symbol.kind === "procedure")
            ? [[String(symbol.postgres.oid), symbol.uri]]
            : [],
        ),
    );
  }

  sourceDescriptor(
    symbolUri: string,
    snapshot?: Pick<WorkbenchIndexResult, "revision" | "generation">,
  ): WorkbenchSourceDescriptor | undefined {
    const symbol = this.symbol(symbolUri);
    const registry = symbol
      ? [...this.registries.values()].find((candidate) =>
          candidate.symbols.some((entry) => entry.uri === symbolUri),
        )
      : undefined;
    const result = registry?.result;
    const document = symbol ? registry?.documents.get(symbol.file) : undefined;
    const postgres = symbol?.postgres ?? document?.postgres;
    if (
      !result ||
      (snapshot &&
        (snapshot.revision !== result.revision || snapshot.generation !== result.generation)) ||
      !symbol ||
      !document ||
      !postgres
    ) {
      return undefined;
    }
    return {
      symbolUri: symbol.uri,
      sourceUri: symbol.file,
      connectionId: postgres.connectionId,
      database: postgres.database,
      schema: postgres.schema,
      documentKind: postgres.documentKind,
      oid: postgres.oid,
      name: postgres.name,
      signature: symbol.signature || postgres.signature,
      symbolKind: symbol.kind,
      plpgsql:
        (symbol.kind === "function" || symbol.kind === "procedure") &&
        (symbol.source?.lines.some(({ text }) => /\bLANGUAGE\s+plpgsql\b/i.test(text)) ??
          /\bLANGUAGE\s+plpgsql\b/i.test(document.content)),
      revision: result.revision,
      generation: result.generation,
      content: document.content,
    };
  }

  /** Notifies a listener whenever the index state changes. */
  onDidChangeState(listener: (state: WorkbenchIndexState) => void): Subscription {
    this.stateListeners.add(listener);
    return { dispose: () => this.stateListeners.delete(listener) };
  }

  private publishState(state: WorkbenchIndexState): void {
    for (const listener of this.stateListeners) listener(state);
  }

  /** Every symbol the index holds, for the surfaces that project them onto editor documents. */
  symbolUris(): string[] {
    const uris: string[] = [];
    for (const registry of this.registries.values()) {
      for (const symbol of registry.symbols) uris.push(symbol.uri);
    }
    return uris;
  }

  get daemonRuntime(): { pid: number; owned: boolean } | undefined {
    const session = this.activeSession;
    return session
      ? { pid: session.metadata.daemonPid, owned: session.metadata.ownedDaemon }
      : undefined;
  }

  async syntaxParser(): Promise<SyntaxParser> {
    if (!this.syntaxParserPromise) {
      const pending = this.ensureSession().then((session) =>
        createCodeMonikerSyntaxParser(session.client),
      );
      const retryable = pending.catch((error) => {
        if (this.syntaxParserPromise === retryable) this.syntaxParserPromise = undefined;
        throw error;
      });
      this.syntaxParserPromise = retryable;
    }
    return this.syntaxParserPromise;
  }

  syntaxRuntimeConfiguration(): WorkbenchSyntaxRuntimeConfiguration {
    return {
      runtimePath: this.codeMonikerRuntimePath(),
      timeoutMs: this.codeMonikerCommandTimeoutMs(),
    };
  }

  async routineDependencies(
    routineOid: number,
    connectionId: string,
  ): Promise<ReadonlySet<string> | undefined> {
    const connection = this.connections.store.get(connectionId);
    if (!connection || !this.connections.isConnectionConnected(connection.id)) return undefined;
    const database = { connectionId: connection.id, database: connection.database };
    let state = this.databaseState(database);
    let result = state.result;
    if (state.status === "indexing" || !result) {
      try {
        result = await this.indexDatabase(connection.id);
        state = this.databaseState(database);
      } catch {
        return undefined;
      }
    }
    const symbols = this.databaseSymbols(database);
    const routine = buildWorkbenchObjects(symbols, database).find(
      (object) =>
        object.oid === routineOid && (object.kind === "function" || object.kind === "procedure"),
    );
    if (!routine || result.generation === null) return undefined;
    const snapshot: WorkbenchIndexSnapshot = result;
    try {
      const session = await this.ensureSession();
      const graphLimit = 501;
      const graph = await session.client.graph.symbol(
        routine.symbolUri,
        { relation: ["calls"] },
        { consistency: "stale_ok", limit: graphLimit },
      );
      const generationPage = await session.client.symbols.search(
        {
          language: ["sql"],
          kind: [routine.kind],
          path: [routine.sourceUri],
        },
        { consistency: "stale_ok", limit: 20 },
      );
      if (
        !isWorkbenchRelationSnapshotCurrent(
          result.generation,
          snapshot.generation,
          generationPage.data.rows.some((symbol) => symbol.uri === routine.symbolUri),
        ) ||
        !this.matchesSnapshot(result, snapshot) ||
        graph.callers.length + graph.callees.length >= graphLimit ||
        graph.focus.kind !== "symbol" ||
        graph.focus.symbol?.uri !== routine.symbolUri
      ) {
        return undefined;
      }
      const dependencies = new Set<string>();
      for (const callee of graph.callees) {
        if (!callee.kinds.includes("calls")) continue;
        const registry = this.registries.get(databaseScope(connection.id, connection.database));
        const object = workbenchObjectFromSymbol(
          enrichSymbol(callee.symbol, registry?.documents ?? new Map()),
          database,
        );
        if (object?.kind === "function" || object?.kind === "procedure") {
          dependencies.add(`${object.schema}.${object.name}`);
        }
      }
      return dependencies;
    } catch (error) {
      this.host.log(
        `workbench routine dependencies unavailable for OID ${routineOid}: ${errorMessage(error)}`,
      );
      return undefined;
    }
  }

  async graphChildren(
    prefix: string,
    snapshot: WorkbenchIndexSnapshot,
  ): Promise<CodeMonikerIdentitySegment[]> {
    const result = this.requireGraphSnapshot(snapshot);
    const session = await this.ensureSession();
    const response = await session.client.graph.children(prefix, {}, { consistency: "stale_ok" });
    if (!this.matchesSnapshot(result, snapshot)) {
      throw new Error("The PostgreSQL snapshot changed while loading graph children.");
    }
    return response.children.map((child) => ({
      ...child,
      symbol: child.symbol
        ? enrichSymbol(child.symbol, this.requireGraphRegistry(snapshot).documents)
        : child.symbol,
    }));
  }

  async graphScope(
    prefix: string,
    snapshot: WorkbenchIndexSnapshot,
    cursor: unknown | null = null,
  ): Promise<WorkbenchIdentityGraphPage> {
    const result = this.requireGraphSnapshot(snapshot);
    const session = await this.ensureSession();
    const page = await session.client.graph.identity(
      prefix,
      {
        path: [
          postgresDatabaseDocumentGlob({
            connectionId: result.connectionId,
            database: result.database,
          }),
        ],
        minCount: 1,
      },
      { consistency: "stale_ok", limit: 200, cursor },
    );
    if (!this.matchesSnapshot(result, snapshot)) {
      throw new Error("The PostgreSQL snapshot changed while loading the graph.");
    }
    return {
      ...page,
      data: {
        ...page.data,
        nodes: page.data.nodes.map((node) => ({
          ...node,
          symbol: node.symbol
            ? enrichSymbol(node.symbol, this.requireGraphRegistry(snapshot).documents)
            : node.symbol,
        })),
      },
      generation: snapshot.generation,
    };
  }

  async graphFocus(
    symbolUri: string,
    snapshot: WorkbenchIndexSnapshot,
    limit = 200,
  ): Promise<CodeMonikerGraphResult> {
    const result = this.requireGraphSnapshot(snapshot);
    const session = await this.ensureSession();
    const graph = await session.client.graph.symbol(
      symbolUri,
      { relation: ["calls", "reads", "writes", "references", "uses_type"] },
      { consistency: "stale_ok", limit },
    );
    if (!this.matchesSnapshot(result, snapshot)) {
      throw new Error("The PostgreSQL snapshot changed while loading the dependency graph.");
    }
    if (graph.focus.kind !== "symbol" || graph.focus.symbol?.uri !== symbolUri) {
      throw new Error("Code Moniker could not resolve the selected PostgreSQL object.");
    }
    return this.enrichGraph(graph, this.requireGraphRegistry(snapshot).documents);
  }

  async assertGraphSnapshot(snapshot: WorkbenchIndexSnapshot): Promise<void> {
    const result = this.requireGraphSnapshot(snapshot);
    if (!this.matchesSnapshot(result, snapshot)) {
      throw new Error("The PostgreSQL graph snapshot changed while loading the view.");
    }
  }

  async graphSourcePreview(
    symbolUri: string,
    snapshot: WorkbenchIndexSnapshot,
  ): Promise<WorkbenchGraphSourcePreview | undefined> {
    const result = this.requireGraphSnapshot(snapshot);
    const session = await this.ensureSession();
    const detail = await session.client.symbols.detail(
      symbolUri,
      { contextLines: 40 },
      { consistency: "stale_ok" },
    );
    if (!this.matchesSnapshot(result, snapshot)) {
      throw new Error("The PostgreSQL snapshot changed while loading the source preview.");
    }
    const source = detail.source ?? detail.symbol.source;
    return source
      ? {
          symbol: enrichSymbol(detail.symbol, this.requireGraphRegistry(snapshot).documents),
          source,
        }
      : undefined;
  }

  async relations(
    object: WorkbenchObjectModel,
    snapshot: Pick<WorkbenchIndexResult, "revision" | "generation">,
  ): Promise<WorkbenchRelationsResult> {
    const identity = { connectionId: object.connectionId, database: object.database };
    const exactSnapshot: WorkbenchIndexSnapshot = { ...identity, ...snapshot };
    const state = this.databaseState(identity);
    const result = state.result;
    const registry = this.registries.get(databaseScope(object.connectionId, object.database));
    if (
      this.disposed ||
      state.status === "indexing" ||
      !result ||
      !registry ||
      result.connectionId !== object.connectionId ||
      result.database !== object.database ||
      result.revision !== snapshot.revision ||
      result.generation !== snapshot.generation
    ) {
      return {
        status: "stale",
        message: "This object belongs to an outdated PostgreSQL Workbench snapshot.",
      };
    }

    try {
      const session = await this.ensureSession();
      const graphLimit = 201;
      const relationSymbols = [
        object.symbolUri,
        ...registry.symbols
          .filter(
            (symbol) =>
              symbol.file === object.sourceUri &&
              (symbol.kind === "column" || symbol.kind === "constraint"),
          )
          .map((symbol) => symbol.uri),
      ];
      const graphs = await Promise.all(
        [...new Set(relationSymbols)].map((symbolUri) =>
          session.client.graph.symbol(
            symbolUri,
            { relation: ["calls", "reads", "writes", "references", "uses_type"] },
            { consistency: "stale_ok", limit: graphLimit },
          ),
        ),
      );
      const graph = graphs[0];
      const generationPage = await session.client.symbols.search(
        {
          language: ["sql"],
          kind: [object.kind],
          path: [object.sourceUri],
        },
        { consistency: "stale_ok", limit: 20 },
      );
      // Currency is judged against this scope's own registry: the daemon
      // workspace generation also moves whenever another Connection publishes.
      if (
        !isWorkbenchRelationSnapshotCurrent(
          result.generation,
          snapshot.generation,
          generationPage.data.rows.some((symbol) => symbol.uri === object.symbolUri),
        )
      ) {
        return {
          status: "stale",
          message: "The PostgreSQL snapshot changed. Refresh the database index.",
        };
      }
      if (!this.matchesSnapshot(result, exactSnapshot)) {
        return {
          status: "stale",
          message: "The PostgreSQL Workbench snapshot changed while loading relations.",
        };
      }
      if (graph.focus.kind !== "symbol" || graph.focus.symbol?.uri !== object.symbolUri) {
        return {
          status: "ambiguous",
          message: "Code Moniker could not resolve the selected object unambiguously.",
        };
      }

      const groups = mergeWorkbenchRelationGroups([
        ...graphs
          .flatMap((candidate) =>
            buildWorkbenchRelationGroups(candidate, object, registry.symbols).map((group) => ({
              ...group,
              targets: group.targets.filter(
                (target) => target.object?.sourceUri !== object.sourceUri,
              ),
            })),
          )
          .filter((group) => group.targets.length > 0),
      ]);
      const sourceLimited = graphs.some(
        (candidate) => candidate.callers.length + candidate.callees.length >= graphLimit,
      );
      return groups.length > 0
        ? {
            status: "available",
            groups,
            sourceLimited,
          }
        : { status: "empty", sourceLimited };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = classifyWorkbenchRelationFailure(message);
      if (status === "error") {
        this.host.log(`workbench relations failed for ${object.symbolUri}: ${message}`);
      }
      return { status, message };
    }
  }

  indexDatabase(connectionId: string): Promise<WorkbenchIndexResult> {
    if (this.disposed) {
      return Promise.reject(new Error("The PostgreSQL Workbench index is disposed"));
    }
    const connection = this.connections.store.get(connectionId);
    if (!connection) {
      return Promise.reject(new Error("Connect to a PostgreSQL database before indexing it"));
    }
    const scope = databaseScope(connectionId, connection.database);
    const epoch = this.sessionEpoch;
    return this.enqueueScopeRun(scope, connectionId, () =>
      this.runIndex(connectionId).catch((error) => {
        if (error instanceof WorkbenchIndexCancelledError) throw error;
        if (this.sessionEpoch === epoch) throw error;
        this.host.log("Code Moniker connection closed during indexing; reconnecting once");
        return this.runIndex(connectionId);
      }),
    );
  }

  /**
   * Cancels the executing run of `connectionId`, or of every Connection when omitted.
   * Queued runs cannot be cancelled: they start only once their scope is idle.
   */
  cancelDatabaseIndex(connectionId?: string): boolean {
    let cancelled = false;
    for (const run of this.activeIndexRuns.values()) {
      if (run.cancelled) continue;
      if (connectionId !== undefined && run.connectionId !== connectionId) continue;
      run.cancelled = true;
      cancelled = true;
      this.clearAcceptancePhaseGate(run.id);
      this.setState(run.scope, {
        status: "indexing",
        connectionId: run.connectionId,
        result: run.retainedResult,
        message: run.retainedResult
          ? "Cancelling refresh; the previous snapshot remains available"
          : "Cancelling PostgreSQL source indexing",
        progress: { phase: "cancelling" },
      });
    }
    return cancelled;
  }

  /** Chains `operation` after the previous operation of the same scope only. */
  private enqueueScopeRun<T>(
    scope: string,
    connectionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.scopeRuns.get(scope)?.tail;
    // An idle scope starts synchronously so its "indexing" state is visible to
    // the caller immediately, exactly like a direct call.
    const run = previous
      ? previous.then(
          () => operation(),
          () => operation(),
        )
      : operation();
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.scopeRuns.set(scope, { connectionId, tail });
    void tail.then(() => {
      if (this.scopeRuns.get(scope)?.tail === tail) this.scopeRuns.delete(scope);
    });
    return run;
  }

  markDatabaseStale(connectionId: string, database: string, message: string): void {
    const scope = databaseScope(connectionId, database);
    this.staleScopes.add(scope);
    this.invalidateSqlAuthoringSnapshot(scope);
    const registry = this.registries.get(scope);
    this.setState(scope, { status: "stale", connectionId, message, result: registry?.result });
  }

  isDatabaseStale(connectionId: string, database: string): boolean {
    return this.staleScopes.has(databaseScope(connectionId, database));
  }

  synchronizeDatabaseDdl(
    client: CatalogQueryClient,
    identity: { connectionId: string; database: string },
    objects: readonly PostgresDdlObject[],
    fallbackReason?: string,
  ): Promise<WorkbenchIndexResult> {
    const scope = databaseScope(identity.connectionId, identity.database);
    return this.enqueueScopeRun(scope, identity.connectionId, () =>
      this.runDdlSynchronization(client, identity, objects, fallbackReason),
    );
  }

  indexPostgresDatabase(
    client: CatalogQueryClient,
    identity: { connectionId: string; database: string },
  ): Promise<WorkbenchIndexResult> {
    if (this.disposed) {
      return Promise.reject(new Error("The PostgreSQL source registry is disposed"));
    }
    const scope = databaseScope(identity.connectionId, identity.database);
    const retainedResult = this.databaseState(identity).result;
    const refreshEpoch = this.advanceScopeRefreshEpoch(scope);
    this.markDatabaseStale(
      identity.connectionId,
      identity.database,
      "Refreshing the PostgreSQL source snapshot",
    );
    return this.enqueueScopeRun(scope, identity.connectionId, () =>
      this.runPostgresDatabaseIndex(client, identity, scope, refreshEpoch).catch((error) => {
        if (error instanceof WorkbenchIndexCancelledError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        this.setState(scope, {
          status: "error",
          connectionId: identity.connectionId,
          message,
          result: retainedResult,
        });
        throw error;
      }),
    );
  }

  private async runPostgresDatabaseIndex(
    client: CatalogQueryClient,
    identity: { connectionId: string; database: string },
    scope: string,
    refreshEpoch: number,
  ): Promise<WorkbenchIndexResult> {
    return this.executeIndexRun({
      scope,
      connectionId: identity.connectionId,
      database: identity.database,
      readCatalog: () => readPostgresCatalog(client, identity),
      isCurrent: () => this.scopeRefreshEpoch(scope) === refreshEpoch,
      // A newer refresh of this scope owns publication; the older result is
      // still returned so its caller can complete without an error.
      publish: () => this.scopeRefreshEpoch(scope) === refreshEpoch,
      reportFailureState: false,
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearAcceptancePhaseGate();
    this.states.clear();
    this.observedConnectedConnectionIds.clear();
    this.registries.clear();
    this.sqlAuthoringSnapshots.clear();
    this.scopeRefreshEpochs.clear();
    this.connectionSubscription.dispose();
    this.stateListeners.clear();
    const pendingSession = this.sessionPromise;
    this.sessionPromise = undefined;
    this.activeSession = undefined;
    this.removeSessionCloseListener?.();
    this.removeSessionCloseListener = undefined;
    this.syntaxParserPromise = undefined;
    this.cancelDatabaseIndex();
    const pendingRuns = [...this.scopeRuns.values()].map(({ tail }) => tail.catch(() => undefined));
    if (pendingSession) {
      void Promise.all(pendingRuns)
        // Read the mutation chain only once every run has settled: a run still
        // publishing appends to it after dispose() returned.
        .then(() => this.sourceMutation)
        .then(async () => {
          const session = await pendingSession;
          for (const source of this.published.values()) {
            await session.client.sources.remove(source.srcset).catch(() => undefined);
          }
          this.published.clear();
          await session.dispose();
        })
        .catch(() => undefined);
    }
  }

  private async runIndex(connectionId: string): Promise<WorkbenchIndexResult> {
    const connection = this.connections.store.get(connectionId);
    const postgres = this.connections.getClient(connectionId);
    if (!connection || !postgres) {
      throw new Error("Connect to a PostgreSQL database before indexing it");
    }
    const database = connection.database;
    const scope = databaseScope(connectionId, database);
    const refreshEpoch = this.scopeRefreshEpoch(scope);
    return this.executeIndexRun({
      scope,
      connectionId,
      database,
      readCatalog: () => readPostgresCatalog(catalogClient(postgres), { connectionId, database }),
      isCurrent: () =>
        this.connections.isConnectionConnected(connectionId) &&
        this.scopeRefreshEpoch(scope) === refreshEpoch,
      publish: () => true,
      reportFailureState: true,
    });
  }

  /**
   * One full index run of a scope: tracked for progress, cancellation, and the
   * acceptance phase gate. Runs of different scopes execute concurrently; only
   * the Code Moniker publication itself is serialized by `mutateSources`.
   */
  private async executeIndexRun(options: {
    scope: string;
    connectionId: string;
    database: string;
    readCatalog: () => Promise<PostgresCatalogSnapshot>;
    isCurrent: () => boolean;
    publish: () => boolean;
    reportFailureState: boolean;
  }): Promise<WorkbenchIndexResult> {
    const { scope, connectionId, database } = options;
    const indexingStarted = performance.now();
    const retainedResult = this.databaseState({ connectionId, database }).result;
    const run: ActiveIndexRun = {
      cancelled: false,
      id: ++this.indexRunSequence,
      retainedResult,
      scope,
      connectionId,
    };
    this.activeIndexRuns.set(scope, run);
    this.setState(scope, {
      status: "indexing",
      connectionId,
      result: retainedResult,
      message: retainedResult ? "Refreshing the PostgreSQL source snapshot" : undefined,
      progress: { phase: "reading-catalog" },
    });
    let settledStatus: WorkbenchIndexStatus = "error";
    try {
      await this.pauseForAcceptance(run);
      const catalog = await options.readCatalog();
      this.throwIfCancelled(run);
      const indexed = await this.publishAndReadCatalog(
        catalog,
        connectionId,
        database,
        indexingStarted,
        options.isCurrent,
        (progress) => this.reportProgress(run, progress),
        () => this.throwIfCancelled(run),
      );
      const { result, registry, session } = indexed;
      if (options.publish()) {
        this.publishRegistry(scope, registry, { kind: "full", schemas: [], sourceUris: [] });
      }
      settledStatus = "available";
      this.logResult(result, session);
      return result;
    } catch (error) {
      const failure = run.cancelled ? new WorkbenchIndexCancelledError() : error;
      settledStatus = failure instanceof WorkbenchIndexCancelledError ? "cancelled" : "error";
      const message = failure instanceof Error ? failure.message : String(failure);
      if (failure instanceof WorkbenchIndexCancelledError) {
        this.setState(scope, {
          status: "cancelled",
          connectionId,
          message: retainedResult
            ? "Refresh cancelled; showing the previous snapshot"
            : "Indexing cancelled",
          result: retainedResult,
        });
      } else if (options.reportFailureState) {
        this.setState(scope, {
          status: "error",
          connectionId,
          message,
          ...(retainedResult ? { result: retainedResult } : {}),
        });
      }
      this.host.log(
        failure instanceof WorkbenchIndexCancelledError
          ? `workbench index cancelled: ${message}`
          : `workbench index failed: ${message}`,
      );
      throw failure;
    } finally {
      this.lastSettledRun = { id: run.id, status: settledStatus };
      this.clearAcceptancePhaseGate(run.id);
      if (this.activeIndexRuns.get(scope) === run) this.activeIndexRuns.delete(scope);
    }
  }

  private async runDdlSynchronization(
    client: CatalogQueryClient,
    identity: { connectionId: string; database: string },
    objects: readonly PostgresDdlObject[],
    fallbackReason?: string,
  ): Promise<WorkbenchIndexResult> {
    const scope = databaseScope(identity.connectionId, identity.database);
    const refreshEpoch = this.scopeRefreshEpoch(scope);
    const registry = this.registries.get(scope);
    this.markDatabaseStale(
      identity.connectionId,
      identity.database,
      fallbackReason ? `Schema changed: ${fallbackReason}` : "Applying PostgreSQL schema changes",
    );
    if (fallbackReason || !registry) {
      this.host.log(
        `workbench DDL full-refresh fallback: ${fallbackReason ?? "no indexed baseline"}`,
      );
      return this.runPostgresDatabaseIndex(
        client,
        identity,
        scope,
        this.advanceScopeRefreshEpoch(scope),
      );
    }

    try {
      const session = await this.ensureSession();
      this.assertCapabilities(session);
      const selection = await directPostgresDocumentUris(session.client, registry, objects);
      const patch = await readPostgresCatalogDocuments(
        client,
        identity,
        [...registry.documents.values()],
        selection.documentUris,
        selection.newResources,
      );
      const catalog = applyCatalogPatch(identity, registry, patch);
      const indexed = await this.publishAndReadCatalog(
        catalog,
        identity.connectionId,
        identity.database,
        performance.now(),
        () => this.scopeRefreshEpoch(scope) === refreshEpoch,
      );
      const change = {
        kind: "incremental" as const,
        schemas: [...new Set(objects.flatMap((object) => object.schemaName ?? []))].sort(),
        sourceUris: [
          ...new Set([
            ...selection.documentUris,
            ...patch.upsertDocuments.map((document) => document.uri),
            ...patch.removeDocumentUris,
          ]),
        ].sort(),
      };
      this.publishRegistry(scope, indexed.registry, change);
      this.host.log(
        `workbench DDL direct refresh: objects=${objects.length} existing=${selection.documentUris.size} new=${selection.newResources.length} documents=${patch.upsertDocuments.length} removed=${patch.removeDocumentUris.length}`,
      );
      return indexed.result;
    } catch (error) {
      const reason =
        error instanceof PostgresCatalogFullRefreshRequired
          ? error.message
          : `incremental update failed: ${error instanceof Error ? error.message : String(error)}`;
      this.host.log(`workbench DDL full-refresh fallback: ${reason}`);
      return this.runPostgresDatabaseIndex(
        client,
        identity,
        scope,
        this.advanceScopeRefreshEpoch(scope),
      );
    }
  }

  private async publishAndReadCatalog(
    catalog: PostgresCatalogSnapshot,
    connectionId: string,
    database: string,
    indexingStarted: number,
    isCurrent: () => boolean,
    reportProgress?: (progress: WorkbenchIndexProgress) => Promise<void>,
    assertRunActive?: () => void,
  ): Promise<{
    result: WorkbenchIndexResult;
    registry: IndexedPostgresRegistry;
    session: LocalCodeMonikerSession;
  }> {
    const scope = databaseScope(connectionId, database);
    const previousRegistry = this.registries.get(scope);
    const previousPublished = this.published.get(scope);
    let sourceSetReplaced = false;
    if (!isCurrent()) throw new Error("The PostgreSQL source scope changed during indexing");
    await reportProgress?.({ phase: "connecting-index" });
    const session = await this.ensureSession();
    try {
      this.assertCapabilities(session);
      await waitForWorkspaceMutationReady(session.client);
      await reportProgress?.({
        phase: "publishing-sources",
        completed: catalog.metrics.documentCount,
        total: catalog.metrics.documentCount,
        unit: "sources",
      });
      const publicationMs = await this.publishCatalog(
        session,
        catalog,
        scope,
        connectionId,
        isCurrent,
        () => {
          sourceSetReplaced = true;
        },
      );
      if (!isCurrent()) throw new Error("The PostgreSQL source scope changed during indexing");
      await reportProgress?.({ phase: "reading-symbols", completed: 0, unit: "symbols" });
      const indexed = await this.readDatabaseSymbols(
        session,
        connectionId,
        database,
        async (completed) =>
          reportProgress?.({ phase: "reading-symbols", completed, unit: "symbols" }),
      );
      const documents = new Map(
        catalog.sourceSet.documents.map((document) => [document.uri, document]),
      );
      const symbols = indexed.rows.map((symbol) => enrichSymbol(symbol, documents));
      await reportProgress?.({ phase: "checking-relations" });
      const graphQueryMs = await this.probeGraph(session, symbols[0]);
      assertRunActive?.();
      if (!isCurrent()) throw new Error("The PostgreSQL source scope changed during indexing");
      const result: WorkbenchIndexResult = {
        connectionId,
        database,
        revision: catalog.sourceSet.revision,
        documents: catalog.metrics.documentCount,
        symbols: indexed.rows.length,
        generation: indexed.generation,
        introspectionMs: catalog.metrics.introspectionMs,
        materializationMs: catalog.metrics.materializationMs,
        publicationMs,
        symbolQueryMs: indexed.symbolQueryMs,
        indexingMs: performance.now() - indexingStarted,
        graphQueryMs,
      };
      const registry: IndexedPostgresRegistry = {
        result,
        symbols,
        sourceSet: catalog.sourceSet,
        documents,
        origins: new Map(catalog.origins),
        foreignKeys: catalog.foreignKeys,
        viewDependencies: catalog.viewDependencies,
        resources: buildPostgresResourceIndex(documents, symbols),
      };
      this.registries.set(scope, registry);
      return { result, registry, session };
    } catch (error) {
      if (sourceSetReplaced) {
        await this.restorePublishedSnapshot(session, scope, previousRegistry, previousPublished);
      }
      throw error;
    }
  }

  private assertCapabilities(session: LocalCodeMonikerSession): void {
    requireCapability(session.client.supportsQuery("workspace.status"), "workspace.status");
    requireCapability(
      session.client.supportsCommand("workspace.source_set.replace"),
      "workspace.source_set.replace",
    );
    requireCapability(
      session.client.supportsCommand("workspace.source_set.remove"),
      "workspace.source_set.remove",
    );
    requireCapability(session.client.supportsQuery("symbol.search"), "symbol.search");
    requireCapability(session.client.supportsQuery("symbol.usages"), "symbol.usages");
    requireCapability(session.client.supportsQuery("symbol.graph"), "symbol.graph");
    requireCapability(session.client.supportsQuery("symbol.detail"), "symbol.detail");
    requireCapability(session.client.supportsQuery("identity.children"), "identity.children");
    requireCapability(session.client.supportsQuery("identity.graph"), "identity.graph");
  }

  private async publishCatalog(
    session: LocalCodeMonikerSession,
    catalog: PostgresCatalogSnapshot,
    scope: string,
    connectionId: string,
    isCurrent: () => boolean,
    onReplaced: () => void,
  ): Promise<number> {
    const publicationStarted = performance.now();
    await this.mutateSources(async () => {
      if (!isCurrent()) {
        throw new Error("The PostgreSQL source scope changed during indexing");
      }
      const previous = this.published.get(scope);
      await session.client.sources.replace({
        ...catalog.sourceSet,
        documents: catalog.sourceSet.documents.map(({ uri, language, content }) => ({
          uri,
          language,
          content,
        })),
      });
      this.published.set(scope, {
        scope,
        connectionId,
        srcset: catalog.sourceSet.srcset,
      });
      onReplaced();
      if (previous && previous.srcset !== catalog.sourceSet.srcset) {
        await session.client.sources.remove(previous.srcset);
      }
    });
    return performance.now() - publicationStarted;
  }

  private async restorePublishedSnapshot(
    session: LocalCodeMonikerSession,
    scope: string,
    previousRegistry: IndexedPostgresRegistry | undefined,
    previousPublished: PublishedSourceSet | undefined,
  ): Promise<void> {
    const previousSourceSet = previousRegistry?.sourceSet;
    await this.mutateSources(async () => {
      const current = this.published.get(scope);
      if (previousSourceSet) {
        if (current && current.srcset !== previousSourceSet.srcset) {
          await session.client.sources.remove(current.srcset);
        }
        await session.client.sources.replace({
          ...previousSourceSet,
          documents: previousSourceSet.documents.map(({ uri, language, content }) => ({
            uri,
            language,
            content,
          })),
        });
      } else {
        if (current) await session.client.sources.remove(current.srcset);
      }
      if (previousPublished) this.published.set(scope, previousPublished);
      else this.published.delete(scope);
    });
    if (previousRegistry) {
      await waitForWorkspaceMutationReady(session.client);
      const status = await session.client.workspace.status();
      previousRegistry.result.generation = workspaceGeneration(status.generation ?? null);
    }
  }

  private async readDatabaseSymbols(
    session: LocalCodeMonikerSession,
    connectionId: string,
    database: string,
    reportProgress?: (completed: number) => Promise<void>,
  ): Promise<{
    generation: number | null;
    symbolQueryMs: number;
    rows: CodeMonikerSymbol[];
  }> {
    const queryStarted = performance.now();
    const rows: CodeMonikerSymbol[] = [];
    let generation: number | null = null;
    let cursor: unknown | null = null;
    do {
      const page = await session.client.symbols.search(
        {
          language: ["sql"],
          kind: [
            "schema",
            "table",
            "column",
            "constraint",
            "view",
            "function",
            "procedure",
            "trigger",
          ],
          path: [postgresDatabaseDocumentGlob({ connectionId, database })],
          includeCode: true,
          contextLines: 16,
        },
        { consistency: "stale_ok", limit: 500, cursor },
      );
      rows.push(...page.data.rows);
      await reportProgress?.(rows.length);
      generation = workspaceGeneration(page.generation) ?? generation;
      cursor = page.nextCursor;
    } while (cursor !== null);

    return {
      generation,
      symbolQueryMs: performance.now() - queryStarted,
      rows,
    };
  }

  private enrichGraph(
    graph: CodeMonikerGraphResult,
    documents: ReadonlyMap<string, VirtualSqlDocument>,
  ): CodeMonikerGraphResult {
    return {
      ...graph,
      focus: {
        ...graph.focus,
        symbol: graph.focus.symbol ? enrichSymbol(graph.focus.symbol, documents) : undefined,
      },
      callers: graph.callers.map((neighbor) => ({
        ...neighbor,
        symbol: enrichSymbol(neighbor.symbol, documents),
      })),
      callees: graph.callees.map((neighbor) => ({
        ...neighbor,
        symbol: enrichSymbol(neighbor.symbol, documents),
      })),
    };
  }

  private async probeGraph(
    session: LocalCodeMonikerSession,
    focus: CodeMonikerSymbol | undefined,
  ): Promise<number> {
    const graphStarted = performance.now();
    if (focus) {
      await session.client.graph.symbol(focus.uri, {}, { consistency: "stale_ok" });
    }
    return performance.now() - graphStarted;
  }

  private ensureSession(): Promise<LocalCodeMonikerSession> {
    if (!this.sessionPromise) {
      const runtimePath = this.codeMonikerRuntimePath();
      const workspaceRoots = this.workspaceRoots();
      const pending = ensureLocalCodeMonikerWorkspace({
        runtimePath,
        workspaceRoots,
        clientName: "postgresql-workbench",
        timeoutMs: this.codeMonikerCommandTimeoutMs(),
      }).then((session) => {
        this.activeSession = session;
        this.removeSessionCloseListener?.();
        this.removeSessionCloseListener = session.client.onDidClose(() => {
          if (this.activeSession !== session) return;
          this.sessionEpoch += 1;
          this.activeSession = undefined;
          this.sessionPromise = undefined;
          this.syntaxParserPromise = undefined;
          this.published.clear();
          this.registries.clear();
          this.invalidateSqlAuthoringSnapshot();
          this.host.log(
            `Code Moniker daemon ${session.metadata.daemonPid} disconnected; session invalidated`,
          );
        });
        this.host.log(
          `Code Moniker local client ${session.metadata.packageVersion} protocol=${session.metadata.protocolVersion} ` +
            `source=${session.metadata.source} daemon=${session.metadata.daemonPid} ` +
            `owned=${session.metadata.ownedDaemon}`,
        );
        return session;
      });
      const retryable = pending.catch((error) => {
        if (this.sessionPromise === retryable) {
          this.sessionPromise = undefined;
        }
        throw error;
      });
      this.sessionPromise = retryable;
    }
    return this.sessionPromise;
  }

  private codeMonikerRuntimePath(): string {
    return this.host.runtimePath();
  }

  private codeMonikerCommandTimeoutMs(): number {
    return this.host.commandTimeoutMs();
  }

  private workspaceRoots(): string[] {
    return this.host.workspaceRoots();
  }

  private observeConnections(connectionIds: readonly string[]): void {
    for (const connectionId of connectionIds) {
      if (!this.connections.isConnectionConnected(connectionId)) {
        this.observedConnectedConnectionIds.delete(connectionId);
      }
    }
    for (const connectionId of connectionIds) {
      const connection = this.connections.store.get(connectionId);
      const client = connection ? this.connections.getClient(connectionId) : undefined;
      if (!connection || !client) continue;
      const scope = databaseScope(connection.id, connection.database);
      const newlyConnected = !this.observedConnectedConnectionIds.has(connectionId);
      this.observedConnectedConnectionIds.add(connectionId);
      if (newlyConnected && !this.registries.has(scope)) {
        void this.indexPostgresDatabase(client, {
          connectionId: connection.id,
          database: connection.database,
        }).catch((error) => {
          this.host.log(
            `Automatic Workbench indexing failed for ${connection.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    }
    for (const connectionId of connectionIds) {
      if (this.connections.isConnectionConnected(connectionId)) continue;
      const connection = this.connections.store.get(connectionId);
      if (!connection) continue;
      const scope = databaseScope(connection.id, connection.database);
      const registry = this.registries.get(scope);
      this.setState(scope, {
        status: registry ? (this.staleScopes.has(scope) ? "stale" : "available") : "not-indexed",
        connectionId,
        result: registry?.result,
      });
    }
  }

  private publishRegistry(
    scope: string,
    registry: IndexedPostgresRegistry,
    change: NonNullable<WorkbenchIndexState["change"]>,
  ): void {
    this.registries.set(scope, registry);
    this.staleScopes.delete(scope);
    this.invalidateSqlAuthoringSnapshot(scope);
    this.setState(scope, {
      status: "available",
      connectionId: registry.result.connectionId,
      result: registry.result,
      change,
    });
  }

  private advanceScopeRefreshEpoch(scope: string): number {
    const epoch = this.scopeRefreshEpoch(scope) + 1;
    this.scopeRefreshEpochs.set(scope, epoch);
    return epoch;
  }

  private scopeRefreshEpoch(scope: string): number {
    return this.scopeRefreshEpochs.get(scope) ?? 0;
  }

  private matchesSnapshot(result: WorkbenchIndexResult, snapshot: WorkbenchIndexSnapshot): boolean {
    const state = this.databaseState(snapshot);
    return (
      !this.disposed &&
      state.status !== "indexing" &&
      state.result === result &&
      result.connectionId === snapshot.connectionId &&
      result.database === snapshot.database &&
      result.revision === snapshot.revision &&
      result.generation === snapshot.generation
    );
  }

  private requireGraphSnapshot(snapshot: WorkbenchIndexSnapshot): WorkbenchIndexResult {
    const result = this.databaseState(snapshot).result;
    if (!result || !this.matchesSnapshot(result, snapshot)) {
      throw new Error("This graph belongs to an outdated PostgreSQL Workbench snapshot.");
    }
    return result;
  }

  private requireGraphRegistry(snapshot: WorkbenchIndexSnapshot): IndexedPostgresRegistry {
    this.requireGraphSnapshot(snapshot);
    const registry = this.registries.get(databaseScope(snapshot.connectionId, snapshot.database));
    if (!registry) {
      throw new Error("This graph belongs to an unavailable PostgreSQL Workbench snapshot.");
    }
    return registry;
  }

  private mutateSources<T>(action: () => Promise<T>): Promise<T> {
    const monitored = async () => {
      this.sourceMutationsActive += 1;
      try {
        return await action();
      } finally {
        this.sourceMutationsActive -= 1;
      }
    };
    const result = this.sourceMutation.then(monitored, monitored);
    this.sourceMutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private setState(scope: string, state: WorkbenchIndexState): void {
    if (this.disposed) {
      return;
    }
    this.states.set(scope, state);
    this.lastEventState = state;
    if (this.acceptanceControlEnabled()) {
      this.indexStateSequence += 1;
      this.acceptanceEvents.push({
        sequence: this.indexStateSequence,
        runId: this.activeIndexRuns.get(scope)?.id,
        status: state.status,
        phase: state.progress?.phase,
        generation: state.result?.generation,
        changeKind: state.change?.kind,
        message: state.message,
        connectionId: state.connectionId,
      });
      if (this.acceptanceEvents.length > 100) this.acceptanceEvents.shift();
    }
    this.publishState(state);
  }

  private async reportProgress(
    run: ActiveIndexRun,
    progress: WorkbenchIndexProgress,
  ): Promise<void> {
    this.throwIfCancelled(run);
    this.setState(run.scope, {
      status: "indexing",
      connectionId: run.connectionId,
      result: run.retainedResult,
      message: run.retainedResult ? "Refreshing the PostgreSQL source snapshot" : undefined,
      progress,
    });
    await this.pauseForAcceptance(run);
  }

  private throwIfCancelled(run: ActiveIndexRun): void {
    if (run.cancelled) throw new WorkbenchIndexCancelledError();
  }

  private async pauseForAcceptance(run: ActiveIndexRun): Promise<void> {
    const gate = this.acceptancePhaseGate;
    const phase = this.states.get(run.scope)?.progress?.phase;
    if (
      gate &&
      phase &&
      gate.phases[gate.next] === phase &&
      (gate.runId === undefined || gate.runId === run.id)
    ) {
      gate.runId = run.id;
      gate.reached = phase;
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    }
    this.throwIfCancelled(run);
  }

  private acceptanceControlEnabled(): boolean {
    return this.host.acceptanceControlEnabled();
  }

  private requireAcceptanceControl(): void {
    if (!this.acceptanceControlEnabled()) {
      throw new Error("Workbench index acceptance controls are unavailable");
    }
  }

  private clearAcceptancePhaseGate(runId?: number): void {
    const gate = this.acceptancePhaseGate;
    // A gate not yet bound to a run stays armed: a run of another scope
    // settling must not disarm the gate meant for a later run.
    if (!gate || (runId !== undefined && gate.runId !== runId)) return;
    this.acceptancePhaseGate = undefined;
    const release = gate.release;
    gate.release = undefined;
    gate.reached = undefined;
    release?.();
  }

  private logResult(result: WorkbenchIndexResult, session: LocalCodeMonikerSession): void {
    this.host.log(
      `workbench index database=${result.database} documents=${result.documents} ` +
        `symbols=${result.symbols} generation=${result.generation ?? "none"} ` +
        `introspection=${duration(result.introspectionMs)} ` +
        `materialization=${duration(result.materializationMs)} ` +
        `publication=${duration(result.publicationMs)} ` +
        `symbolQuery=${duration(result.symbolQueryMs)} indexing=${duration(result.indexingMs)} ` +
        `graph=${duration(result.graphQueryMs)} ` +
        `source=${session.metadata.source}`,
    );
  }
}

function catalogClient(client: {
  query(sql: string): Promise<{ rows: unknown[] }>;
}): CatalogQueryClient {
  return {
    async query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
      const result = await client.query(sql);
      return { rows: result.rows as Record<string, unknown>[] };
    },
  };
}

function applyCatalogPatch(
  identity: { connectionId: string; database: string },
  registry: IndexedPostgresRegistry,
  patch: PostgresCatalogPatch,
): PostgresCatalogSnapshot {
  const documents = new Map(registry.documents);
  const origins = new Map(registry.origins);
  const removedOids = new Set<number>();
  for (const uri of patch.removeDocumentUris) {
    const removed = documents.get(uri);
    if (removed?.postgres) removedOids.add(removed.postgres.oid);
    documents.delete(uri);
    origins.delete(uri);
  }
  for (const document of patch.upsertDocuments) documents.set(document.uri, document);
  for (const [uri, origin] of patch.origins) origins.set(uri, origin);

  const relations = mergePostgresCatalogRelations(registry.foreignKeys, registry.viewDependencies, {
    ...patch,
    affectedRelationOids: [...patch.affectedRelationOids, ...removedOids],
  });
  const sourceSet = buildPostgresSourceSet(identity, [...documents.values()], origins);
  return {
    sourceSet,
    metrics: {
      introspectionMs: patch.introspectionMs,
      materializationMs: patch.materializationMs,
      documentCount: sourceSet.documents.length,
    },
    origins,
    foreignKeys: relations.foreignKeys,
    viewDependencies: relations.viewDependencies,
  };
}

function enrichSymbol(
  symbol: CodeMonikerSymbol,
  documents: ReadonlyMap<string, VirtualSqlDocument>,
): CodeMonikerSymbol {
  const postgres = documents.get(symbol.file)?.postgres;
  return postgres ? { ...symbol, postgres } : symbol;
}

async function waitForWorkspaceMutationReady(
  client: CodeMonikerClient,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const status = await client.workspace.status();
    if (status.phase === "ready") return;
    if (status.phase === "failed") {
      throw new Error(status.failure?.message ?? "Code Moniker workspace indexing failed");
    }
    if (Date.now() >= deadline) {
      throw new Error(`Code Moniker workspace remained ${status.phase} for ${timeoutMs} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function requireCapability(available: boolean, capability: string): void {
  if (!available) {
    throw new Error(`Code Moniker daemon does not support ${capability}`);
  }
}

function duration(milliseconds: number): string {
  return `${milliseconds.toFixed(1)}ms`;
}

function buildSqlAuthoringSnapshot(
  registry: IndexedPostgresRegistry,
  identity: { connectionId: string; database: string },
  status: SqlAuthoringSnapshot["status"],
): SqlAuthoringSnapshot {
  const workbenchObjects = buildWorkbenchObjects(registry.symbols, identity);
  const objects = workbenchObjects
    .filter(
      (object) =>
        object.kind === "table" ||
        object.kind === "view" ||
        object.kind === "function" ||
        object.kind === "procedure",
    )
    .map((object) => ({
      connectionId: object.connectionId,
      database: object.database,
      schema: object.schema,
      oid: object.oid,
      name: object.name,
      kind: object.kind as "table" | "view" | "function" | "procedure",
      signature: object.signature,
      plpgsql: object.plpgsql,
      returnType:
        object.kind === "function"
          ? routineReturnType(registry.documents.get(object.sourceUri)?.content)
          : undefined,
      parameters: object.params.map((parameter) => ({ ...parameter })),
      columns:
        object.kind === "table" || object.kind === "view"
          ? buildWorkbenchTableMembers(registry.symbols, object)
              .filter((member) => member.kind === "column")
              .map((member) => ({ name: member.name, type: member.type }))
          : [],
    }));
  const triggers = workbenchObjects.flatMap((object) => {
    if (object.kind !== "trigger") return [];
    const definition = registry.documents.get(object.sourceUri)?.content;
    const trigger = definition
      ? sqlAuthoringTrigger(object.oid, object.schema, object.name, definition)
      : undefined;
    return trigger ? [trigger] : [];
  });
  return {
    status,
    connectionId: identity.connectionId,
    database: identity.database,
    revision: registry.result.revision,
    generation: registry.result.generation,
    objects,
    foreignKeys: registry.foreignKeys.map((foreignKey) => ({ ...foreignKey })),
    triggers,
  };
}

function databaseScope(connectionId: string, database: string): string {
  return postgresDatabaseDocumentRoot({ connectionId, database });
}

function routineReturnType(source: string | undefined): string | undefined {
  if (!source) return undefined;
  if (/\bRETURNS\s+(?:pg_catalog\.)?event_trigger\b/iu.test(source)) return "event_trigger";
  if (/\bRETURNS\s+(?:pg_catalog\.)?trigger\b/iu.test(source)) return "trigger";
  const match = /\bRETURNS\s+((?:SETOF\s+)?[^\s;(]+)/iu.exec(source);
  return match?.[1];
}

function sqlAuthoringTrigger(
  oid: number,
  schema: string,
  name: string,
  definition: string,
): SqlAuthoringTrigger | undefined {
  const identifier = String.raw`(?:"(?:""|[^"])+"|[A-Za-z_][\w$]*)`;
  const relation = new RegExp(
    String.raw`\bON\s+(?:ONLY\s+)?(${identifier})\.(${identifier})`,
    "iu",
  ).exec(definition);
  const routine = new RegExp(
    String.raw`\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(${identifier})\.(${identifier})\s*\(`,
    "iu",
  ).exec(definition);
  if (!relation || !routine) return undefined;
  return {
    oid,
    schema,
    name,
    relationSchema: unquoteCatalogIdentifier(relation[1]),
    relationName: unquoteCatalogIdentifier(relation[2]),
    routineSchema: unquoteCatalogIdentifier(routine[1]),
    routineName: unquoteCatalogIdentifier(routine[2]),
    definition,
  };
}

function unquoteCatalogIdentifier(identifier: string): string {
  return identifier.startsWith('"')
    ? identifier.slice(1, -1).replaceAll('""', '"')
    : identifier.toLocaleLowerCase();
}

function workspaceGeneration(generation: { value?: number } | number | null): number | null {
  if (typeof generation === "number") {
    return generation;
  }
  return typeof generation?.value === "number" ? generation.value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
