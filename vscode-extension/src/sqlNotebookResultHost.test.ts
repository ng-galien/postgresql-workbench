import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type { SqlNotebookResultAction, SqlNotebookResultPayload } from "./sqlNotebookModel.js";
import type { SqlResultSession } from "./sqlResultSession.js";

const renderer = vi.hoisted(() => ({
  listener: undefined as
    | ((event: { editor: vscode.NotebookEditor; message: unknown }) => void)
    | undefined,
  postMessage: vi.fn(),
  executeCommand: vi.fn(),
}));

vi.mock("vscode", () => ({
  commands: {
    executeCommand: renderer.executeCommand,
  },
  notebooks: {
    createRendererMessaging: () => ({
      onDidReceiveMessage(listener: typeof renderer.listener) {
        renderer.listener = listener;
        return { dispose: vi.fn() };
      },
      postMessage: renderer.postMessage,
    }),
  },
}));

import { postgresCursorSafetyTimeoutMs, SqlNotebookResultHost } from "./sqlNotebookResultHost.js";

const TEST_BINDING = {
  serverId: "test-server",
  serverName: "Test PostgreSQL",
  database: "testdb",
};

const RESULT: SqlNotebookResultPayload = {
  version: 2,
  binding: TEST_BINDING,
  command: "SELECT",
  columns: [],
  rows: [],
  rowCount: 0,
  capturedRowCount: 0,
  durationMs: 1,
  truncated: false,
  truncationReasons: [],
};

const PAGED_RESULT: SqlNotebookResultPayload = {
  ...RESULT,
  rowCount: undefined,
  capturedRowCount: 200,
  navigation: {
    sessionId: "session-1",
    mode: "paged",
    pageIndex: 0,
    pageSize: 200,
    pageStart: 1,
    pageEnd: 200,
    loadedRowCount: 201,
    cacheStart: 1,
    hasPrevious: false,
    hasNext: true,
    canLoadAll: true,
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeCell(): vscode.NotebookCell {
  return {
    document: { uri: { toString: () => "cell://one" } },
    notebook: { uri: { toString: () => "notebook://one" } },
  } as unknown as vscode.NotebookCell;
}

function send(action: SqlNotebookResultAction): void {
  renderer.listener?.({
    editor: {} as vscode.NotebookEditor,
    message: { type: "sql-result/request", sessionId: "session-1", action },
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  renderer.listener = undefined;
  renderer.postMessage.mockReset();
  renderer.postMessage.mockResolvedValue(true);
  renderer.executeCommand.mockReset();
  renderer.executeCommand.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SQL notebook result host", () => {
  it("keeps PostgreSQL's recovery timeout behind the result-session deadline", () => {
    expect(postgresCursorSafetyTimeoutMs(300_000)).toBe(600_000);
    expect(postgresCursorSafetyTimeoutMs(10_000)).toBe(60_000);
  });

  it("opens the SQL analysis settings from a renderer budget action", async () => {
    const host = new SqlNotebookResultHost();
    renderer.listener?.({
      editor: {} as vscode.NotebookEditor,
      message: { type: "sql-error/open-analysis-settings" },
    });
    await flush();

    expect(renderer.executeCommand).toHaveBeenCalledWith(
      "workbench.action.openSettings",
      "@ext:ng-galien.postgresql-workbench postgresql-workbench.sqlAuthoring.syntaxMax",
    );
    host.dispose();
  });

  it("opens the Scratchpad timeout picker from a renderer timeout action", async () => {
    const host = new SqlNotebookResultHost();
    const notebook = { uri: { toString: () => "notebook://one" } } as vscode.NotebookDocument;
    renderer.listener?.({
      editor: { notebook } as vscode.NotebookEditor,
      message: { type: "sql-error/increase-scratchpad-timeout" },
    });
    await flush();

    expect(renderer.executeCommand).toHaveBeenCalledWith(
      "postgresql-workbench.setScratchpadStatementTimeout",
      notebook,
    );
    host.dispose();
  });

  it("detaches a complete result instead of expiring static rows later", async () => {
    vi.useFakeTimers();
    const session = {
      id: "session-1",
      snapshot: () => RESULT,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as SqlResultSession;
    const host = new SqlNotebookResultHost();

    await expect(host.register(session, fakeCell(), 300_000, TEST_BINDING)).resolves.toEqual(
      RESULT,
    );
    expect(session.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(renderer.postMessage).not.toHaveBeenCalled();
    host.dispose();
  });

  it("expires a result session at its configured idle deadline, never before", async () => {
    vi.useFakeTimers();
    const session = {
      id: "session-1",
      snapshot: () => PAGED_RESULT,
      close: vi.fn().mockRejectedValue(new Error("connection already closed")),
    } as unknown as SqlResultSession;
    const host = new SqlNotebookResultHost();
    await host.register(session, fakeCell(), 300_000, TEST_BINDING);

    await vi.advanceTimersByTimeAsync(299_999);
    expect(session.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(session.close).toHaveBeenCalledOnce();
    expect(renderer.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sql-result/error",
        message:
          "This result session expired after 300 seconds without result navigation. Run the SQL cell again.",
        closed: true,
      }),
    );
    host.dispose();
  });

  it("restarts the idle deadline after renderer activity", async () => {
    vi.useFakeTimers();
    const session = {
      id: "session-1",
      snapshot: () => PAGED_RESULT,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as SqlResultSession;
    const host = new SqlNotebookResultHost();
    await host.register(session, fakeCell(), 300_000, TEST_BINDING);

    await vi.advanceTimersByTimeAsync(250_000);
    send("attach");
    await vi.advanceTimersByTimeAsync(0);
    renderer.postMessage.mockClear();

    await vi.advanceTimersByTimeAsync(299_999);
    expect(session.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(session.close).toHaveBeenCalledOnce();
    host.dispose();
  });

  it("keeps results across active-context changes and closes them on binding changes", async () => {
    const session = {
      id: "session-1",
      snapshot: () => PAGED_RESULT,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as SqlResultSession;
    const host = new SqlNotebookResultHost();
    await host.register(session, fakeCell(), 300_000, TEST_BINDING);

    await host.closeNotebookAssociationMismatch("notebook://one", { ...TEST_BINDING });
    expect(session.close).not.toHaveBeenCalled();

    await host.closeNotebookAssociationMismatch("notebook://one", {
      ...TEST_BINDING,
      database: "otherdb",
    });
    expect(session.close).toHaveBeenCalledOnce();
    host.dispose();
  });

  it("rejects a cursor session whose binding changes while registration is yielding", async () => {
    let current = true;
    const session = {
      id: "session-1",
      snapshot: () => PAGED_RESULT,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as SqlResultSession;
    const host = new SqlNotebookResultHost();

    const registration = host.register(session, fakeCell(), 300_000, TEST_BINDING, () => current);
    current = false;

    await expect(registration).rejects.toThrow("Association changed");
    expect(session.close).toHaveBeenCalledOnce();
    host.dispose();
  });

  it("keeps a single expiration message while cursor closure is still pending", async () => {
    vi.useFakeTimers();
    const closing = deferred<void>();
    const session = {
      id: "session-1",
      snapshot: () => PAGED_RESULT,
      close: vi.fn(() => closing.promise),
    } as unknown as SqlResultSession;
    const host = new SqlNotebookResultHost();
    await host.register(session, fakeCell(), 60_000, TEST_BINDING);

    await vi.advanceTimersByTimeAsync(60_000);
    send("attach");
    await vi.advanceTimersByTimeAsync(0);
    expect(renderer.postMessage).toHaveBeenCalledTimes(1);

    closing.resolve();
    await vi.advanceTimersByTimeAsync(0);
    host.dispose();
  });

  it("delivers Load all progress before the final result update", async () => {
    const progressPosted = deferred<boolean>();
    renderer.postMessage.mockImplementation((message: { type: string }) =>
      message.type === "sql-result/progress" ? progressPosted.promise : Promise.resolve(true),
    );
    const session = {
      id: "session-1",
      snapshot: () => PAGED_RESULT,
      loadAll: async (onProgress: (count: number) => void) => {
        onProgress(2_000);
        return { ...RESULT, rowCount: 2_000, capturedRowCount: 2_000 };
      },
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as SqlResultSession;
    const host = new SqlNotebookResultHost();
    await host.register(session, fakeCell(), 60_000, TEST_BINDING);

    send("load-all");
    await flush();
    expect(renderer.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
      "sql-result/progress",
    ]);

    progressPosted.resolve(true);
    await flush();
    expect(renderer.postMessage.mock.calls.map(([message]) => message.type)).toEqual([
      "sql-result/progress",
      "sql-result/update",
    ]);
    host.dispose();
  });

  it("cancels an in-flight Load all without a late duplicate error", async () => {
    const loading = deferred<SqlNotebookResultPayload>();
    const session = {
      id: "session-1",
      snapshot: () => PAGED_RESULT,
      loadAll: () => loading.promise,
      close: vi.fn().mockRejectedValue(new Error("cursor close failed")),
    } as unknown as SqlResultSession;
    const host = new SqlNotebookResultHost();
    await host.register(session, fakeCell(), 60_000, TEST_BINDING);

    send("load-all");
    await flush();
    send("cancel");
    await flush();
    loading.reject(new Error("cursor closed"));
    await flush();

    expect(renderer.postMessage).toHaveBeenCalledTimes(1);
    expect(renderer.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sql-result/error",
        message: "Result loading cancelled.",
        closed: true,
      }),
      expect.anything(),
    );
    expect(session.close).toHaveBeenCalledOnce();
    host.dispose();
  });

  it("detaches an exhausted evicted page while preserving its partial-result warning", async () => {
    const partialResult: SqlNotebookResultPayload = {
      ...PAGED_RESULT,
      rowCount: 5_000,
      capturedRowCount: 1_000,
      truncated: true,
      truncationReasons: ["rows"],
      navigation: {
        ...PAGED_RESULT.navigation!,
        pageStart: 4_001,
        pageEnd: 5_000,
        cacheStart: 4_001,
        hasPrevious: false,
        hasNext: false,
        canLoadAll: false,
      },
    };
    const session = {
      id: "session-1",
      snapshot: () => PAGED_RESULT,
      next: vi.fn().mockResolvedValue(partialResult),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as SqlResultSession;
    const host = new SqlNotebookResultHost();
    await host.register(session, fakeCell(), 60_000, TEST_BINDING);

    send("next");
    await flush();
    expect(renderer.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sql-result/update",
        payload: expect.objectContaining({
          rowCount: 5_000,
          capturedRowCount: 1_000,
          truncated: true,
          truncationReasons: ["rows"],
        }),
      }),
      expect.anything(),
    );
    const postedPayload = renderer.postMessage.mock.calls[0]?.[0].payload;
    expect(postedPayload).not.toHaveProperty("navigation");
    expect(session.close).toHaveBeenCalledOnce();
    host.dispose();
  });
});
