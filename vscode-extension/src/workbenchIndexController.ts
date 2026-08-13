import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import * as vscode from "vscode";
import { createCodeMonikerSyntaxParser } from "../../src/analysis/codeMonikerSyntax.js";
import type { SyntaxParser } from "../../src/analysis/syntaxTree.js";
import {
  type CodeMonikerClient,
  type CodeMonikerGraphResult,
  type CodeMonikerIdentityGraphPage,
  type CodeMonikerIdentitySegment,
  type CodeMonikerSymbol,
  ensureLocalCodeMonikerWorkspace,
  type LocalCodeMonikerSession,
} from "../../src/workbench/localCodeMoniker.js";
import {
  buildPostgresSourceSet,
  type CatalogQueryClient,
  PostgresCatalogFullRefreshRequired,
  type PostgresCatalogObjectOrigin,
  type PostgresCatalogPatch,
  type PostgresCatalogSnapshot,
  type PostgresForeignKey,
  type PostgresViewDependency,
  readPostgresCatalog,
  readPostgresCatalogDocuments,
  type VirtualSqlDocument,
  type VirtualSqlSourceSet,
} from "../../src/workbench/postgresCatalog.js";
import type { PostgresDdlObject } from "../../src/workbench/postgresDdlSync.js";
import {
  buildPostgresResourceIndex,
  directPostgresDocumentUris,
  type IndexedPostgresResource,
} from "../../src/workbench/postgresSourceProvider.js";
import {
  codeMonikerDocumentUri,
  codeMonikerIdentityUri,
  codeMonikerUri,
} from "./codeMonikerUri.js";
import type { ConnectionManager } from "./connectionManager.js";
import {
  buildWorkbenchRelationGroups,
  classifyWorkbenchRelationFailure,
  isWorkbenchRelationSnapshotCurrent,
  mergeWorkbenchRelationGroups,
  type WorkbenchRelationGroup,
} from "./workbenchRelations.js";
import {
  buildWorkbenchObjects,
  type WorkbenchObjectModel,
  workbenchObjectFromSymbol,
} from "./workbenchTreeModel.js";

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
  serverId?: string;
  message?: string;
  result?: WorkbenchIndexResult;
  progress?: WorkbenchIndexProgress;
  change?: {
    kind: "full" | "incremental";
    schemas: string[];
    sourceUris: string[];
  };
}

export interface WorkbenchIndexResult {
  serverId: string;
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
  serverId: string;
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
  serverId: string;
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
  retainedResult?: WorkbenchIndexResult;
  scope: string;
  serverId: string;
}

class WorkbenchIndexCancelledError extends Error {
  constructor() {
    super("PostgreSQL source indexing was cancelled");
    this.name = "WorkbenchIndexCancelledError";
  }
}

// Explicit debt exception: this snapshot owner still exposes registry lookup, Code Moniker
// runtime/session access, graph queries, catalog publication, and DDL synchronization. These
// capabilities must be split behind snapshot-bound ports before removing this exception.
// code-moniker: ignore[smell-large-class,smell-method-size-disharmony]
export class WorkbenchIndexController implements vscode.Disposable {
  private readonly stateEmitter = new vscode.EventEmitter<WorkbenchIndexState>();
  readonly onDidChangeState = this.stateEmitter.event;

  private currentState: WorkbenchIndexState = { status: "not-indexed" };
  private sessionPromise?: Promise<LocalCodeMonikerSession>;
  private activeSession?: LocalCodeMonikerSession;
  private removeSessionCloseListener?: () => void;
  private sessionEpoch = 0;
  private syntaxParserPromise?: Promise<SyntaxParser>;
  private currentRun?: Promise<WorkbenchIndexResult>;
  private activeIndexRun?: ActiveIndexRun;
  private currentSymbols: CodeMonikerSymbol[] = [];
  private currentDocuments = new Map<string, VirtualSqlDocument>();
  private currentOrigins = new Map<string, PostgresCatalogObjectOrigin>();
  private stateScope?: string;
  private readonly published = new Map<string, PublishedSourceSet>();
  private readonly registries = new Map<string, IndexedPostgresRegistry>();
  private readonly staleScopes = new Set<string>();
  private sourceMutation: Promise<void> = Promise.resolve();
  private readonly connectionSubscription: vscode.Disposable;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connections: ConnectionManager,
    private readonly output: vscode.OutputChannel,
  ) {
    this.connectionSubscription = connections.onChanged(() => this.observeConnection());
  }

  get state(): WorkbenchIndexState {
    return this.currentState;
  }

  get indexedSymbols(): readonly CodeMonikerSymbol[] {
    return this.currentState.result ? this.currentSymbols : [];
  }

  objectOrigin(sourceUri: string): PostgresCatalogObjectOrigin | undefined {
    return this.currentState.result ? this.currentOrigins.get(sourceUri) : undefined;
  }

  symbol(symbolUri: string): CodeMonikerSymbol | undefined {
    for (const registry of this.registries.values()) {
      const symbol = registry.symbols.find((candidate) => candidate.uri === symbolUri);
      if (symbol) return symbol;
    }
    return undefined;
  }

  routineSymbol(serverId: string, oid: number): CodeMonikerSymbol | undefined {
    for (const registry of this.registries.values()) {
      const symbol = registry.symbols.find(
        (candidate) =>
          candidate.postgres?.serverId === serverId &&
          candidate.postgres.oid === oid &&
          (candidate.kind === "function" || candidate.kind === "procedure"),
      );
      if (symbol) return symbol;
    }
    return undefined;
  }

  routineSourceUris(serverId: string): Record<string, string> {
    return Object.fromEntries(
      [...this.registries.values()]
        .flatMap(({ symbols }) => symbols)
        .flatMap((symbol) =>
          symbol.postgres?.serverId === serverId &&
          (symbol.kind === "function" || symbol.kind === "procedure")
            ? [
                [
                  String(symbol.postgres.oid),
                  this.documentUri(symbol.uri)?.toString() ?? symbol.uri,
                ],
              ]
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
      serverId: postgres.serverId,
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

  /**
   * Resolve the VS Code URI projection back to the exact symbol URI returned by
   * Code Moniker. VS Code normalizes percent-encoding when it materializes a
   * Uri, so its serialized form is not suitable as the identity registry key.
   */
  sourceDescriptorForDocumentUri(uri: vscode.Uri): WorkbenchSourceDescriptor | undefined {
    const documentKey = codeMonikerIdentityUri(uri).toString();
    for (const registry of this.registries.values()) {
      for (const symbol of registry.symbols) {
        if (codeMonikerUri(symbol.uri).toString() === documentKey) {
          return this.sourceDescriptor(symbol.uri);
        }
      }
    }
    return undefined;
  }

  sourceDocumentUris(): vscode.Uri[] {
    const uris: vscode.Uri[] = [];
    for (const registry of this.registries.values()) {
      for (const symbol of registry.symbols) {
        const uri = this.documentUri(symbol.uri);
        if (uri) uris.push(uri);
      }
    }
    return uris;
  }

  documentUri(symbolUri: string): vscode.Uri | undefined {
    const descriptor = this.sourceDescriptor(symbolUri);
    return descriptor ? codeMonikerDocumentUri(descriptor.symbolUri, descriptor) : undefined;
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

  async routineDependencies(routineOid: number): Promise<ReadonlySet<string> | undefined> {
    const server = this.connections.activeServer;
    if (!server || !this.connections.isConnected) return undefined;
    const database = { serverId: server.id, database: server.database };
    let result = this.currentState.result;
    if (
      this.currentState.status === "indexing" ||
      result?.serverId !== database.serverId ||
      result.database !== database.database
    ) {
      try {
        result = await this.indexActiveDatabase();
      } catch {
        return undefined;
      }
    }
    const routine = buildWorkbenchObjects(this.currentSymbols, database).find(
      (object) =>
        object.oid === routineOid && (object.kind === "function" || object.kind === "procedure"),
    );
    if (!routine || result.generation === null) return undefined;
    const snapshot = { revision: result.revision, generation: result.generation };
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
          workspaceGeneration(generationPage.generation),
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
        const object = workbenchObjectFromSymbol(this.enrichSymbol(callee.symbol), database);
        if (object?.kind === "function" || object?.kind === "procedure") {
          dependencies.add(`${object.schema}.${object.name}`);
        }
      }
      return dependencies;
    } catch (error) {
      this.output.appendLine(
        `workbench routine dependencies unavailable for OID ${routineOid}: ${errorMessage(error)}`,
      );
      return undefined;
    }
  }

  async graphChildren(
    prefix: string,
    snapshot: Pick<WorkbenchIndexResult, "revision" | "generation">,
  ): Promise<CodeMonikerIdentitySegment[]> {
    const result = this.requireGraphSnapshot(snapshot);
    const session = await this.ensureSession();
    const response = await session.client.graph.children(prefix, {}, { consistency: "stale_ok" });
    const status = await session.client.workspace.status();
    if (
      workspaceGeneration(status.generation ?? null) !== snapshot.generation ||
      !this.matchesSnapshot(result, snapshot)
    ) {
      throw new Error("The Code Moniker generation changed while loading graph children.");
    }
    return response.children.map((child) => ({
      ...child,
      symbol: child.symbol ? this.enrichSymbol(child.symbol) : child.symbol,
    }));
  }

  async graphScope(
    prefix: string,
    snapshot: Pick<WorkbenchIndexResult, "revision" | "generation">,
    cursor: unknown | null = null,
  ): Promise<WorkbenchIdentityGraphPage> {
    const result = this.requireGraphSnapshot(snapshot);
    const session = await this.ensureSession();
    const page = await session.client.graph.identity(
      prefix,
      { path: [databaseDocumentGlob(result.serverId, result.database)], minCount: 1 },
      { consistency: "stale_ok", limit: 200, cursor },
    );
    const generation = workspaceGeneration(page.generation);
    if (generation !== snapshot.generation || !this.matchesSnapshot(result, snapshot)) {
      throw new Error("The Code Moniker generation changed while loading the graph.");
    }
    return {
      ...page,
      data: {
        ...page.data,
        nodes: page.data.nodes.map((node) => ({
          ...node,
          symbol: node.symbol ? this.enrichSymbol(node.symbol) : node.symbol,
        })),
      },
      generation,
    };
  }

  async graphFocus(
    symbolUri: string,
    snapshot: Pick<WorkbenchIndexResult, "revision" | "generation">,
    limit = 200,
  ): Promise<CodeMonikerGraphResult> {
    const result = this.requireGraphSnapshot(snapshot);
    const session = await this.ensureSession();
    const graph = await session.client.graph.symbol(
      symbolUri,
      { relation: ["calls", "reads", "writes", "references", "uses_type"] },
      { consistency: "stale_ok", limit },
    );
    const status = await session.client.workspace.status();
    if (
      workspaceGeneration(status.generation ?? null) !== snapshot.generation ||
      !this.matchesSnapshot(result, snapshot)
    ) {
      throw new Error("The Code Moniker generation changed while loading the dependency graph.");
    }
    if (graph.focus.kind !== "symbol" || graph.focus.symbol?.uri !== symbolUri) {
      throw new Error("Code Moniker could not resolve the selected PostgreSQL object.");
    }
    return this.enrichGraph(graph);
  }

  async assertGraphSnapshot(
    snapshot: Pick<WorkbenchIndexResult, "revision" | "generation">,
  ): Promise<void> {
    const result = this.requireGraphSnapshot(snapshot);
    const session = await this.ensureSession();
    const status = await session.client.workspace.status();
    if (
      workspaceGeneration(status.generation ?? null) !== snapshot.generation ||
      !this.matchesSnapshot(result, snapshot)
    ) {
      throw new Error("The PostgreSQL graph snapshot changed while loading the view.");
    }
  }

  async graphSourcePreview(
    symbolUri: string,
    snapshot: Pick<WorkbenchIndexResult, "revision" | "generation">,
  ): Promise<WorkbenchGraphSourcePreview | undefined> {
    const result = this.requireGraphSnapshot(snapshot);
    const session = await this.ensureSession();
    const detail = await session.client.symbols.detail(
      symbolUri,
      { contextLines: 40 },
      { consistency: "stale_ok" },
    );
    const status = await session.client.workspace.status();
    if (
      workspaceGeneration(status.generation ?? null) !== snapshot.generation ||
      !this.matchesSnapshot(result, snapshot)
    ) {
      throw new Error("The Code Moniker generation changed while loading the source preview.");
    }
    const source = detail.source ?? detail.symbol.source;
    return source ? { symbol: this.enrichSymbol(detail.symbol), source } : undefined;
  }

  async relations(
    object: WorkbenchObjectModel,
    snapshot: Pick<WorkbenchIndexResult, "revision" | "generation">,
  ): Promise<WorkbenchRelationsResult> {
    const result = this.currentState.result;
    if (
      this.disposed ||
      this.currentState.status === "indexing" ||
      !result ||
      result.serverId !== object.serverId ||
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
        ...this.currentSymbols
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
      if (
        !isWorkbenchRelationSnapshotCurrent(
          workspaceGeneration(generationPage.generation),
          snapshot.generation,
          generationPage.data.rows.some((symbol) => symbol.uri === object.symbolUri),
        )
      ) {
        return {
          status: "stale",
          message: "The Code Moniker generation changed. Refresh the database index.",
        };
      }
      if (!this.matchesSnapshot(result, snapshot)) {
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
            buildWorkbenchRelationGroups(candidate, object, this.currentSymbols).map((group) => ({
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
        this.output.appendLine(`workbench relations failed for ${object.symbolUri}: ${message}`);
      }
      return { status, message };
    }
  }

  indexActiveDatabase(): Promise<WorkbenchIndexResult> {
    if (this.disposed) {
      return Promise.reject(new Error("The PostgreSQL Workbench index is disposed"));
    }
    if (!this.currentRun) {
      const epoch = this.sessionEpoch;
      this.currentRun = this.runIndex()
        .catch((error) => {
          if (error instanceof WorkbenchIndexCancelledError) throw error;
          if (this.sessionEpoch === epoch) throw error;
          this.output.appendLine(
            "Code Moniker connection closed during indexing; reconnecting once",
          );
          return this.runIndex();
        })
        .finally(() => {
          this.currentRun = undefined;
        });
    }
    return this.currentRun;
  }

  cancelActiveDatabaseIndex(): boolean {
    const run = this.activeIndexRun;
    if (!run || run.cancelled) return false;
    run.cancelled = true;
    if (this.activeScope() === run.scope) {
      this.setState({
        status: "indexing",
        serverId: run.serverId,
        result: run.retainedResult,
        message: run.retainedResult
          ? "Cancelling refresh; the previous snapshot remains available"
          : "Cancelling PostgreSQL source indexing",
        progress: { phase: "cancelling" },
      });
    }
    return true;
  }

  markDatabaseStale(serverId: string, database: string, message: string): void {
    const scope = databaseScope(serverId, database);
    this.staleScopes.add(scope);
    if (this.activeScope() !== scope) return;
    const registry = this.registries.get(scope);
    this.stateScope = scope;
    this.setState({ status: "stale", serverId, message, result: registry?.result });
  }

  isDatabaseStale(serverId: string, database: string): boolean {
    return this.staleScopes.has(databaseScope(serverId, database));
  }

  synchronizeActiveDatabaseDdl(
    client: CatalogQueryClient,
    identity: { serverId: string; database: string },
    objects: readonly PostgresDdlObject[],
    fallbackReason?: string,
  ): Promise<WorkbenchIndexResult> {
    const scope = databaseScope(identity.serverId, identity.database);
    if (this.activeScope() !== scope) {
      this.markDatabaseStale(identity.serverId, identity.database, "Schema changed while inactive");
      return Promise.reject(new Error("The changed PostgreSQL database is not active"));
    }
    const previous = this.currentRun;
    const synchronization = previous
      ? previous
          .catch(() => undefined)
          .then(() => this.runDdlSynchronization(client, identity, objects, fallbackReason))
      : this.runDdlSynchronization(client, identity, objects, fallbackReason);
    const queued = synchronization.finally(() => {
      if (this.currentRun === queued) this.currentRun = undefined;
    });
    this.currentRun = queued;
    return queued;
  }

  async indexPostgresDatabase(
    client: CatalogQueryClient,
    identity: { serverId: string; database: string },
  ): Promise<WorkbenchIndexResult> {
    if (this.disposed) {
      throw new Error("The PostgreSQL source registry is disposed");
    }
    const indexingStarted = performance.now();
    const catalog = await readPostgresCatalog(client, identity);
    const { result, session } = await this.publishAndReadCatalog(
      catalog,
      identity.serverId,
      identity.database,
      indexingStarted,
      () => true,
    );
    this.logResult(result, session);
    return result;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.currentSymbols = [];
    this.currentDocuments.clear();
    this.currentOrigins.clear();
    this.registries.clear();
    this.connectionSubscription.dispose();
    this.stateEmitter.dispose();
    const pendingSession = this.sessionPromise;
    this.sessionPromise = undefined;
    this.activeSession = undefined;
    this.removeSessionCloseListener?.();
    this.removeSessionCloseListener = undefined;
    this.syntaxParserPromise = undefined;
    if (pendingSession) {
      void this.sourceMutation
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

  private async runIndex(): Promise<WorkbenchIndexResult> {
    const indexingStarted = performance.now();
    const server = this.connections.activeServer;
    const postgres = this.connections.getClient();
    if (!server || !postgres || !this.connections.isConnected) {
      throw new Error("Connect to a PostgreSQL database before indexing it");
    }

    const serverId = server.id;
    const database = server.database;
    const scope = databaseScope(serverId, database);
    const retainedResult = this.stateScope === scope ? this.currentState.result : undefined;
    const run: ActiveIndexRun = {
      cancelled: false,
      retainedResult,
      scope,
      serverId,
    };
    this.activeIndexRun = run;
    if (!retainedResult) {
      this.currentSymbols = [];
      this.currentDocuments.clear();
      this.currentOrigins.clear();
    }
    this.stateScope = scope;
    this.setState({
      status: "indexing",
      serverId,
      result: retainedResult,
      message: retainedResult ? "Refreshing the PostgreSQL source snapshot" : undefined,
      progress: { phase: "reading-catalog" },
    });
    try {
      await this.pauseForAcceptance(run);
      const catalog = await readPostgresCatalog(catalogClient(postgres), {
        serverId,
        database,
      });
      this.throwIfCancelled(run);
      if (this.activeScope() !== scope) {
        throw new Error("The active PostgreSQL connection changed during indexing");
      }

      const indexed = await this.publishAndReadCatalog(
        catalog,
        serverId,
        database,
        indexingStarted,
        () => this.activeScope() === scope,
        (progress) => this.reportProgress(run, progress),
        () => this.throwIfCancelled(run),
      );
      const { result, registry, session } = indexed;
      this.currentSymbols = registry.symbols;
      this.currentDocuments = registry.documents;
      this.currentOrigins = registry.origins;
      this.staleScopes.delete(scope);
      this.setState({
        status: "available",
        serverId,
        result,
        change: { kind: "full", schemas: [], sourceUris: [] },
      });
      this.logResult(result, session);
      return result;
    } catch (error) {
      const failure = run.cancelled ? new WorkbenchIndexCancelledError() : error;
      const message = failure instanceof Error ? failure.message : String(failure);
      if (this.activeScope() === scope) {
        if (failure instanceof WorkbenchIndexCancelledError) {
          this.setState({
            status: "cancelled",
            serverId,
            message: retainedResult
              ? "Refresh cancelled; showing the previous snapshot"
              : "Indexing cancelled",
            result: retainedResult,
          });
        } else if (retainedResult) {
          this.setState({ status: "error", serverId, message, result: retainedResult });
        } else {
          this.currentSymbols = [];
          this.currentDocuments.clear();
          this.currentOrigins.clear();
          this.setState({ status: "error", serverId, message });
        }
      } else if (this.stateScope === scope && this.currentState.status === "indexing") {
        this.stateScope = undefined;
        this.setState({ status: "not-indexed" });
      }
      this.output.appendLine(
        failure instanceof WorkbenchIndexCancelledError
          ? `workbench index cancelled: ${message}`
          : `workbench index failed: ${message}`,
      );
      throw failure;
    } finally {
      if (this.activeIndexRun === run) this.activeIndexRun = undefined;
    }
  }

  private async runDdlSynchronization(
    client: CatalogQueryClient,
    identity: { serverId: string; database: string },
    objects: readonly PostgresDdlObject[],
    fallbackReason?: string,
  ): Promise<WorkbenchIndexResult> {
    const scope = databaseScope(identity.serverId, identity.database);
    const registry = this.registries.get(scope);
    this.markDatabaseStale(
      identity.serverId,
      identity.database,
      fallbackReason ? `Schema changed: ${fallbackReason}` : "Applying PostgreSQL schema changes",
    );
    if (fallbackReason || !registry) {
      this.output.appendLine(
        `workbench DDL full-refresh fallback: ${fallbackReason ?? "no indexed baseline"}`,
      );
      return this.runIndex();
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
        identity.serverId,
        identity.database,
        performance.now(),
        () => this.activeScope() === scope,
      );
      this.currentSymbols = indexed.registry.symbols;
      this.currentDocuments = indexed.registry.documents;
      this.currentOrigins = indexed.registry.origins;
      this.staleScopes.delete(scope);
      this.setState({
        status: "available",
        serverId: identity.serverId,
        result: indexed.result,
        change: {
          kind: "incremental",
          schemas: [...new Set(objects.flatMap((object) => object.schemaName ?? []))].sort(),
          sourceUris: [
            ...new Set([
              ...selection.documentUris,
              ...patch.upsertDocuments.map((document) => document.uri),
              ...patch.removeDocumentUris,
            ]),
          ].sort(),
        },
      });
      this.output.appendLine(
        `workbench DDL direct refresh: objects=${objects.length} existing=${selection.documentUris.size} new=${selection.newResources.length} documents=${patch.upsertDocuments.length} removed=${patch.removeDocumentUris.length}`,
      );
      return indexed.result;
    } catch (error) {
      const reason =
        error instanceof PostgresCatalogFullRefreshRequired
          ? error.message
          : `incremental update failed: ${error instanceof Error ? error.message : String(error)}`;
      this.output.appendLine(`workbench DDL full-refresh fallback: ${reason}`);
      return this.runIndex();
    }
  }

  private async publishAndReadCatalog(
    catalog: PostgresCatalogSnapshot,
    serverId: string,
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
    const scope = databaseScope(serverId, database);
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
        serverId,
        isCurrent,
        () => {
          sourceSetReplaced = true;
        },
      );
      if (!isCurrent()) throw new Error("The PostgreSQL source scope changed during indexing");
      await reportProgress?.({ phase: "reading-symbols", completed: 0, unit: "symbols" });
      const indexed = await this.readDatabaseSymbols(
        session,
        serverId,
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
        serverId,
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
    serverId: string,
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
        serverId,
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
    serverId: string,
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
          path: [databaseDocumentGlob(serverId, database)],
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

  private enrichSymbol(symbol: CodeMonikerSymbol): CodeMonikerSymbol {
    return enrichSymbol(symbol, this.currentDocuments);
  }

  private enrichGraph(graph: CodeMonikerGraphResult): CodeMonikerGraphResult {
    return {
      ...graph,
      focus: {
        ...graph.focus,
        symbol: graph.focus.symbol ? this.enrichSymbol(graph.focus.symbol) : undefined,
      },
      callers: graph.callers.map((neighbor) => ({
        ...neighbor,
        symbol: this.enrichSymbol(neighbor.symbol),
      })),
      callees: graph.callees.map((neighbor) => ({
        ...neighbor,
        symbol: this.enrichSymbol(neighbor.symbol),
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
          this.output.appendLine(
            `Code Moniker daemon ${session.metadata.daemonPid} disconnected; session invalidated`,
          );
        });
        this.output.appendLine(
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
    return resolve(this.context.extensionPath, "runtime", "code-moniker");
  }

  private codeMonikerCommandTimeoutMs(): number {
    return vscode.workspace
      .getConfiguration("postgresql-workbench.workbench.codeMoniker")
      .get<number>("commandTimeoutMs", 30_000);
  }

  private workspaceRoots(): string[] {
    const roots =
      vscode.workspace.workspaceFolders
        ?.filter((folder) => folder.uri.scheme === "file")
        .map((folder) => folder.uri.fsPath) ?? [];
    if (roots.length > 0) {
      return roots;
    }
    const fallback = vscode.Uri.joinPath(
      this.context.globalStorageUri,
      "code-moniker-workspace",
    ).fsPath;
    mkdirSync(fallback, { recursive: true });
    return [fallback];
  }

  private observeConnection(): void {
    const activeScope = this.activeScope();
    if (!this.stateScope || activeScope === this.stateScope) return;
    this.currentSymbols = [];
    this.currentDocuments.clear();
    this.currentOrigins.clear();
    this.stateScope = activeScope;
    const registry = activeScope ? this.registries.get(activeScope) : undefined;
    if (registry) {
      const stale = activeScope !== undefined && this.staleScopes.has(activeScope);
      this.currentSymbols = registry.symbols;
      this.currentDocuments = registry.documents;
      this.currentOrigins = registry.origins;
      this.setState({
        status: stale ? "stale" : "available",
        serverId: registry.result.serverId,
        message: stale
          ? "PostgreSQL schema changed while this DatabaseContext was inactive"
          : undefined,
        result: registry.result,
      });
    } else {
      this.setState({ status: "not-indexed" });
    }
  }

  private activeScope(): string | undefined {
    if (this.disposed) {
      return undefined;
    }
    const server = this.connections.isConnected ? this.connections.activeServer : undefined;
    return server ? databaseScope(server.id, server.database) : undefined;
  }

  private matchesSnapshot(
    result: WorkbenchIndexResult,
    snapshot: Pick<WorkbenchIndexResult, "revision" | "generation">,
  ): boolean {
    return (
      !this.disposed &&
      this.currentState.status !== "indexing" &&
      this.currentState.result === result &&
      result.revision === snapshot.revision &&
      result.generation === snapshot.generation
    );
  }

  private requireGraphSnapshot(
    snapshot: Pick<WorkbenchIndexResult, "revision" | "generation">,
  ): WorkbenchIndexResult {
    const result = this.currentState.result;
    if (!result || !this.matchesSnapshot(result, snapshot)) {
      throw new Error("This graph belongs to an outdated PostgreSQL Workbench snapshot.");
    }
    return result;
  }

  private mutateSources<T>(action: () => Promise<T>): Promise<T> {
    const result = this.sourceMutation.then(action, action);
    this.sourceMutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private setState(state: WorkbenchIndexState): void {
    if (this.disposed) {
      return;
    }
    this.currentState = state;
    this.stateEmitter.fire(state);
  }

  private async reportProgress(
    run: ActiveIndexRun,
    progress: WorkbenchIndexProgress,
  ): Promise<void> {
    this.throwIfCancelled(run);
    if (this.activeScope() !== run.scope) {
      throw new Error("The PostgreSQL source scope changed during indexing");
    }
    this.setState({
      status: "indexing",
      serverId: run.serverId,
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
    const delay = Number.parseInt(
      process.env.POSTGRESQL_WORKBENCH_ACCEPTANCE_INDEX_PHASE_DELAY_MS ?? "0",
      10,
    );
    if (
      delay > 0 &&
      process.env.POSTGRESQL_WORKBENCH_ACCEPTANCE_CONTROL_FILE &&
      this.context.extensionMode !== vscode.ExtensionMode.Production
    ) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 2_000)));
    }
    this.throwIfCancelled(run);
  }

  private logResult(result: WorkbenchIndexResult, session: LocalCodeMonikerSession): void {
    this.output.appendLine(
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
  identity: { serverId: string; database: string },
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

  const affected = new Set([...patch.affectedRelationOids, ...removedOids]);
  const foreignKeys = registry.foreignKeys
    .filter(
      (foreignKey) =>
        !affected.has(foreignKey.sourceTableOid) && !affected.has(foreignKey.targetTableOid),
    )
    .concat(patch.foreignKeys);
  const viewDependencies = registry.viewDependencies
    .filter(
      (dependency) =>
        !affected.has(dependency.sourceViewOid) && !affected.has(dependency.targetRelationOid),
    )
    .concat(patch.viewDependencies);
  const sourceSet = buildPostgresSourceSet(identity, [...documents.values()], origins);
  return {
    sourceSet,
    metrics: {
      introspectionMs: patch.introspectionMs,
      materializationMs: patch.materializationMs,
      documentCount: sourceSet.documents.length,
    },
    origins,
    foreignKeys,
    viewDependencies,
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

function databaseScope(serverId: string, database: string): string {
  return `${serverId}\0${database}`;
}

function databaseDocumentGlob(serverId: string, database: string): string {
  return `postgresql://${encodeURIComponent(serverId)}/${encodeURIComponent(database)}/**`;
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
