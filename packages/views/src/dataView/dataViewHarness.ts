import type { DebugResultCell } from "../../../dap/src/debugger/launch/index.js";
import { EMPTY_DATA_VIEW_EDITABILITY } from "../../../rows/src/dataView.js";
import type {
  DataViewRequest,
  DataViewResponse,
  DataViewState,
} from "../../../rows/src/dataViewProtocol.js";
import type { SqlNotebookResultPayload } from "../../../rows/src/resultPayload.js";
import type { DataViewMessaging } from "./DataViewApp.js";

/**
 * The Data View behind its port. The component reaches VS Code only through `messaging`, so a
 * fake one drives the whole view — its query line, its grid, its menus — with no Extension Host
 * and no Electron. What genuinely needs those is the message crossing the wire, not what the view
 * does with it.
 */
export interface DataViewHarness extends DataViewMessaging {
  /** Every request the view has posted, oldest first. */
  readonly posted: DataViewRequest[];
  /** The last request of this type, or undefined when the view never sent one. */
  lastPost<T extends DataViewRequest["type"]>(
    type: T,
  ): Extract<DataViewRequest, { type: T }> | undefined;
  /** Delivers what the Extension Host would have sent. */
  deliver(response: DataViewResponse): void;
}

export function dataViewHarness(): DataViewHarness {
  const posted: DataViewRequest[] = [];
  const listeners = new Set<(response: DataViewResponse) => void>();
  return {
    posted,
    post: (message) => {
      posted.push(message);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    lastPost: (type) => {
      const matching = posted.filter((request) => request.type === type);
      return matching[matching.length - 1] as never;
    },
    deliver: (response) => {
      for (const listener of listeners) listener(response);
    },
  };
}

function cells(values: readonly (string | null)[]): DebugResultCell[] {
  return values.map((value) => ({ value, kind: "text" }));
}

/** A result of two columns over `rows`, as the host would send it. */
export function dataViewPayload(
  rows: readonly (readonly (string | null)[])[],
): SqlNotebookResultPayload {
  return {
    version: 2,
    binding: { serverId: "demo", serverName: "demo", database: "demo" },
    command: "SELECT",
    durationMs: 3,
    columns: [
      { name: "id", typeName: "integer", dataTypeId: 23 },
      { name: "name", typeName: "text", dataTypeId: 25 },
    ],
    rows: rows.map(cells),
    rowCount: rows.length,
    capturedRowCount: rows.length,
    truncated: false,
    truncationReasons: [],
    // A Data View result always comes from a bounded cursor, and a cursor always says where the
    // reader stands: a payload without this is a shape the host never sends.
    navigation: {
      sessionId: "data-view-1",
      mode: "paged",
      pageIndex: 0,
      pageSize: 200,
      pageStart: rows.length === 0 ? 0 : 1,
      pageEnd: rows.length,
      loadedRowCount: rows.length,
      cacheStart: 1,
      hasPrevious: false,
      hasNext: false,
      canLoadAll: false,
    },
  };
}

/** A ready view over `shop.product`, with whatever the scenario needs to differ. */
export function dataViewState(overrides: Partial<DataViewState> = {}): DataViewState {
  return {
    source: {
      kind: "relation",
      serverId: "demo",
      database: "demo",
      schema: "shop",
      name: "product",
      relationKind: "table",
    },
    serverName: "demo",
    query: {
      uri: "data-view:/shop.product.sql",
      text: "SELECT id, name FROM shop.product",
      orderBy: [],
      hidden: [],
      structured: true,
      editorDirty: false,
    },
    projection: {
      tables: [{ tableOid: 1, schema: "shop", name: "product", accent: 0 }],
      columnTable: [0, 0],
    },
    status: "ready",
    payload: dataViewPayload([
      ["1", "Espresso"],
      ["2", "Ristretto"],
    ]),
    editability: EMPTY_DATA_VIEW_EDITABILITY,
    edits: [],
    removedRows: [],
    addedRows: [],
    busy: false,
    applying: false,
    ...overrides,
  };
}
