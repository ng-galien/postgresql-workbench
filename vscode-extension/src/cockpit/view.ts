import * as vscode from "vscode";
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
} from "../../../packages/catalog/src/cockpitGraph.js";
import type {
  WorkbenchIndexController,
  WorkbenchIndexResult,
} from "../../../packages/catalog/src/indexController.js";
import type {
  CodeMonikerGraphResult,
  CodeMonikerIdentityGraphResult,
  CodeMonikerSymbol,
} from "../../../packages/catalog/src/localCodeMoniker.js";
import {
  buildWorkbenchObjects,
  type WorkbenchDatabaseIdentity,
  type WorkbenchObjectModel,
  workbenchObjectFromSymbol,
} from "../../../packages/catalog/src/objectModel.js";
import type { WorkbenchGraphDragPayload } from "../../../packages/views/src/cockpit/dragAndDrop.js";
import type {
  CockpitNeighborhood,
  CockpitPerspective,
  CockpitPerspectiveState,
  CockpitRefreshPayload,
  CockpitSession,
  WorkbenchGraphAppearance,
  WorkbenchGraphBreadcrumb,
  WorkbenchGraphHostMessage,
  WorkbenchGraphIdentityPresentation,
  WorkbenchGraphRenderEvidence,
  WorkbenchGraphSearchResult,
  WorkbenchGraphWebviewMessage,
} from "../../../packages/views/src/cockpit/protocol.js";
import { DEFAULT_WORKBENCH_GRAPH_APPEARANCE } from "../../../packages/views/src/cockpit/protocol.js";
import { GraphNavigation } from "./navigation.js";
import { WorkbenchGraphPanel } from "./panel.js";

type WorkbenchSnapshot = Pick<
  WorkbenchIndexResult,
  "connectionId" | "database" | "revision" | "generation"
>;

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
  treeDragPayload?: (consume: boolean) => WorkbenchGraphDragPayload | undefined;
}

// Explicit debt exception: this host controller still coordinates navigation/session state,
// webview messages, search counts, and perspective persistence. Keeping one owner avoids split
// snapshot lifecycles; future extraction should start with search and perspective capabilities.
// code-moniker: ignore[code-single-responsibility-flags-large-classes]
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
  private readonly loadedNeighborhoods = new Map<string, CodeMonikerSymbol>();
  private readonly knownSymbols = new Map<string, CodeMonikerSymbol>();
  private currentFocus?: CodeMonikerSymbol;
  private previewSymbol?: CodeMonikerSymbol;
  private sourceVisible = false;
  private sourcePinned = false;
  private pendingSnapshot?: WorkbenchSnapshot;
  private refreshRun?: Promise<boolean>;
  private operationTail: Promise<void> = Promise.resolve();
  private readonly activeTreeDrops = new Set<Promise<boolean>>();
  private closing = false;
  private readonly acknowledgements: WorkbenchGraphAck[] = [];
  private webviewRenderSequence = 0;
  private disposed = false;
  private readonly index: WorkbenchIndexController;
  private readonly openDefinition: WorkbenchGraphViewOptions["openDefinition"];
  private readonly showActions: WorkbenchGraphViewOptions["showActions"];
  private readonly selectInTree: NonNullable<WorkbenchGraphViewOptions["selectInTree"]>;
  private readonly workspaceState: vscode.Memento | undefined;
  private readonly treeDragPayload: NonNullable<WorkbenchGraphViewOptions["treeDragPayload"]>;
  private readonly configurationSubscription: vscode.Disposable;

  constructor(options: WorkbenchGraphViewOptions) {
    this.index = options.index;
    this.openDefinition = options.openDefinition;
    this.showActions = options.showActions;
    this.selectInTree = options.selectInTree ?? (async () => undefined);
    this.workspaceState = options.workspaceState;
    this.treeDragPayload = options.treeDragPayload ?? (() => undefined);
    this.panel = new WorkbenchGraphPanel(
      options.extensionUri,
      (message) => this.receive(message),
      () => this.reset(),
      options.collectRenderEvidence ?? false,
    );
    this.configurationSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("postgresql-workbench.workbench.graph")) return;
      void this.postAppearance();
    });
  }

  get visible(): boolean {
    return this.panel.visible;
  }

  get active(): boolean {
    return this.panel.active;
  }

  get visibleViewColumn(): vscode.ViewColumn | undefined {
    return this.panel.visibleViewColumn;
  }

  get isOpen(): boolean {
    return this.panel.current !== undefined;
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

  get currentDatabase(): WorkbenchDatabaseIdentity | undefined {
    return this.database && { ...this.database };
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
    if (this.refreshRun) await this.refreshRun;
    if (this.disposed) return false;
    const changed = this.setContext(
      { connectionId: object.connectionId, database: object.database },
      snapshot,
    );
    this.panel.ensure(object.database);
    this.panel.reveal();
    if (changed) {
      this.navigation.reset(
        databaseLandingIdentity(this.symbols(object), object) ?? object.symbolUri,
      );
    }
    return this.focusNode(object.symbolUri);
  }

  async openDatabase(
    database: WorkbenchDatabaseIdentity,
    snapshot: WorkbenchSnapshot,
  ): Promise<boolean> {
    if (this.refreshRun) await this.refreshRun;
    if (this.disposed) return false;
    this.setContext(database, snapshot);
    this.panel.ensure(database.database);
    this.panel.reveal();
    const prefix = databaseLandingIdentity(this.symbols(database), database);
    if (!prefix) return false;
    this.navigation.reset(prefix);
    return this.showLanding(prefix);
  }

  async openSchema(
    database: WorkbenchDatabaseIdentity,
    schema: string,
    snapshot: WorkbenchSnapshot,
  ): Promise<boolean> {
    if (this.refreshRun) await this.refreshRun;
    if (this.disposed) return false;
    this.setContext(database, snapshot);
    this.panel.ensure(database.database);
    this.panel.reveal();
    const prefix = schemaLandingIdentity(this.symbols(database), database, schema);
    if (!prefix) return false;
    this.navigation.reset(prefix);
    return this.showLanding(prefix, schema);
  }

  async focusNode(prefix: string): Promise<boolean> {
    if (this.refreshRun) await this.refreshRun;
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
    if (this.refreshRun) await this.refreshRun;
    if (!this.panel.current || this.disposed) return false;
    if (!this.matchesContext(object, snapshot)) return this.open(object, snapshot);
    return this.focusNode(object.symbolUri);
  }

  async syncSchemaFromTree(schema: string, snapshot: WorkbenchSnapshot): Promise<boolean> {
    if (this.refreshRun) await this.refreshRun;
    if (!this.panel.current || !this.database || !this.sameSnapshot(snapshot)) return false;
    const prefix = schemaLandingIdentity(this.symbols(), this.database, schema);
    if (!prefix) return false;
    const checkpoint = this.navigation.snapshot();
    this.navigation.push(prefix);
    const result = await this.showLanding(prefix, schema);
    if (!result) this.navigation.restore(checkpoint);
    return result;
  }

  async acceptTreeDrop(payload: WorkbenchGraphDragPayload): Promise<boolean> {
    if (this.closing || this.disposed) {
      await this.rejectTreeDrop("The PostgreSQL graph is not ready yet. Try the drop again.");
      return false;
    }
    const activePayload = this.treeDragPayload(true);
    if (!activePayload || !sameTreeDrag(activePayload, payload)) {
      await this.rejectTreeDrop(
        "The dragged Sources item is no longer available. Start the drag again.",
      );
      return false;
    }
    return this.runTreeDrop(payload);
  }

  /** Accepts an immutable URI handoff after VS Code consumed the native drop on its overlay. */
  async acceptTransportedTreeDrop(payload: WorkbenchGraphDragPayload): Promise<boolean> {
    if (this.closing || this.disposed) {
      await this.rejectTreeDrop("The PostgreSQL graph is not ready yet. Try the drop again.");
      return false;
    }
    return this.runTreeDrop(payload);
  }

  private runTreeDrop(payload: WorkbenchGraphDragPayload): Promise<boolean> {
    const run = this.acceptTreeDropNow(payload);
    this.activeTreeDrops.add(run);
    void run.then(
      () => this.activeTreeDrops.delete(run),
      () => this.activeTreeDrops.delete(run),
    );
    return run;
  }

  private async acceptTreeDropNow(payload: WorkbenchGraphDragPayload): Promise<boolean> {
    if (payload.availability === "unsupported") {
      if (!this.panel.current) await vscode.window.showInformationMessage(payload.reason);
      return false;
    }
    if (this.refreshRun) await this.refreshRun;
    const identity = { connectionId: payload.connectionId, database: payload.database };
    const state = this.index.databaseState(identity);
    const result = state.result;
    if (
      state.status !== "available" ||
      !result ||
      result.connectionId !== payload.connectionId ||
      result.database !== payload.database
    ) {
      await this.rejectTreeDrop("This object is not part of the Cockpit Connection index.");
      return false;
    }
    const object = buildWorkbenchObjects(this.symbols(identity), {
      connectionId: result.connectionId,
      database: result.database,
    }).find(
      (candidate) =>
        candidate.symbolUri === payload.symbolUri && candidate.sourceUri === payload.sourceUri,
    );
    if (!object) {
      await this.rejectTreeDrop(
        "This Sources item is not available in the current database index.",
      );
      return false;
    }
    const focused = this.panel.current
      ? await this.syncObjectFromTree(object, result)
      : await this.open(object, result);
    if (!focused) {
      await this.rejectTreeDrop("The selected PostgreSQL object could not be opened in the graph.");
      return false;
    }
    await this.selectInTree(object, result);
    return true;
  }

  previewTreeDrop(payload: WorkbenchGraphDragPayload | null): void {
    void this.panel.post({ type: "cockpitTreeDragStatus", payload });
  }

  reveal(): void {
    this.panel.reveal();
  }

  async refreshSnapshot(snapshot: WorkbenchSnapshot): Promise<boolean> {
    if (
      !this.database ||
      snapshot.connectionId !== this.database.connectionId ||
      snapshot.database !== this.database.database ||
      !this.panel.current ||
      this.sameSnapshot(snapshot)
    ) {
      return false;
    }
    this.pendingSnapshot = snapshot;
    if (this.refreshRun) return this.refreshRun;
    const run = this.drainSnapshotRefreshes();
    this.refreshRun = run;
    try {
      return await run;
    } finally {
      if (this.refreshRun === run) this.refreshRun = undefined;
    }
  }

  private async drainSnapshotRefreshes(): Promise<boolean> {
    let refreshed = false;
    while (this.pendingSnapshot) {
      const snapshot = this.pendingSnapshot;
      this.pendingSnapshot = undefined;
      refreshed = (await this.applySnapshotRefresh(snapshot)) || refreshed;
    }
    return refreshed;
  }

  private async applySnapshotRefresh(snapshot: WorkbenchSnapshot): Promise<boolean> {
    return this.runExclusive(() => this.applySnapshotRefreshNow(snapshot));
  }

  private async applySnapshotRefreshNow(snapshot: WorkbenchSnapshot): Promise<boolean> {
    const database = this.database;
    if (!database || !this.panel.current || this.sameSnapshot(snapshot)) return false;
    const state = this.index.databaseState(database);
    const result = state.result;
    if (
      state.status !== "available" ||
      !result ||
      result.connectionId !== database.connectionId ||
      result.database !== database.database
    ) {
      return false;
    }
    const sequence = ++this.loadSequence;
    const previousFocus = this.currentFocus;
    this.counts.clear();
    this.searchSequence += 1;
    if (!previousFocus) {
      this.snapshot = snapshot;
      const currentPreviewSymbol = this.previewSymbol
        ? this.resolveCurrentSymbol(this.previewSymbol)
        : undefined;
      const sourcePreview = currentPreviewSymbol
        ? await this.index.graphSourcePreview(
            currentPreviewSymbol.uri,
            this.indexSnapshot(snapshot),
          )
        : undefined;
      this.previewSymbol = currentPreviewSymbol;
      if (this.sourceVisible && (!currentPreviewSymbol || !sourcePreview)) {
        this.sourceVisible = false;
        this.sourcePinned = false;
      }
      const preview = sourcePreview ? sourcePreviewPresentation(sourcePreview) : null;
      const session = this.createSession(this.session?.breadcrumbs ?? [], this.session?.schemaHint);
      this.session = session;
      const refreshMessage: WorkbenchGraphHostMessage = {
        type: "cockpitRefresh",
        payload: {
          session,
          focusIdentity: null,
          neighborhoods: [],
          identityRemap: {},
          presentations: {},
          validIdentities: buildWorkbenchObjects(this.symbols(database), database).map(
            (object) => object.symbolUri,
          ),
          pinnedIdentities: [],
          preview,
          sourceVisible: this.sourceVisible,
          sourcePinned: this.sourcePinned,
        },
      };
      this.lastMessage = {
        type: "cockpitSession",
        session,
        sourceVisible: this.sourceVisible,
        sourcePinned: this.sourcePinned,
      };
      await this.panel.post(refreshMessage);
      return true;
    }
    try {
      const remapped = new Map<string, CodeMonikerSymbol>();
      for (const [previousIdentity, symbol] of this.knownSymbols) {
        const current = this.resolveCurrentSymbol(symbol);
        if (current) remapped.set(previousIdentity, current);
      }
      const currentFocus = this.resolveCurrentSymbol(previousFocus);
      if (!currentFocus) {
        const currentPreviewSymbol = this.previewSymbol
          ? this.resolveCurrentSymbol(this.previewSymbol)
          : undefined;
        const sourcePreview = currentPreviewSymbol
          ? await this.index.graphSourcePreview(
              currentPreviewSymbol.uri,
              this.indexSnapshot(snapshot),
            )
          : undefined;
        this.previewSymbol = currentPreviewSymbol;
        if (this.sourceVisible && (!currentPreviewSymbol || !sourcePreview)) {
          this.sourceVisible = false;
          this.sourcePinned = false;
        }
        const schema = previousFocus.postgres?.schema;
        const prefix = schema
          ? schemaLandingIdentity(this.symbols(database), database, schema)
          : undefined;
        const landing = prefix ?? databaseLandingIdentity(this.symbols(database), database);
        if (!landing) return false;
        this.snapshot = snapshot;
        this.navigation.replace(landing);
        const shown = await this.showLanding(landing, prefix ? schema : undefined);
        if (shown && this.sourceVisible && sourcePreview) {
          await this.panel.post({
            type: "cockpitPreview",
            preview: sourcePreviewPresentation(sourcePreview),
            pinned: this.sourcePinned,
          });
        }
        return shown;
      }
      remapped.set(previousFocus.uri, currentFocus);
      const neighborhoods: CockpitRefreshPayload["neighborhoods"] = [];
      const identityRemap: Record<string, string> = {};
      const nextLoaded = new Map<string, CodeMonikerSymbol>();
      for (const [previousIdentity, previousSymbol] of this.loadedNeighborhoods) {
        const symbol = remapped.get(previousIdentity) ?? this.resolveCurrentSymbol(previousSymbol);
        if (!symbol) continue;
        const source = await this.index.graphFocus(symbol.uri, this.indexSnapshot(snapshot));
        if (sequence !== this.loadSequence) return false;
        const neighborhood = neighborhoodFromGraph(source, database, this.symbols(database));
        this.rememberCounts(source);
        const presentations = presentationsForSymbols(
          neighborhoodSymbols(neighborhood),
          database,
          (sourceUri) => this.objectOrigin(sourceUri, database),
        );
        identityRemap[previousIdentity] = symbol.uri;
        nextLoaded.set(symbol.uri, symbol);
        neighborhoods.push({ previousIdentity, neighborhood, presentations });
      }
      for (const [previousIdentity, symbol] of remapped) {
        identityRemap[previousIdentity] = symbol.uri;
      }
      await this.index.assertGraphSnapshot(this.indexSnapshot(snapshot));
      if (sequence !== this.loadSequence) return false;
      this.loadedNeighborhoods.clear();
      for (const [identity, symbol] of nextLoaded) this.loadedNeighborhoods.set(identity, symbol);
      this.currentFocus = currentFocus;
      this.snapshot = snapshot;
      const focusNeighborhood = neighborhoods.find(
        ({ neighborhood }) => neighborhood.focus.uri === currentFocus.uri,
      );
      if (focusNeighborhood) this.graph = initialCockpitGraph(focusNeighborhood.neighborhood);
      if (currentFocus.uri !== previousFocus.uri) this.navigation.replace(currentFocus.uri);
      const validIdentities = buildWorkbenchObjects(this.symbols(database), database).map(
        (object) => object.symbolUri,
      );
      const validSet = new Set(validIdentities);
      for (const identity of [...this.pinnedIdentities]) {
        const mapped = identityRemap[identity] ?? identity;
        this.pinnedIdentities.delete(identity);
        if (validSet.has(mapped)) this.pinnedIdentities.add(mapped);
      }
      this.knownSymbols.clear();
      this.rememberSymbols([
        ...remapped.values(),
        ...neighborhoods.flatMap(({ neighborhood }) => neighborhoodSymbols(neighborhood)),
      ]);
      this.presentations = presentationsForSymbols(
        [...this.knownSymbols.values()],
        database,
        (sourceUri) => this.objectOrigin(sourceUri, database),
      );
      const currentPreviewSymbol = this.previewSymbol
        ? this.resolveCurrentSymbol(this.previewSymbol)
        : undefined;
      const sourcePreview = currentPreviewSymbol
        ? await this.index.graphSourcePreview(
            currentPreviewSymbol.uri,
            this.indexSnapshot(snapshot),
          )
        : undefined;
      if (sequence !== this.loadSequence) return false;
      this.previewSymbol = currentPreviewSymbol;
      if (this.sourceVisible && (!currentPreviewSymbol || !sourcePreview)) {
        this.sourceVisible = false;
        this.sourcePinned = false;
      }
      const preview = sourcePreview ? sourcePreviewPresentation(sourcePreview) : null;
      const session = this.createSession(
        cockpitBreadcrumbs(currentFocus, database, this.symbols(database)),
      );
      this.session = session;
      const refreshMessage: WorkbenchGraphHostMessage = {
        type: "cockpitRefresh",
        payload: {
          session,
          focusIdentity: currentFocus.uri,
          neighborhoods,
          identityRemap,
          presentations: this.presentations,
          validIdentities,
          pinnedIdentities: [...this.pinnedIdentities],
          preview,
          sourceVisible: this.sourceVisible,
          sourcePinned: this.sourcePinned,
        },
      };
      const replayNeighborhood = focusNeighborhood?.neighborhood;
      if (replayNeighborhood) {
        const pinned = this.pinnedForFocus(undefined, this.presentations);
        this.lastMessage = {
          type: "cockpitFocus",
          payload: {
            session,
            neighborhood: replayNeighborhood,
            presentations: this.presentations,
            pinned,
            preview: preview ?? undefined,
            sourceVisible: this.sourceVisible,
            sourcePinned: this.sourcePinned,
          },
        };
      }
      this.panel.setTitle(this.presentations[currentFocus.uri]?.label ?? currentFocus.name);
      await this.panel.post(refreshMessage);
      return true;
    } catch (error) {
      if (sequence === this.loadSequence && !this.pendingSnapshot) this.postError(error);
      return false;
    }
  }

  async back(): Promise<boolean> {
    return this.stepHistory(-1);
  }

  async forward(): Promise<boolean> {
    return this.stepHistory(1);
  }

  async openNodeDefinition(symbolUri: string): Promise<boolean> {
    if (this.refreshRun) await this.refreshRun;
    const object = this.objectFor(symbolUri);
    if (!object || !this.snapshot) return false;
    try {
      await this.index.assertGraphSnapshot(this.indexSnapshot(this.snapshot));
      const result = await this.openDefinition(object, this.snapshot);
      return result !== undefined && result !== false;
    } catch {
      return false;
    }
  }

  invalidateCockpitContext(): void {
    this.reset();
    this.lastMessage = {
      type: "cockpitContextInvalidated",
      message: "The Cockpit Connection changed. Open the graph again.",
    };
    void this.panel.post(this.lastMessage);
  }

  close(): Promise<void> {
    this.closing = true;
    return Promise.allSettled([...this.activeTreeDrops])
      .then(() =>
        this.runExclusive(async () => {
          this.panel.dispose();
          this.reset();
        }),
      )
      .finally(() => {
        this.closing = false;
      });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.closing = true;
    this.configurationSubscription.dispose();
    this.panel.dispose();
  }

  private setContext(database: WorkbenchDatabaseIdentity, snapshot: WorkbenchSnapshot): boolean {
    const changed =
      this.database?.connectionId !== database.connectionId ||
      this.database.database !== database.database ||
      !this.sameSnapshot(snapshot);
    this.database = database;
    this.snapshot = snapshot;
    if (changed) {
      this.counts.clear();
      this.pinnedIdentities.clear();
      this.presentations = {};
      this.graph = undefined;
      this.currentFocus = undefined;
      this.previewSymbol = undefined;
      this.sourceVisible = false;
      this.sourcePinned = false;
      this.loadedNeighborhoods.clear();
      this.knownSymbols.clear();
      this.pendingSnapshot = undefined;
      this.loadSequence += 1;
      this.searchSequence += 1;
    }
    return changed;
  }

  private matchesContext(object: WorkbenchObjectModel, snapshot: WorkbenchSnapshot): boolean {
    return (
      this.database?.connectionId === object.connectionId &&
      this.database.database === object.database &&
      this.sameSnapshot(snapshot)
    );
  }

  private sameSnapshot(snapshot: WorkbenchSnapshot): boolean {
    return (
      this.snapshot?.revision === snapshot.revision &&
      this.snapshot.generation === snapshot.generation &&
      this.snapshot.connectionId === snapshot.connectionId &&
      this.snapshot.database === snapshot.database
    );
  }

  private async show(prefix: string, perspective?: CockpitPerspective): Promise<boolean> {
    if (!this.database) return false;
    const target = resolveCockpitTarget(prefix, this.symbols(), this.database);
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
              prefix: databaseLandingIdentity(this.symbols(), this.database) ?? prefix,
              label: this.database.database,
            },
            { prefix, label: schemaHint },
          ]
        : [{ prefix, label: this.database.database }],
      schemaHint,
    );
    this.graph = emptyGraph(prefix);
    this.currentFocus = undefined;
    this.loadedNeighborhoods.clear();
    this.knownSymbols.clear();
    this.presentations = {};
    this.session = session;
    this.lastMessage = {
      type: "cockpitSession",
      session,
      sourceVisible: this.sourceVisible,
      sourcePinned: this.sourcePinned,
    };
    this.panel.setTitle(`${schemaHint ? `${schemaHint} · ` : ""}${this.database.database}`);
    await this.panel.post(this.lastMessage);
    return true;
  }

  private async showFocus(
    symbol: CodeMonikerSymbol,
    perspective?: CockpitPerspective,
  ): Promise<boolean> {
    return this.runExclusive(() => this.showFocusNow(symbol, perspective));
  }

  private async showFocusNow(
    symbol: CodeMonikerSymbol,
    perspective?: CockpitPerspective,
  ): Promise<boolean> {
    const snapshot = this.snapshot;
    const database = this.database;
    const panel = this.panel.current;
    if (!snapshot || !database || !panel) return false;
    const sequence = ++this.loadSequence;
    try {
      const loaded = await this.loadGraphObject(symbol, snapshot);
      if (sequence !== this.loadSequence || panel !== this.panel.current) return false;
      const { neighborhood, presentations, preview } = loaded;
      const symbols = neighborhoodSymbols(neighborhood);
      const pinned = this.pinnedForFocus(perspective, presentations);
      this.knownSymbols.clear();
      this.rememberSymbols(symbols);
      this.rememberSymbols(pinned.map(({ symbol }) => symbol));
      const breadcrumbs = cockpitBreadcrumbs(symbol, database, this.symbols(database));
      const session = this.createSession(breadcrumbs);
      this.graph = initialCockpitGraph(neighborhood);
      this.currentFocus = symbol;
      if (!this.sourcePinned) this.previewSymbol = preview ? symbol : undefined;
      this.loadedNeighborhoods.clear();
      this.loadedNeighborhoods.set(symbol.uri, symbol);
      this.presentations = presentations;
      this.session = session;
      this.lastMessage = {
        type: "cockpitFocus",
        payload: {
          session,
          neighborhood,
          presentations,
          pinned,
          preview,
          perspective,
          sourceVisible: this.sourceVisible,
          sourcePinned: this.sourcePinned,
        },
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
    const objects = this.database ? buildWorkbenchObjects(this.symbols(), this.database) : [];
    return {
      renderId: ++this.renderSequence,
      connectionId: this.database?.connectionId ?? "",
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
    if (this.refreshRun) await this.refreshRun;
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
        void this.replayWebviewState();
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
        void this.search(message.query, message.requestId);
        break;
      case "inspect":
        void this.inspect(message.symbolUri);
        break;
      case "dismissPreview":
        this.previewSymbol = undefined;
        this.sourceVisible = false;
        this.sourcePinned = false;
        if (this.lastMessage?.type === "cockpitFocus") {
          this.lastMessage = {
            ...this.lastMessage,
            payload: {
              ...this.lastMessage.payload,
              preview: undefined,
              sourceVisible: false,
              sourcePinned: false,
            },
          };
        } else if (this.lastMessage?.type === "cockpitSession") {
          this.lastMessage = {
            ...this.lastMessage,
            sourceVisible: false,
            sourcePinned: false,
          };
        }
        break;
      case "pinPreview":
        this.sourcePinned = message.pinned;
        if (message.pinned) {
          this.previewSymbol = this.symbols().find(
            (candidate) => candidate.uri === message.symbolUri,
          );
        }
        if (this.lastMessage?.type === "cockpitFocus") {
          this.lastMessage = {
            ...this.lastMessage,
            payload: { ...this.lastMessage.payload, sourcePinned: this.sourcePinned },
          };
        } else if (this.lastMessage?.type === "cockpitSession") {
          this.lastMessage = { ...this.lastMessage, sourcePinned: this.sourcePinned };
        }
        break;
      case "resolveTreeDrag":
        void this.panel.post({
          type: "cockpitTreeDragStatus",
          payload: this.treeDragPayload(false) ?? null,
        });
        break;
      case "clearTreeDrag":
        this.treeDragPayload(true);
        break;
      case "dropTreeSource":
        void this.dropActiveTreeSource();
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
      case "dropSource":
        void this.acceptTreeDrop(message.payload);
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
    return this.runExclusive(() => this.sendNeighborhoodNow(message));
  }

  private async sendNeighborhoodNow(
    message: Extract<WorkbenchGraphWebviewMessage, { type: "requestNeighborhood" }>,
  ): Promise<void> {
    if (this.refreshRun) await this.refreshRun;
    const snapshot = this.snapshot;
    const database = this.database;
    if (!snapshot || !database) return;
    try {
      const source = await this.index.graphFocus(message.symbolUri, this.indexSnapshot(snapshot));
      const neighborhood = neighborhoodFromGraph(source, database, this.symbols(database));
      this.loadedNeighborhoods.set(neighborhood.focus.uri, neighborhood.focus);
      this.rememberSymbols(neighborhoodSymbols(neighborhood));
      this.rememberCounts(source);
      const symbols = neighborhoodSymbols(neighborhood);
      const presentations = presentationsForSymbols(symbols, database, (sourceUri) =>
        this.objectOrigin(sourceUri, database),
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

  private async dropActiveTreeSource(): Promise<void> {
    const payload = this.treeDragPayload(false);
    if (!payload) {
      await this.panel.post({
        type: "cockpitDropRejected",
        message: "The dragged Sources item is no longer available. Start the drag again.",
      });
      return;
    }
    if (payload.availability === "unsupported") {
      await this.panel.post({ type: "cockpitDropRejected", message: payload.reason });
      return;
    }
    await this.acceptTreeDrop(payload);
  }

  private async rejectTreeDrop(message: string): Promise<void> {
    if (this.panel.current) {
      await this.panel.post({ type: "cockpitDropRejected", message });
      return;
    }
    await vscode.window.showWarningMessage(message);
  }

  private async inspect(symbolUri: string): Promise<void> {
    if (this.refreshRun) await this.refreshRun;
    return this.runExclusive(() => this.inspectNow(symbolUri));
  }

  private async inspectNow(symbolUri: string): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const symbol = this.symbols().find((candidate) => candidate.uri === symbolUri);
    const preview = await this.index.graphSourcePreview(symbolUri, this.indexSnapshot(snapshot));
    if (!preview) return;
    this.previewSymbol = symbol;
    this.sourceVisible = true;
    if (symbol) this.rememberSymbols([symbol]);
    const presentation = sourcePreviewPresentation(preview);
    if (this.lastMessage?.type === "cockpitFocus") {
      this.lastMessage = {
        ...this.lastMessage,
        payload: { ...this.lastMessage.payload, preview: presentation },
      };
    }
    await this.panel.post({
      type: "cockpitPreview",
      preview: presentation,
      pinned: this.sourcePinned,
    });
  }

  private async replayWebviewState(): Promise<void> {
    await this.postAppearance();
    if (this.lastMessage) await this.panel.post(this.lastMessage);
    if (this.sourceVisible && this.previewSymbol) await this.inspect(this.previewSymbol.uri);
  }

  private async postAppearance(): Promise<void> {
    await this.panel.post({ type: "cockpitAppearance", appearance: readGraphAppearance() });
  }

  private async loadGraphObject(symbol: CodeMonikerSymbol, snapshot: WorkbenchSnapshot) {
    const database = this.database;
    if (!database) throw new Error("The PostgreSQL Cockpit has no selected Connection.");
    const [source, sourcePreview] = await Promise.all([
      this.index.graphFocus(symbol.uri, this.indexSnapshot(snapshot)),
      this.index.graphSourcePreview(symbol.uri, this.indexSnapshot(snapshot)),
    ]);
    await this.index.assertGraphSnapshot(this.indexSnapshot(snapshot));
    const neighborhood = neighborhoodFromGraph(source, database, this.symbols(database));
    this.rememberCounts(source);
    const presentations = presentationsForSymbols(
      neighborhoodSymbols(neighborhood),
      database,
      (sourceUri) => this.objectOrigin(sourceUri, database),
    );
    return {
      neighborhood,
      presentations,
      preview: sourcePreview ? sourcePreviewPresentation(sourcePreview) : undefined,
    };
  }

  private async actions(symbolUri: string): Promise<void> {
    if (this.refreshRun) await this.refreshRun;
    const object = this.objectFor(symbolUri);
    if (!object || !this.snapshot) return;
    await this.showActions(object, this.snapshot);
  }

  private async search(query: string, requestId: number): Promise<void> {
    if (this.refreshRun) await this.refreshRun;
    const database = this.database;
    const snapshot = this.snapshot;
    const normalized = query.trim();
    const sequence = ++this.searchSequence;
    const results = database
      ? searchGraphObjects(this.symbols(database), database, normalized, (sourceUri) =>
          this.objectOrigin(sourceUri, database),
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
        batch.map((identity) => this.index.graphFocus(identity, this.indexSnapshot(snapshot), 1)),
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
    const symbols = this.symbols().filter((symbol) => requested.has(symbol.uri));
    const pinnedPresentations = presentationsForSymbols(symbols, this.database, (sourceUri) =>
      this.objectOrigin(sourceUri),
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
    return `plpgsql.cockpit.perspectives.${this.database?.connectionId ?? "none"}.${this.database?.database ?? "none"}`;
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
    if (this.refreshRun) await this.refreshRun;
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

  private symbols(
    database: WorkbenchDatabaseIdentity | undefined = this.database,
  ): readonly CodeMonikerSymbol[] {
    return database ? this.index.databaseSymbols(database) : [];
  }

  private indexSnapshot(snapshot: WorkbenchSnapshot) {
    const database = this.database;
    if (!database) throw new Error("The PostgreSQL Cockpit has no selected Connection.");
    return snapshot;
  }

  private objectOrigin(
    sourceUri: string,
    database: WorkbenchDatabaseIdentity | undefined = this.database,
  ) {
    return database ? this.index.databaseObjectOrigin(database, sourceUri) : undefined;
  }

  private objectFor(symbolUri: string): WorkbenchObjectModel | undefined {
    const symbol = this.symbols().find((candidate) => candidate.uri === symbolUri);
    return symbol && this.database ? workbenchObjectFromSymbol(symbol, this.database) : undefined;
  }

  private resolveCurrentSymbol(previous: CodeMonikerSymbol): CodeMonikerSymbol | undefined {
    const direct = this.symbols().find((candidate) => candidate.uri === previous.uri);
    if (direct) return direct;
    const descriptor = previous.postgres;
    if (!descriptor) return undefined;
    return this.symbols().find(
      (candidate) =>
        candidate.postgres?.connectionId === descriptor.connectionId &&
        candidate.postgres.database === descriptor.database &&
        candidate.postgres.documentKind === descriptor.documentKind &&
        candidate.postgres.oid === descriptor.oid,
    );
  }

  private rememberSymbols(symbols: Iterable<CodeMonikerSymbol>): void {
    for (const symbol of symbols) this.knownSymbols.set(symbol.uri, symbol);
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationTail.then(operation, operation);
    this.operationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
    this.currentFocus = undefined;
    this.previewSymbol = undefined;
    this.sourceVisible = false;
    this.sourcePinned = false;
    this.loadedNeighborhoods.clear();
    this.knownSymbols.clear();
    this.pendingSnapshot = undefined;
    this.navigation.clear();
    this.lastMessage = undefined;
    this.loadSequence += 1;
    this.searchSequence += 1;
    this.counts.clear();
    this.pinnedIdentities.clear();
  }
}

function sameTreeDrag(
  active: WorkbenchGraphDragPayload,
  requested: WorkbenchGraphDragPayload,
): boolean {
  if (
    active.version !== requested.version ||
    active.availability !== requested.availability ||
    active.label !== requested.label
  ) {
    return false;
  }
  if (active.availability === "unsupported" || requested.availability === "unsupported") {
    return (
      active.availability === "unsupported" &&
      requested.availability === "unsupported" &&
      active.reason === requested.reason
    );
  }
  return (
    active.connectionId === requested.connectionId &&
    active.database === requested.database &&
    active.sourceUri === requested.sourceUri &&
    active.symbolUri === requested.symbolUri &&
    active.kind === requested.kind
  );
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

function readGraphAppearance(): WorkbenchGraphAppearance {
  const configuration = vscode.workspace.getConfiguration("postgresql-workbench.workbench.graph");
  return {
    compactZoomThreshold: boundedSetting(
      configuration.get<number>(
        "compactZoomThreshold",
        DEFAULT_WORKBENCH_GRAPH_APPEARANCE.compactZoomThreshold,
      ),
      0.25,
      1,
    ),
    compactNodeFontScale: boundedSetting(
      configuration.get<number>(
        "compactNodeFontScale",
        DEFAULT_WORKBENCH_GRAPH_APPEARANCE.compactNodeFontScale,
      ),
      0.8,
      2,
    ),
    edgeLabelFontScale: boundedSetting(
      configuration.get<number>(
        "edgeLabelFontScale",
        DEFAULT_WORKBENCH_GRAPH_APPEARANCE.edgeLabelFontScale,
      ),
      0.8,
      2,
    ),
  };
}

function boundedSetting(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
