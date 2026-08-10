import * as vscode from "vscode";
import type {
  CodeMonikerGraphResult,
  CodeMonikerIdentityGraphResult,
  CodeMonikerSymbol,
} from "../../src/workbench/localCodeMoniker.js";
import { GraphNavigation } from "./workbenchGraph/navigation.js";
import { WorkbenchGraphPanel } from "./workbenchGraph/panel.js";
import type {
  CockpitNeighborhood,
  CockpitPerspective,
  CockpitPerspectiveState,
  CockpitSession,
  WorkbenchGraphBreadcrumb,
  WorkbenchGraphHostMessage,
  WorkbenchGraphIdentityPresentation,
  WorkbenchGraphRenderEvidence,
  WorkbenchGraphSearchResult,
  WorkbenchGraphWebviewMessage,
} from "./workbenchGraph/protocol.js";
import {
  cockpitBreadcrumbs,
  databaseLandingIdentity,
  initialCockpitGraph,
  neighborhoodFromGraph,
  presentationsForSymbols,
  resolveCockpitTarget,
  schemaLandingIdentity,
  searchGraphObjects,
  sourcePreviewPresentation,
} from "./workbenchGraph/sqlProjection.js";
import type { WorkbenchIndexController, WorkbenchIndexResult } from "./workbenchIndexController.js";
import {
  buildWorkbenchObjects,
  type WorkbenchDatabaseIdentity,
  type WorkbenchObjectModel,
  workbenchObjectFromSymbol,
} from "./workbenchTreeModel.js";

type WorkbenchSnapshot = Pick<WorkbenchIndexResult, "revision" | "generation">;

interface NavigationState {
  perspective?: CockpitPerspective;
}

export interface WorkbenchGraphAck {
  prefix: string;
  renderId: number;
  webviewRenderId: number;
  rendered: WorkbenchGraphRenderEvidence;
}

export interface WorkbenchGraphViewOptions {
  extensionUri: vscode.Uri;
  index: WorkbenchIndexController;
  openDefinition: (object: WorkbenchObjectModel, snapshot: WorkbenchSnapshot) => Promise<unknown>;
  showActions: (object: WorkbenchObjectModel, snapshot: WorkbenchSnapshot) => Promise<unknown>;
  selectInTree?: (object: WorkbenchObjectModel, snapshot: WorkbenchSnapshot) => Promise<unknown>;
  workspaceState?: vscode.Memento;
  collectRenderEvidence?: boolean;
}

// Explicit debt exception: this host controller still coordinates navigation/session state,
// webview messages, search counts, and perspective persistence. Keeping one owner avoids split
// snapshot lifecycles; future extraction should start with search and perspective capabilities.
// code-moniker: ignore[smell-large-class]
export class WorkbenchGraphView implements vscode.Disposable {
  private readonly panel: WorkbenchGraphPanel;
  private readonly navigation = new GraphNavigation<NavigationState>();
  private snapshot?: WorkbenchSnapshot;
  private database?: WorkbenchDatabaseIdentity;
  private graph?: CodeMonikerIdentityGraphResult;
  private session?: CockpitSession;
  private presentations: Record<string, WorkbenchGraphIdentityPresentation> = {};
  private lastMessage?: WorkbenchGraphHostMessage;
  private renderSequence = 0;
  private loadSequence = 0;
  private searchSequence = 0;
  private readonly counts = new Map<string, { incoming: number; outgoing: number }>();
  private readonly pinnedIdentities = new Set<string>();
  private readonly acknowledgements: WorkbenchGraphAck[] = [];
  private webviewRenderSequence = 0;
  private disposed = false;
  private readonly index: WorkbenchIndexController;
  private readonly openDefinition: WorkbenchGraphViewOptions["openDefinition"];
  private readonly showActions: WorkbenchGraphViewOptions["showActions"];
  private readonly selectInTree: NonNullable<WorkbenchGraphViewOptions["selectInTree"]>;
  private readonly workspaceState: vscode.Memento | undefined;

  constructor(options: WorkbenchGraphViewOptions) {
    this.index = options.index;
    this.openDefinition = options.openDefinition;
    this.showActions = options.showActions;
    this.selectInTree = options.selectInTree ?? (async () => undefined);
    this.workspaceState = options.workspaceState;
    this.panel = new WorkbenchGraphPanel(
      options.extensionUri,
      (message) => this.receive(message),
      () => this.reset(),
      options.collectRenderEvidence ?? false,
    );
  }

  get visible(): boolean {
    return this.panel.visible;
  }

  get currentModel(): CodeMonikerIdentityGraphResult | undefined {
    return this.graph;
  }

  get currentScope(): string | undefined {
    return this.graph?.prefix ?? this.navigation.current;
  }

  get currentRenderId(): number | undefined {
    return this.session?.renderId;
  }

  get currentBreadcrumbs(): readonly WorkbenchGraphBreadcrumb[] {
    return this.session?.breadcrumbs ?? [];
  }

  get currentPresentations(): Readonly<Record<string, WorkbenchGraphIdentityPresentation>> {
    return this.presentations;
  }

  get historyDepth(): number {
    return this.navigation.depth;
  }

  get webviewAcks(): readonly WorkbenchGraphAck[] {
    return this.acknowledgements;
  }

  async open(object: WorkbenchObjectModel, snapshot: WorkbenchSnapshot): Promise<boolean> {
    if (this.disposed) return false;
    const changed = this.setContext(
      { serverId: object.serverId, database: object.database },
      snapshot,
    );
    this.panel.ensure(object.database);
    this.panel.reveal();
    if (changed) {
      this.navigation.reset(
        databaseLandingIdentity(this.index.indexedSymbols, object) ?? object.symbolUri,
      );
    }
    return this.focusNode(object.symbolUri);
  }

  async openDatabase(
    database: WorkbenchDatabaseIdentity,
    snapshot: WorkbenchSnapshot,
  ): Promise<boolean> {
    if (this.disposed) return false;
    this.setContext(database, snapshot);
    this.panel.ensure(database.database);
    this.panel.reveal();
    const prefix = databaseLandingIdentity(this.index.indexedSymbols, database);
    if (!prefix) return false;
    this.navigation.reset(prefix);
    return this.showLanding(prefix);
  }

  async openSchema(
    database: WorkbenchDatabaseIdentity,
    schema: string,
    snapshot: WorkbenchSnapshot,
  ): Promise<boolean> {
    if (this.disposed) return false;
    this.setContext(database, snapshot);
    this.panel.ensure(database.database);
    this.panel.reveal();
    const prefix = schemaLandingIdentity(this.index.indexedSymbols, database, schema);
    if (!prefix) return false;
    this.navigation.reset(prefix);
    return this.showLanding(prefix, schema);
  }

  async focusNode(prefix: string): Promise<boolean> {
    if (!this.snapshot || !this.database || !prefix) return false;
    const checkpoint = this.navigation.snapshot();
    if (this.navigation.current !== prefix) this.navigation.push(prefix);
    const result = await this.show(prefix);
    if (!result) this.navigation.restore(checkpoint);
    return result;
  }

  async syncObjectFromTree(
    object: WorkbenchObjectModel,
    snapshot: WorkbenchSnapshot,
  ): Promise<boolean> {
    if (!this.panel.current || this.disposed) return false;
    if (!this.matchesContext(object, snapshot)) return this.open(object, snapshot);
    return this.focusNode(object.symbolUri);
  }

  async syncSchemaFromTree(schema: string, snapshot: WorkbenchSnapshot): Promise<boolean> {
    if (!this.panel.current || !this.database || !this.sameSnapshot(snapshot)) return false;
    const prefix = schemaLandingIdentity(this.index.indexedSymbols, this.database, schema);
    if (!prefix) return false;
    const checkpoint = this.navigation.snapshot();
    this.navigation.push(prefix);
    const result = await this.showLanding(prefix, schema);
    if (!result) this.navigation.restore(checkpoint);
    return result;
  }

  async back(): Promise<boolean> {
    return this.stepHistory(-1);
  }

  async forward(): Promise<boolean> {
    return this.stepHistory(1);
  }

  async openNodeDefinition(symbolUri: string): Promise<boolean> {
    const object = this.objectFor(symbolUri);
    if (!object || !this.snapshot) return false;
    try {
      await this.index.assertGraphSnapshot(this.snapshot);
      const result = await this.openDefinition(object, this.snapshot);
      return result !== undefined && result !== false;
    } catch {
      return false;
    }
  }

  invalidateDatabaseContext(): void {
    this.reset();
    this.lastMessage = {
      type: "databaseContextInvalidated",
      message: "The active PostgreSQL database context changed. Open the active graph again.",
    };
    void this.panel.post(this.lastMessage);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.panel.dispose();
  }

  private setContext(database: WorkbenchDatabaseIdentity, snapshot: WorkbenchSnapshot): boolean {
    const changed =
      this.database?.serverId !== database.serverId ||
      this.database.database !== database.database ||
      !this.sameSnapshot(snapshot);
    this.database = database;
    this.snapshot = snapshot;
    if (changed) {
      this.counts.clear();
      this.pinnedIdentities.clear();
      this.presentations = {};
      this.graph = undefined;
      this.loadSequence += 1;
      this.searchSequence += 1;
    }
    return changed;
  }

  private matchesContext(object: WorkbenchObjectModel, snapshot: WorkbenchSnapshot): boolean {
    return (
      this.database?.serverId === object.serverId &&
      this.database.database === object.database &&
      this.sameSnapshot(snapshot)
    );
  }

  private sameSnapshot(snapshot: WorkbenchSnapshot): boolean {
    return (
      this.snapshot?.revision === snapshot.revision &&
      this.snapshot.generation === snapshot.generation
    );
  }

  private async show(prefix: string, perspective?: CockpitPerspective): Promise<boolean> {
    if (!this.database) return false;
    const target = resolveCockpitTarget(prefix, this.index.indexedSymbols, this.database);
    return target.kind === "object"
      ? this.showFocus(target.symbol, perspective)
      : this.showLanding(prefix, target.schemaHint);
  }

  private async showLanding(prefix: string, schemaHint?: string): Promise<boolean> {
    if (!this.snapshot || !this.database || !this.panel.current) return false;
    const session = this.createSession(
      schemaHint
        ? [
            {
              prefix: databaseLandingIdentity(this.index.indexedSymbols, this.database) ?? prefix,
              label: this.database.database,
            },
            { prefix, label: schemaHint },
          ]
        : [{ prefix, label: this.database.database }],
      schemaHint,
    );
    this.graph = emptyGraph(prefix);
    this.presentations = {};
    this.session = session;
    this.lastMessage = { type: "cockpitSession", session };
    this.panel.setTitle(`${schemaHint ? `${schemaHint} · ` : ""}${this.database.database}`);
    await this.panel.post(this.lastMessage);
    return true;
  }

  private async showFocus(
    symbol: CodeMonikerSymbol,
    perspective?: CockpitPerspective,
  ): Promise<boolean> {
    const snapshot = this.snapshot;
    const database = this.database;
    const panel = this.panel.current;
    if (!snapshot || !database || !panel) return false;
    const sequence = ++this.loadSequence;
    try {
      const [source, sourcePreview] = await Promise.all([
        this.index.graphFocus(symbol.uri, snapshot),
        this.index.graphSourcePreview(symbol.uri, snapshot),
      ]);
      await this.index.assertGraphSnapshot(snapshot);
      if (sequence !== this.loadSequence || panel !== this.panel.current) return false;
      const neighborhood = neighborhoodFromGraph(source, database, this.index.indexedSymbols);
      this.rememberCounts(source);
      const symbols = neighborhoodSymbols(neighborhood);
      const presentations = presentationsForSymbols(symbols, database, (sourceUri) =>
        this.index.objectOrigin(sourceUri),
      );
      const pinned = this.pinnedForFocus(perspective, presentations);
      const breadcrumbs = cockpitBreadcrumbs(symbol, database, this.index.indexedSymbols);
      const session = this.createSession(breadcrumbs);
      this.graph = initialCockpitGraph(neighborhood);
      this.presentations = presentations;
      this.session = session;
      const preview = sourcePreview ? sourcePreviewPresentation(sourcePreview) : undefined;
      this.lastMessage = {
        type: "cockpitFocus",
        payload: { session, neighborhood, presentations, pinned, preview, perspective },
      };
      this.panel.setTitle(presentations[symbol.uri]?.label ?? symbol.name);
      await this.panel.post(this.lastMessage);
      const object = workbenchObjectFromSymbol(symbol, database);
      if (object) await this.selectInTree(object, snapshot);
      return true;
    } catch (error) {
      if (sequence === this.loadSequence) this.postError(error);
      return false;
    }
  }

  private createSession(
    breadcrumbs: WorkbenchGraphBreadcrumb[],
    schemaHint?: string,
  ): CockpitSession {
    const objects = this.database
      ? buildWorkbenchObjects(this.index.indexedSymbols, this.database)
      : [];
    return {
      renderId: ++this.renderSequence,
      serverId: this.database?.serverId ?? "",
      database: this.database?.database ?? "PostgreSQL",
      revision: this.snapshot?.revision ?? "",
      generation: this.snapshot?.generation ?? null,
      breadcrumbs,
      canBack: this.navigation.canBack,
      canForward: this.navigation.canForward,
      perspectives: this.readPerspectives(),
      searchFacets: {
        schemas: [...new Set(objects.map((object) => object.schema))].sort(),
        kinds: ["table", "view", "function", "procedure", "trigger", "column", "constraint"],
      },
      schemaHint,
    };
  }

  private async stepHistory(delta: -1 | 1): Promise<boolean> {
    const checkpoint = this.navigation.snapshot();
    const target = this.navigation.move(delta);
    if (!target) return false;
    const result = await this.show(target, this.navigation.currentState?.perspective);
    if (!result) this.navigation.restore(checkpoint);
    return result;
  }

  private receive(message: WorkbenchGraphWebviewMessage): void {
    switch (message.type) {
      case "ready":
        if (this.lastMessage) void this.panel.post(this.lastMessage);
        break;
      case "focus":
        void this.focusNode(message.prefix);
        break;
      case "back":
        void this.back();
        break;
      case "forward":
        void this.forward();
        break;
      case "requestNeighborhood":
        void this.sendNeighborhood(message);
        break;
      case "search":
        this.search(message.query, message.requestId);
        break;
      case "inspect":
        void this.inspect(message.symbolUri);
        break;
      case "open":
        void this.openNodeDefinition(message.symbolUri);
        break;
      case "actions":
        void this.actions(message.symbolUri);
        break;
      case "pin":
        if (message.pinned) this.pinnedIdentities.add(message.symbolUri);
        else this.pinnedIdentities.delete(message.symbolUri);
        break;
      case "savePerspective":
        void this.savePerspective(message.state);
        break;
      case "loadPerspective":
        void this.loadPerspective(message.name);
        break;
      case "deletePerspective":
        void this.deletePerspective(message.name);
        break;
      case "ack":
        if (message.renderId === this.session?.renderId) {
          this.acknowledgements.push({
            prefix: this.currentScope ?? "",
            renderId: message.renderId,
            webviewRenderId: ++this.webviewRenderSequence,
            rendered: message.rendered,
          });
          if (this.acknowledgements.length > 30) this.acknowledgements.splice(0, 10);
        }
        break;
    }
  }

  private async sendNeighborhood(
    message: Extract<WorkbenchGraphWebviewMessage, { type: "requestNeighborhood" }>,
  ): Promise<void> {
    const snapshot = this.snapshot;
    const database = this.database;
    if (!snapshot || !database) return;
    try {
      const source = await this.index.graphFocus(message.symbolUri, snapshot);
      const neighborhood = neighborhoodFromGraph(source, database, this.index.indexedSymbols);
      this.rememberCounts(source);
      const symbols = neighborhoodSymbols(neighborhood);
      const presentations = presentationsForSymbols(symbols, database, (sourceUri) =>
        this.index.objectOrigin(sourceUri),
      );
      await this.panel.post({
        type: "cockpitNeighborhood",
        requestId: message.requestId,
        intent: message.intent,
        direction: message.direction,
        neighborhood,
        presentations,
      });
    } catch (error) {
      this.postError(error);
    }
  }

  private async inspect(symbolUri: string): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const preview = await this.index.graphSourcePreview(symbolUri, snapshot);
    if (!preview) return;
    const presentation = sourcePreviewPresentation(preview);
    await this.panel.post({ type: "cockpitPreview", preview: presentation });
  }

  private async actions(symbolUri: string): Promise<void> {
    const object = this.objectFor(symbolUri);
    if (!object || !this.snapshot) return;
    await this.showActions(object, this.snapshot);
  }

  private search(query: string, requestId: number): void {
    const database = this.database;
    const snapshot = this.snapshot;
    const normalized = query.trim();
    const sequence = ++this.searchSequence;
    const results = database
      ? searchGraphObjects(this.index.indexedSymbols, database, normalized, (sourceUri) =>
          this.index.objectOrigin(sourceUri),
        ).map((result) => withCounts(result, this.counts.get(result.symbolUri)))
      : [];
    void this.panel.post({ type: "searchResults", requestId, query: normalized, results });
    if (!snapshot || !normalized) return;
    const missing = [
      ...new Set(
        results
          .filter((result) => result.countStatus === "loading")
          .map((result) => result.symbolUri),
      ),
    ];
    void this.loadSearchCounts(missing, results, normalized, requestId, sequence, snapshot);
  }

  private async loadSearchCounts(
    identities: readonly string[],
    results: readonly WorkbenchGraphSearchResult[],
    query: string,
    requestId: number,
    sequence: number,
    snapshot: WorkbenchSnapshot,
  ): Promise<void> {
    const unavailable = new Set<string>();
    for (let offset = 0; offset < identities.length; offset += 4) {
      const batch = identities.slice(offset, offset + 4);
      const loaded = await Promise.allSettled(
        batch.map((identity) => this.index.graphFocus(identity, snapshot, 1)),
      );
      if (sequence !== this.searchSequence || !this.sameSnapshot(snapshot)) return;
      for (const [index, result] of loaded.entries()) {
        if (result.status === "fulfilled") this.rememberCounts(result.value);
        else unavailable.add(batch[index]);
      }
      await this.panel.post({
        type: "searchResults",
        requestId,
        query,
        results: results.map((result) =>
          withCounts(result, this.counts.get(result.symbolUri), unavailable.has(result.symbolUri)),
        ),
      });
    }
  }

  private rememberCounts(source: CodeMonikerGraphResult): void {
    const identity = source.focus.symbol?.uri;
    if (!identity) return;
    this.counts.set(identity, {
      incoming: source.coverage.callers.matching,
      outgoing: source.coverage.callees.matching,
    });
  }

  private pinnedForFocus(
    perspective: CockpitPerspective | undefined,
    presentations: Record<string, WorkbenchGraphIdentityPresentation>,
  ): Array<{
    symbol: CodeMonikerSymbol;
    presentation: WorkbenchGraphIdentityPresentation;
  }> {
    if (!this.database) return [];
    const requested = new Set([
      ...this.pinnedIdentities,
      ...(perspective?.state.pinnedIdentities ?? []),
    ]);
    const symbols = this.index.indexedSymbols.filter((symbol) => requested.has(symbol.uri));
    const pinnedPresentations = presentationsForSymbols(symbols, this.database, (sourceUri) =>
      this.index.objectOrigin(sourceUri),
    );
    return symbols.map((symbol) => ({
      symbol,
      presentation: presentations[symbol.uri] ??
        pinnedPresentations[symbol.uri] ?? {
          label: symbol.name,
          kind: symbol.kind,
        },
    }));
  }

  private perspectiveKey(): string {
    return `plpgsql.cockpit.perspectives.${this.database?.serverId ?? "none"}.${this.database?.database ?? "none"}`;
  }

  private readPerspectives(): CockpitPerspective[] {
    return this.workspaceState?.get<CockpitPerspective[]>(this.perspectiveKey(), []) ?? [];
  }

  private async savePerspective(state: CockpitPerspectiveState): Promise<void> {
    if (!this.workspaceState) return;
    const name = await vscode.window.showInputBox({
      title: "Save SQL cockpit perspective",
      prompt: "Name this impact-analysis layout",
      placeHolder: "billing, stock, fulfillment…",
      validateInput: (value) => (value.trim() ? undefined : "A name is required."),
    });
    if (!name?.trim()) return;
    const perspectives = this.readPerspectives().filter((item) => item.name !== name.trim());
    perspectives.push({ name: name.trim(), state });
    await this.workspaceState.update(this.perspectiveKey(), perspectives);
    await this.panel.post({ type: "cockpitPerspectives", perspectives });
  }

  private async loadPerspective(name: string): Promise<void> {
    const perspective = this.readPerspectives().find((item) => item.name === name);
    if (!perspective) return;
    this.pinnedIdentities.clear();
    for (const identity of perspective.state.pinnedIdentities) {
      this.pinnedIdentities.add(identity);
    }
    const checkpoint = this.navigation.snapshot();
    this.navigation.push(perspective.state.focusIdentity);
    this.navigation.setState({ perspective });
    if (!(await this.show(perspective.state.focusIdentity, perspective))) {
      this.navigation.restore(checkpoint);
    }
  }

  private async deletePerspective(name: string): Promise<void> {
    if (!this.workspaceState) return;
    const perspectives = this.readPerspectives().filter((item) => item.name !== name);
    await this.workspaceState.update(this.perspectiveKey(), perspectives);
    await this.panel.post({ type: "cockpitPerspectives", perspectives });
  }

  private objectFor(symbolUri: string): WorkbenchObjectModel | undefined {
    const symbol = this.index.indexedSymbols.find((candidate) => candidate.uri === symbolUri);
    return symbol && this.database ? workbenchObjectFromSymbol(symbol, this.database) : undefined;
  }

  private postError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.lastMessage = { type: "scopeError", message };
    void this.panel.post(this.lastMessage);
  }

  private reset(): void {
    this.snapshot = undefined;
    this.database = undefined;
    this.graph = undefined;
    this.session = undefined;
    this.presentations = {};
    this.navigation.clear();
    this.lastMessage = undefined;
    this.loadSequence += 1;
    this.searchSequence += 1;
    this.counts.clear();
    this.pinnedIdentities.clear();
  }
}

function neighborhoodSymbols(neighborhood: CockpitNeighborhood): CodeMonikerSymbol[] {
  return [
    neighborhood.focus,
    ...neighborhood.incoming.map((neighbor) => neighbor.symbol),
    ...neighborhood.outgoing.map((neighbor) => neighbor.symbol),
  ];
}

function withCounts(
  result: WorkbenchGraphSearchResult,
  counts?: { incoming: number; outgoing: number },
  unavailable = false,
): WorkbenchGraphSearchResult {
  if (result.resultType === "schema") return result;
  return {
    ...result,
    ...counts,
    countStatus: counts ? "available" : unavailable ? "unavailable" : "loading",
  };
}

function emptyGraph(prefix: string): CodeMonikerIdentityGraphResult {
  return {
    prefix,
    path: [],
    min_count: 1,
    nodes: [],
    edges: [],
    ports_in: [],
    ports_out: [],
    coverage: {
      nodes_emitted: 0,
      nodes_total: 0,
      edges_emitted: 0,
      edges_matching: 0,
      edges_total: 0,
      ports_in_emitted: 0,
      ports_in_matching: 0,
      ports_in_total: 0,
      ports_out_emitted: 0,
      ports_out_matching: 0,
      ports_out_total: 0,
      rows_emitted: 0,
      rows_matching: 0,
      rows_total: 0,
    },
    unlinked: { external: 0, manifest_blocked: 0, unresolved: 0 },
  };
}
