import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { OffsetResultSession } from "../../../packages/rows/src/offsetQuery.js";
import type { SqlNotebookResultPayload } from "../../../packages/rows/src/resultPayload.js";

const renderer = vi.hoisted(() => ({
  listener: undefined as
    | ((event: { editor: vscode.NotebookEditor; message: unknown }) => void)
    | undefined,
  postMessage: vi.fn(),
  executeCommand: vi.fn(),
  showSaveDialog: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
}));

vi.mock("vscode", () => ({
  commands: { executeCommand: renderer.executeCommand },
  notebooks: {
    createRendererMessaging: () => ({
      onDidReceiveMessage(listener: typeof renderer.listener) {
        renderer.listener = listener;
        return { dispose: vi.fn() };
      },
      postMessage: renderer.postMessage,
    }),
  },
  window: {
    showSaveDialog: renderer.showSaveDialog,
    showInformationMessage: renderer.showInformationMessage,
    showErrorMessage: renderer.showErrorMessage,
  },
  workspace: { workspaceFolders: undefined },
}));

import { SqlNotebookResultHost } from "./resultHost.js";

const binding = {
  connectionId: "test-connection",
  connectionName: "Test PostgreSQL",
  database: "testdb",
};

const payload: SqlNotebookResultPayload = {
  version: 2,
  resultId: "result-1",
  binding,
  statement: "select id from inventory",
  command: "SELECT",
  columns: [{ name: "id", dataTypeId: 23, typeName: "integer" }],
  rows: [[{ kind: "number", value: "1" }]],
  capturedRowCount: 1,
  durationMs: 1,
  truncated: false,
  truncationReasons: [],
  navigation: {
    sessionId: "result-1",
    mode: "paged",
    pageIndex: 0,
    pageSize: 20,
    pageStart: 1,
    pageEnd: 1,
    loadedRowCount: 1,
    hasPrevious: false,
    hasNext: true,
    canLoadAll: true,
  },
};

function fakeCell(): vscode.NotebookCell {
  return {
    document: { uri: { toString: () => "cell://one" } },
    notebook: { uri: { toString: () => "notebook://one" } },
  } as unknown as vscode.NotebookCell;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeResult(overrides: Partial<OffsetResultSession> = {}): OffsetResultSession {
  return {
    id: "result-1",
    snapshot: () => payload,
    next: vi.fn().mockResolvedValue({
      ...payload,
      rows: [[{ kind: "number", value: "21" }]],
      navigation: { ...payload.navigation, pageIndex: 1, pageStart: 21, pageEnd: 21 },
    }),
    previous: vi.fn().mockReturnValue(payload),
    loadAll: vi.fn().mockResolvedValue(payload),
    loadedResult: () => ({ columns: payload.columns, rows: payload.rows }),
    displayedRows: () => payload.rows,
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as OffsetResultSession;
}

beforeEach(() => {
  renderer.listener = undefined;
  renderer.postMessage.mockReset().mockResolvedValue(true);
  renderer.executeCommand.mockReset().mockResolvedValue(undefined);
  renderer.showSaveDialog.mockReset();
  renderer.showInformationMessage.mockReset();
  renderer.showErrorMessage.mockReset();
});

describe("SQL notebook result host", () => {
  it("navigates through the shared in-memory LIMIT/OFFSET result", async () => {
    const result = fakeResult();
    const host = new SqlNotebookResultHost();
    await host.register(result, fakeCell(), binding);

    renderer.listener?.({
      editor: {} as vscode.NotebookEditor,
      message: { type: "sql-result/request", sessionId: "result-1", action: "next" },
    });
    await flush();

    expect(result.next).toHaveBeenCalledOnce();
    expect(renderer.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sql-result/update", sessionId: "result-1" }),
      expect.anything(),
    );
    host.dispose();
  });

  it("returns the retained value to inspection and export preview", async () => {
    const full = "x".repeat(80_000);
    const result = fakeResult({
      loadedResult: () => ({
        columns: payload.columns,
        rows: [[{ kind: "text", value: full }]],
      }),
      displayedRows: () => [[{ kind: "text", value: "xxxx", truncated: true }]],
    } as Partial<OffsetResultSession>);
    const host = new SqlNotebookResultHost();
    await host.register(result, fakeCell(), binding);
    const editor = {} as vscode.NotebookEditor;

    renderer.listener?.({
      editor,
      message: {
        type: "sql-result/inspect",
        requestId: "inspect-1",
        resultId: "result-1",
        page: { start: 1, length: 1 },
        row: 0,
        ordinal: 0,
      },
    });
    renderer.listener?.({
      editor,
      message: {
        type: "sql-result/preview",
        requestId: 1,
        resultId: "result-1",
        choice: {
          format: "json",
          header: true,
          nullAs: "empty",
          delimiter: ",",
          createTable: false,
          spreadsheetSafe: true,
          finalNewline: true,
        },
        scope: "loaded",
        page: { start: 1, length: 1 },
      },
    });
    await flush();

    expect(renderer.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sql-result/inspected",
        cell: { kind: "text", value: full },
      }),
      editor,
    );
    expect(renderer.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sql-result/previewed",
        text: expect.stringContaining(full),
      }),
      editor,
    );
    host.dispose();
  });

  it("rejects renderer page coordinates outside the retained result", async () => {
    const host = new SqlNotebookResultHost();
    await host.register(fakeResult(), fakeCell(), binding);
    renderer.listener?.({
      editor: {} as vscode.NotebookEditor,
      message: {
        type: "sql-result/preview",
        requestId: 2,
        resultId: "result-1",
        choice: {
          format: "csv",
          header: true,
          nullAs: "empty",
          delimiter: ",",
          createTable: false,
          spreadsheetSafe: true,
          finalNewline: true,
        },
        scope: "selection",
        page: { start: 200, length: 10 },
        selection: { from: 0, to: 0, ordinals: [0] },
      },
    });
    await flush();
    expect(renderer.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sql-result/previewed",
        text: "The displayed result page is outside the retained rows.",
      }),
      expect.anything(),
    );
    host.dispose();
  });

  it("closes the page source when its cell is replaced", async () => {
    const first = fakeResult();
    const second = fakeResult({ id: "result-2" } as Partial<OffsetResultSession>);
    const host = new SqlNotebookResultHost();
    await host.register(first, fakeCell(), binding);
    await host.register(second, fakeCell(), binding);
    expect(first.close).toHaveBeenCalledOnce();
    host.dispose();
  });
});
