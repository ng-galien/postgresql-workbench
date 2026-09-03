import { Client } from "pg";
import {
  COCKPIT_RELATIONS,
  cockpitBreadcrumbs,
  cockpitGraphFromCatalog,
  cockpitSymbolFromCatalog,
  neighborhoodFromGraph,
  presentationsForSymbols,
  readPostgresCockpitSymbols,
  resolveCockpitTarget,
  searchGraphObjects,
  sourcePreviewPresentation,
} from "../../catalog/src/cockpitGraph.js";
import {
  ensureLocalCodeMonikerWorkspace,
  type LocalCodeMonikerSession,
} from "../../catalog/src/localCodeMoniker.js";
import { buildWorkbenchObjects, listWorkbenchSchemas } from "../../catalog/src/objectModel.js";
import {
  type PostgresCatalogSnapshot,
  readPostgresCatalog,
  type VirtualSqlDocument,
} from "../../catalog/src/postgresCatalog.js";
import {
  type CockpitSession,
  DEFAULT_WORKBENCH_GRAPH_APPEARANCE,
  type WorkbenchGraphHostMessage,
  type WorkbenchGraphWebviewMessage,
} from "../../views/src/cockpit/protocol.js";

export interface CockpitHost {
  handle(request: WorkbenchGraphWebviewMessage): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * The standalone Cockpit host. It owns transport and lifecycle only: PostgreSQL catalog
 * projection and graph presentation remain in packages/catalog, exactly as they do for VS Code.
 */
export async function startCockpitHost(options: {
  connection: { host: string; port: number; user: string; password: string; database: string };
  codeMonikerRuntimePath?: string;
  emit(response: WorkbenchGraphHostMessage): void;
}): Promise<CockpitHost> {
  const database = {
    connectionId: `${options.connection.host}:${options.connection.port}`,
    database: options.connection.database,
  };
  const postgres = new Client(options.connection);
  await postgres.connect();
  let catalog: PostgresCatalogSnapshot;
  try {
    catalog = await readPostgresCatalog(postgres, database);
  } finally {
    await postgres.end().catch(() => undefined);
  }

  const documents = new Map<string, VirtualSqlDocument>(
    catalog.sourceSet.documents.map((document) => [document.uri, document]),
  );
  const session: LocalCodeMonikerSession = await ensureLocalCodeMonikerWorkspace({
    workspaceRoots: [process.cwd()],
    clientName: "postgresql-workbench-cockpit-shell",
    ...(options.codeMonikerRuntimePath ? { runtimePath: options.codeMonikerRuntimePath } : {}),
  });
  await waitForWorkspaceReady(session);
  await session.client.sources.replace({
    ...catalog.sourceSet,
    documents: catalog.sourceSet.documents.map(({ uri, language, content }) => ({
      uri,
      language,
      content,
    })),
  });

  const indexed = await readPostgresCockpitSymbols(session.client, database);
  const symbols = indexed.symbols.map((symbol) => cockpitSymbolFromCatalog(symbol, documents));
  const objects = buildWorkbenchObjects(symbols, database);
  const initialIdentity = objects[0]?.symbolUri;
  const history: string[] = initialIdentity ? [initialIdentity] : [];
  let historyIndex = history.length - 1;
  let renderSequence = 0;

  const originFor = (sourceUri: string) => catalog.origins.get(sourceUri);
  const createSession = (focus?: (typeof symbols)[number]): CockpitSession => ({
    renderId: ++renderSequence,
    connectionId: database.connectionId,
    database: database.database,
    revision: catalog.sourceSet.revision,
    generation: indexed.generation,
    breadcrumbs: cockpitBreadcrumbs(focus, database, symbols),
    canBack: historyIndex > 0,
    canForward: historyIndex >= 0 && historyIndex < history.length - 1,
    perspectives: [],
    searchFacets: {
      schemas: listWorkbenchSchemas(symbols, database),
      kinds: [...new Set(objects.map((object) => object.kind))].sort(),
    },
  });

  const show = async (prefix: string, recordHistory: boolean): Promise<void> => {
    const target = resolveCockpitTarget(prefix, symbols, database);
    if (recordHistory && history[historyIndex] !== prefix) {
      history.splice(historyIndex + 1);
      history.push(prefix);
      historyIndex = history.length - 1;
    }
    if (target.kind === "landing") {
      options.emit({
        type: "cockpitSession",
        session: { ...createSession(), schemaHint: target.schemaHint },
      });
      return;
    }
    const source = cockpitGraphFromCatalog(
      await session.client.graph.symbol(
        target.symbol.uri,
        { relation: [...COCKPIT_RELATIONS] },
        { consistency: "stale_ok", limit: 200 },
      ),
      documents,
    );
    const neighborhood = neighborhoodFromGraph(source, database, symbols);
    const presentedSymbols = [
      neighborhood.focus,
      ...neighborhood.incoming.map((neighbor) => neighbor.symbol),
      ...neighborhood.outgoing.map((neighbor) => neighbor.symbol),
    ];
    options.emit({
      type: "cockpitFocus",
      payload: {
        session: createSession(target.symbol),
        neighborhood,
        presentations: presentationsForSymbols(presentedSymbols, database, originFor),
      },
    });
  };

  const sendNeighborhood = async (
    request: Extract<WorkbenchGraphWebviewMessage, { type: "requestNeighborhood" }>,
  ): Promise<void> => {
    const graph = cockpitGraphFromCatalog(
      await session.client.graph.symbol(
        request.symbolUri,
        { relation: [...COCKPIT_RELATIONS] },
        { consistency: "stale_ok", limit: 200 },
      ),
      documents,
    );
    const neighborhood = neighborhoodFromGraph(graph, database, symbols);
    const presentedSymbols = [
      neighborhood.focus,
      ...neighborhood.incoming.map((neighbor) => neighbor.symbol),
      ...neighborhood.outgoing.map((neighbor) => neighbor.symbol),
    ];
    options.emit({
      type: "cockpitNeighborhood",
      requestId: request.requestId,
      intent: request.intent,
      direction: request.direction,
      neighborhood,
      presentations: presentationsForSymbols(presentedSymbols, database, originFor),
    });
  };

  return {
    async handle(request) {
      try {
        switch (request.type) {
          case "ready":
            options.emit({
              type: "cockpitAppearance",
              appearance: DEFAULT_WORKBENCH_GRAPH_APPEARANCE,
            });
            if (initialIdentity) await show(initialIdentity, false);
            else options.emit({ type: "cockpitSession", session: createSession() });
            return;
          case "focus":
            await show(request.prefix, true);
            return;
          case "back":
            if (historyIndex > 0) {
              historyIndex -= 1;
              await show(history[historyIndex], false);
            }
            return;
          case "forward":
            if (historyIndex < history.length - 1) {
              historyIndex += 1;
              await show(history[historyIndex], false);
            }
            return;
          case "requestNeighborhood":
            await sendNeighborhood(request);
            return;
          case "search":
            options.emit({
              type: "searchResults",
              requestId: request.requestId,
              query: request.query.trim(),
              results: searchGraphObjects(symbols, database, request.query, originFor),
            });
            return;
          case "inspect": {
            const detail = await session.client.symbols.detail(
              request.symbolUri,
              { contextLines: 16 },
              { consistency: "stale_ok" },
            );
            const symbol = cockpitSymbolFromCatalog(detail.symbol, documents);
            const source = detail.source ?? detail.symbol.source;
            if (source) {
              options.emit({
                type: "cockpitPreview",
                preview: sourcePreviewPresentation({ symbol, source }),
              });
            }
            return;
          }
          case "resolveTreeDrag":
            options.emit({ type: "cockpitTreeDragStatus", payload: null });
            return;
          case "savePerspective":
          case "loadPerspective":
          case "deletePerspective":
            options.emit({ type: "cockpitPerspectives", perspectives: [] });
            return;
          case "dismissPreview":
          case "pinPreview":
          case "clearTreeDrag":
          case "dropTreeSource":
          case "open":
          case "actions":
          case "pin":
          case "dropSource":
          case "ack":
            return;
        }
      } catch (error) {
        options.emit({
          type: "scopeError",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    async dispose() {
      await session.dispose().catch(() => undefined);
    },
  };
}

async function waitForWorkspaceReady(session: LocalCodeMonikerSession): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (true) {
    const status = await session.client.workspace.status();
    if (status.phase === "ready") return;
    if (status.phase === "failed") {
      throw new Error(status.failure?.message ?? "Code Moniker workspace indexing failed");
    }
    if (Date.now() >= deadline) {
      throw new Error(`Code Moniker workspace remained ${status.phase} for 30000 ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
