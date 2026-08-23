import { beforeEach, describe, expect, it, vi } from "vitest";

const panel = vi.hoisted(() => ({
  visible: false,
  post: vi.fn(),
  current: {},
  receive: undefined as ((message: unknown) => void) | undefined,
  setTitle: vi.fn(),
}));
const graphConfiguration = vi.hoisted(() => ({
  compactZoomThreshold: 0.8,
  compactNodeFontScale: 1.6,
  edgeLabelFontScale: 1.3,
  listener: undefined as
    | ((event: { affectsConfiguration(section: string): boolean }) => void)
    | undefined,
}));

vi.mock("vscode", () => ({
  DataTransferItem: class {
    constructor(readonly value: unknown) {}
  },
  workspace: {
    getConfiguration: () => ({
      get: (
        key: "compactZoomThreshold" | "compactNodeFontScale" | "edgeLabelFontScale",
        fallback: number,
      ) => graphConfiguration[key] ?? fallback,
    }),
    onDidChangeConfiguration: (
      listener: (event: { affectsConfiguration(section: string): boolean }) => void,
    ) => {
      graphConfiguration.listener = listener;
      return { dispose: vi.fn() };
    },
  },
}));
vi.mock("./panel.js", () => ({
  WorkbenchGraphPanel: class {
    constructor(_extensionUri: unknown, receive: (message: unknown) => void) {
      panel.receive = receive;
    }
    get current(): object {
      return panel.current;
    }
    get visible(): boolean {
      return panel.visible;
    }
    post = panel.post;
    ensure(): object {
      return {};
    }
    reveal(): void {}
    setTitle = panel.setTitle;
    dispose(): void {}
  },
}));

import { WorkbenchTreeDragAndDropController } from "../workbench/treeDragAndDrop.js";
import { WorkbenchGraphView } from "./view.js";

function scopedIndex<T extends Record<string, unknown>>(index: T): T {
  return Object.assign(index, {
    databaseState: () => index.state ?? { status: "not-indexed" },
    databaseSymbols: () => index.indexedSymbols ?? [],
    databaseObjectOrigin: (_identity: unknown, sourceUri: string) =>
      typeof index.objectOrigin === "function"
        ? (index.objectOrigin as (uri: string) => unknown)(sourceUri)
        : undefined,
  });
}

function graphView(): WorkbenchGraphView {
  return new WorkbenchGraphView({
    extensionUri: {} as never,
    index: scopedIndex({ indexedSymbols: [] }) as never,
    openDefinition: async () => undefined,
    showActions: async () => undefined,
  });
}

beforeEach(() => {
  panel.post.mockReset().mockResolvedValue(true);
  panel.setTitle.mockReset();
  panel.receive = undefined;
  graphConfiguration.compactZoomThreshold = 0.8;
  graphConfiguration.compactNodeFontScale = 1.6;
  graphConfiguration.edgeLabelFontScale = 1.3;
  graphConfiguration.listener = undefined;
});

describe("Workbench graph Connexion context invalidation", () => {
  it("sends graph appearance settings on ready and when they change", async () => {
    const view = graphView();

    panel.receive?.({ type: "ready" });
    await vi.waitFor(() =>
      expect(panel.post).toHaveBeenCalledWith({
        type: "cockpitAppearance",
        appearance: {
          compactZoomThreshold: 0.8,
          compactNodeFontScale: 1.6,
          edgeLabelFontScale: 1.3,
        },
      }),
    );

    panel.post.mockClear();
    graphConfiguration.compactZoomThreshold = 0.72;
    graphConfiguration.compactNodeFontScale = 1.35;
    graphConfiguration.edgeLabelFontScale = 1.3;
    graphConfiguration.listener?.({
      affectsConfiguration: (section) => section === "postgresql-workbench.workbench.graph",
    });
    await vi.waitFor(() =>
      expect(panel.post).toHaveBeenCalledWith({
        type: "cockpitAppearance",
        appearance: {
          compactZoomThreshold: 0.72,
          compactNodeFontScale: 1.35,
          edgeLabelFontScale: 1.3,
        },
      }),
    );
    view.dispose();
  });

  it.each([true, false])("invalidates retained webview state when visible is %s", (visible) => {
    panel.visible = visible;
    const view = graphView();

    view.invalidateCockpitContext();

    expect(panel.post).toHaveBeenCalledWith({
      type: "cockpitContextInvalidated",
      message: "The Cockpit Connexion changed. Open the graph again.",
    });
    expect(view.currentModel).toBeUndefined();
    expect(view.currentScope).toBeUndefined();
    view.dispose();
  });

  it("refreshes the current neighborhood on a new DDL snapshot without reopening the focus", async () => {
    const database = { serverId: "server", database: "demo" };
    const symbol = postgresSymbol("orders", "table", 42);
    const added = postgresSymbol("invoice", "table", 43);
    const initial = { ...database, revision: "revision-1", generation: 1 };
    const refreshed = { ...database, revision: "revision-2", generation: 2 };
    const index = {
      state: {
        status: "available",
        result: { ...initial, ...database },
      },
      indexedSymbols: [symbol],
      graphFocus: vi.fn(async (identity: string) =>
        graph(identity === symbol.uri ? symbol : added),
      ),
      graphSourcePreview: vi.fn(async () => undefined),
      assertGraphSnapshot: vi.fn(async () => undefined),
      objectOrigin: vi.fn(() => undefined),
    };
    const view = new WorkbenchGraphView({
      extensionUri: {} as never,
      index: scopedIndex(index) as never,
      openDefinition: async () => undefined,
      showActions: async () => undefined,
    });
    await view.open(
      {
        symbolUri: symbol.uri,
        sourceUri: symbol.file,
        ...database,
        schema: "shop",
        oid: 42,
        name: "orders",
        kind: "table",
        signature: "",
        params: [],
        plpgsql: false,
      },
      initial,
    );
    panel.post.mockClear();
    await expect(
      view.refreshSnapshot({
        serverId: "server-b",
        database: "other",
        revision: "other-revision",
        generation: 99,
      }),
    ).resolves.toBe(false);
    expect(panel.post).not.toHaveBeenCalled();
    expect(view.currentDatabase).toEqual(database);

    index.indexedSymbols = [symbol, added];
    index.state = {
      status: "available",
      result: { ...refreshed, ...database },
    };

    await view.refreshSnapshot(refreshed);

    expect(panel.post).toHaveBeenCalledOnce();
    expect(panel.post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "cockpitRefresh",
        payload: expect.objectContaining({
          focusIdentity: symbol.uri,
          validIdentities: expect.arrayContaining([symbol.uri, added.uri]),
          session: expect.objectContaining(refreshed),
        }),
      }),
    );
    panel.post.mockClear();
    panel.receive?.({ type: "ready" });
    await vi.waitFor(() =>
      expect(panel.post).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "cockpitFocus",
          payload: expect.objectContaining({
            neighborhood: expect.objectContaining({ focus: symbol }),
          }),
        }),
      ),
    );
    view.dispose();
  });

  it("remaps a visible pin even when its neighborhood was never loaded", async () => {
    const database = { serverId: "server", database: "demo" };
    const focus = postgresSymbol("orders", "table", 42);
    const pinned = postgresSymbol("invoice", "table", 43);
    const renamed = postgresSymbol("archived_invoice", "table", 43);
    const initial = { ...database, revision: "revision-1", generation: 1 };
    const refreshed = { ...database, revision: "revision-2", generation: 2 };
    const index = {
      state: { status: "available", result: { ...initial, ...database } },
      indexedSymbols: [focus, pinned],
      graphFocus: vi.fn(async () => graph(focus, [pinned])),
      graphSourcePreview: vi.fn(async () => undefined),
      assertGraphSnapshot: vi.fn(async () => undefined),
      objectOrigin: vi.fn(() => undefined),
    };
    const view = new WorkbenchGraphView({
      extensionUri: {} as never,
      index: scopedIndex(index) as never,
      openDefinition: async () => undefined,
      showActions: async () => undefined,
    });
    await view.open(
      {
        symbolUri: focus.uri,
        sourceUri: focus.file,
        ...database,
        schema: "shop",
        oid: 42,
        name: "orders",
        kind: "table",
        signature: "",
        params: [],
        plpgsql: false,
      },
      initial,
    );
    panel.receive?.({ type: "pin", symbolUri: pinned.uri, pinned: true });
    panel.post.mockClear();
    index.indexedSymbols = [focus, renamed];
    index.state = { status: "available", result: { ...refreshed, ...database } };
    index.graphFocus.mockResolvedValue(graph(focus));

    await view.refreshSnapshot(refreshed);

    expect(panel.post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "cockpitRefresh",
        payload: expect.objectContaining({
          identityRemap: expect.objectContaining({ [pinned.uri]: renamed.uri }),
          pinnedIdentities: [renamed.uri],
          presentations: expect.objectContaining({
            [renamed.uri]: expect.objectContaining({ label: "archived_invoice" }),
          }),
        }),
      }),
    );
    view.dispose();
  });

  it("routes a TreeView drop through the same focus pipeline as a tree selection", async () => {
    const database = { serverId: "server", database: "demo" };
    const focus = postgresSymbol("orders", "table", 42);
    const dropped = postgresSymbol("invoice", "table", 43);
    const snapshot = { ...database, revision: "revision-1", generation: 1 };
    const index = {
      state: { status: "available", result: { ...snapshot, ...database } },
      indexedSymbols: [focus, dropped],
      graphFocus: vi.fn(async (identity: string) =>
        graph(identity === focus.uri ? focus : dropped),
      ),
      graphSourcePreview: vi.fn(async () => undefined),
      assertGraphSnapshot: vi.fn(async () => undefined),
      objectOrigin: vi.fn(() => undefined),
    };
    const controller = new WorkbenchTreeDragAndDropController();
    const transfer = { set: vi.fn() } as never;
    const droppedObject = {
      symbolUri: dropped.uri,
      sourceUri: dropped.file,
      ...database,
      schema: "shop",
      oid: 43,
      name: "invoice",
      kind: "table" as const,
      signature: "",
      params: [],
      plpgsql: false,
    };
    controller.handleDrag([{ kind: "object", object: droppedObject }] as never, transfer);
    const view = new WorkbenchGraphView({
      extensionUri: {} as never,
      index: scopedIndex(index) as never,
      openDefinition: async () => undefined,
      showActions: async () => undefined,
      treeDragPayload: (consume) => controller.activePayload(consume),
    });
    await view.open(
      {
        ...droppedObject,
        symbolUri: focus.uri,
        sourceUri: focus.file,
        oid: 42,
        name: "orders",
      },
      snapshot,
    );
    panel.post.mockClear();

    panel.receive?.({ type: "resolveTreeDrag" });
    expect(panel.post).toHaveBeenCalledWith({
      type: "cockpitTreeDragStatus",
      payload: expect.objectContaining({ symbolUri: dropped.uri, availability: "accepted" }),
    });
    panel.receive?.({ type: "dropTreeSource" });
    await vi.waitFor(() =>
      expect(panel.post).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "cockpitFocus",
          payload: expect.objectContaining({
            neighborhood: expect.objectContaining({ focus: dropped }),
          }),
        }),
      ),
    );
    expect(view.currentScope).toBe(dropped.uri);
    panel.post.mockClear();
    panel.receive?.({ type: "ready" });
    await vi.waitFor(() =>
      expect(panel.post).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "cockpitFocus",
          payload: expect.objectContaining({
            neighborhood: expect.objectContaining({ focus: dropped }),
            pinned: [],
          }),
        }),
      ),
    );
    view.dispose();
  });

  it("waits for an active TreeView drop before closing the graph", async () => {
    const database = { serverId: "server", database: "demo" };
    const dropped = postgresSymbol("invoice", "table", 43);
    const snapshot = { ...database, revision: "revision-1", generation: 1 };
    let resolveFocus: ((value: ReturnType<typeof graph>) => void) | undefined;
    const index = {
      state: { status: "available", result: { ...snapshot, ...database } },
      indexedSymbols: [dropped],
      graphFocus: vi.fn(
        () =>
          new Promise<ReturnType<typeof graph>>((resolve) => {
            resolveFocus = resolve;
          }),
      ),
      graphSourcePreview: vi.fn(async () => undefined),
      assertGraphSnapshot: vi.fn(async () => undefined),
      objectOrigin: vi.fn(() => undefined),
    };
    const controller = new WorkbenchTreeDragAndDropController();
    const droppedObject = {
      symbolUri: dropped.uri,
      sourceUri: dropped.file,
      ...database,
      schema: "shop",
      oid: 43,
      name: "invoice",
      kind: "table" as const,
      signature: "",
      params: [],
      plpgsql: false,
    };
    controller.handleDrag(
      [{ kind: "object", object: droppedObject }] as never,
      { set: vi.fn() } as never,
    );
    const view = new WorkbenchGraphView({
      extensionUri: {} as never,
      index: scopedIndex(index) as never,
      openDefinition: async () => undefined,
      showActions: async () => undefined,
      treeDragPayload: (consume) => controller.activePayload(consume),
    });
    const payload = {
      version: 1 as const,
      availability: "accepted" as const,
      serverId: database.serverId,
      database: database.database,
      sourceUri: dropped.file,
      symbolUri: dropped.uri,
      kind: "table" as const,
      label: "shop.invoice",
    };

    const drop = view.acceptTreeDrop(payload);
    await vi.waitFor(() => expect(resolveFocus).toBeTypeOf("function"));
    const close = view.close();
    await expect(view.acceptTreeDrop(payload)).resolves.toBe(false);
    expect(view.currentScope).toBe(dropped.uri);

    resolveFocus?.(graph(dropped));
    await expect(drop).resolves.toBe(true);
    await expect(close).resolves.toBeUndefined();
    expect(view.currentScope).toBeUndefined();
    controller.dispose();
    view.dispose();
  });

  it("finishes an engaged focus action before applying a newer DDL snapshot", async () => {
    const database = { serverId: "server", database: "demo" };
    const orders = postgresSymbol("orders", "table", 42);
    const invoice = postgresSymbol("invoice", "table", 43);
    const initial = { ...database, revision: "revision-1", generation: 1 };
    const refreshed = { ...database, revision: "revision-2", generation: 2 };
    let resolveFocus: ((value: ReturnType<typeof graph>) => void) | undefined;
    let delayInvoice = true;
    const index = {
      state: { status: "available", result: { ...initial, ...database } },
      indexedSymbols: [orders, invoice],
      graphFocus: vi.fn(async (identity: string) => {
        if (identity === invoice.uri && delayInvoice) {
          delayInvoice = false;
          return new Promise<ReturnType<typeof graph>>((resolve) => {
            resolveFocus = resolve;
          });
        }
        return graph(identity === orders.uri ? orders : invoice);
      }),
      graphSourcePreview: vi.fn(async () => undefined),
      assertGraphSnapshot: vi.fn(async () => undefined),
      objectOrigin: vi.fn(() => undefined),
    };
    const view = new WorkbenchGraphView({
      extensionUri: {} as never,
      index: scopedIndex(index) as never,
      openDefinition: async () => undefined,
      showActions: async () => undefined,
    });
    await view.open(
      {
        symbolUri: orders.uri,
        sourceUri: orders.file,
        ...database,
        schema: "shop",
        oid: 42,
        name: "orders",
        kind: "table",
        signature: "",
        params: [],
        plpgsql: false,
      },
      initial,
    );
    const focusRun = view.focusNode(invoice.uri);
    await vi.waitFor(() => expect(resolveFocus).toBeTypeOf("function"));
    index.state = { status: "available", result: { ...refreshed, ...database } };
    const refreshRun = view.refreshSnapshot(refreshed);
    resolveFocus?.(graph(invoice));

    await expect(focusRun).resolves.toBe(true);
    await expect(refreshRun).resolves.toBe(true);
    expect(view.currentScope).toBe(invoice.uri);
    expect(panel.post).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "cockpitRefresh",
        payload: expect.objectContaining({ focusIdentity: invoice.uri }),
      }),
    );
    view.dispose();
  });

  it("serializes Source with focus and replays a pinned Source across reload and landing", async () => {
    const database = { serverId: "server", database: "demo" };
    const orders = postgresSymbol("orders", "table", 42);
    const invoice = postgresSymbol("invoice", "table", 43);
    const schema = postgresSchemaSymbol("shop", 2_200);
    const snapshot = { ...database, revision: "revision-1", generation: 1 };
    let delayInspection = false;
    let resolveInspection: ((value: ReturnType<typeof sourcePreview>) => void) | undefined;
    const index = {
      state: { status: "available", result: { ...snapshot, ...database } },
      indexedSymbols: [schema, orders, invoice],
      graphFocus: vi.fn(async (identity: string) =>
        graph(identity === orders.uri ? orders : invoice),
      ),
      graphSourcePreview: vi.fn(async (identity: string) => {
        if (delayInspection && identity === orders.uri) {
          delayInspection = false;
          return new Promise<ReturnType<typeof sourcePreview>>((resolve) => {
            resolveInspection = resolve;
          });
        }
        return sourcePreview(identity === orders.uri ? orders : invoice);
      }),
      assertGraphSnapshot: vi.fn(async () => undefined),
      objectOrigin: vi.fn(() => undefined),
    };
    const view = new WorkbenchGraphView({
      extensionUri: {} as never,
      index: scopedIndex(index) as never,
      openDefinition: async () => undefined,
      showActions: async () => undefined,
    });
    await view.open(
      {
        symbolUri: orders.uri,
        sourceUri: orders.file,
        ...database,
        schema: "shop",
        oid: 42,
        name: "orders",
        kind: "table",
        signature: "",
        params: [],
        plpgsql: false,
      },
      snapshot,
    );
    panel.post.mockClear();

    delayInspection = true;
    panel.receive?.({ type: "inspect", symbolUri: orders.uri });
    await vi.waitFor(() => expect(resolveInspection).toBeTypeOf("function"));
    const focusRun = view.focusNode(invoice.uri);
    resolveInspection?.(sourcePreview(orders));
    await expect(focusRun).resolves.toBe(true);

    const messages = panel.post.mock.calls.map(([message]) => message);
    const inspectionIndex = messages.findIndex(
      (message) => message.type === "cockpitPreview" && message.preview.title === "orders",
    );
    const focusIndex = messages.findIndex(
      (message) =>
        message.type === "cockpitFocus" && message.payload.neighborhood.focus.uri === invoice.uri,
    );
    expect(inspectionIndex).toBeGreaterThanOrEqual(0);
    expect(focusIndex).toBeGreaterThan(inspectionIndex);
    expect(messages[focusIndex]).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ sourceVisible: true, sourcePinned: false }),
      }),
    );

    panel.receive?.({ type: "pinPreview", symbolUri: invoice.uri, pinned: true });
    panel.post.mockClear();
    panel.receive?.({ type: "ready" });
    await vi.waitFor(() =>
      expect(panel.post).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "cockpitPreview",
          preview: expect.objectContaining({ title: "invoice" }),
          pinned: true,
        }),
      ),
    );

    panel.post.mockClear();
    await view.openDatabase(database, snapshot);
    expect(panel.post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "cockpitSession",
        sourceVisible: true,
        sourcePinned: true,
      }),
    );
    view.dispose();
  });
});

function postgresSymbol(name: string, kind: "table", oid: number) {
  const databasePrefix =
    "code+moniker://./srcset:postgres/lang:sql/dir:postgresql:/dir:server/dir:demo";
  return {
    uri: `${databasePrefix}/dir:shop/dir:${kind}/module:${name}/schema:shop/${kind}:${name}`,
    name,
    kind,
    file: `postgresql://server/demo/shop/${kind}/${name}.sql`,
    signature: "",
    postgres: {
      serverId: "server",
      database: "demo",
      schema: "shop",
      documentKind: kind,
      oid,
      name,
      signature: "",
    },
  };
}

function postgresSchemaSymbol(name: string, oid: number) {
  const databasePrefix =
    "code+moniker://./srcset:postgres/lang:sql/dir:postgresql:/dir:server/dir:demo";
  return {
    uri: `${databasePrefix}/dir:${name}/schema:${name}`,
    name,
    kind: "schema",
    file: `postgresql://server/demo/${name}/schema.sql`,
    signature: "",
    postgres: {
      serverId: "server",
      database: "demo",
      schema: name,
      documentKind: "schema",
      oid,
      name,
      signature: "",
    },
  };
}

function graph(
  focus: ReturnType<typeof postgresSymbol>,
  callees: ReturnType<typeof postgresSymbol>[] = [],
) {
  return {
    focus: { kind: "symbol", symbol: focus },
    callers: [],
    callees: callees.map((symbol) => ({ symbol, count: 1, kinds: ["references"] })),
    coverage: {
      callers: { matching: 0, returned: 0, total: 0 },
      callees: { matching: callees.length, returned: callees.length, total: callees.length },
      internal_edges: { matching: 0, returned: 0, total: 0 },
      members: { matching: 0, returned: 0, total: 0 },
    },
    unlinked: { external: 0, manifest_blocked: 0, unresolved: 0 },
  };
}

function sourcePreview(symbol: ReturnType<typeof postgresSymbol>) {
  return {
    symbol,
    source: {
      file: symbol.file,
      first_line: 1,
      last_line: 1,
      lines: [{ number: 1, text: `create table ${symbol.name} ();` }],
    },
  };
}
