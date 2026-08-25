import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({}));

import { DataViewDocument } from "./dataViewDocument.js";

describe("Data View result cancellation", () => {
  it("does not let a superseded navigation clear a newer load state", async () => {
    let finishNavigation: ((value: object) => void) | undefined;
    const next = vi.fn(
      () =>
        new Promise<object>((resolve) => {
          finishNavigation = resolve;
        }),
    );
    const session = { next };
    const replacement = {};
    const broadcastState = vi.fn();
    const payload = {
      columns: [],
      rows: [],
      capturedRowCount: 1,
      truncated: false,
      truncationReasons: [],
      navigation: {
        sessionId: "result-1",
        mode: "paged" as const,
        pageIndex: 0,
        pageSize: 1,
        pageStart: 1,
        pageEnd: 1,
        loadedRowCount: 1,
        hasPrevious: false,
        hasNext: true,
        canLoadAll: true,
      },
    };
    const document = Object.create(DataViewDocument.prototype) as {
      navigate(action: "next"): Promise<void>;
      loadGeneration: number;
      session: object | undefined;
      payload: typeof payload;
      busy: boolean;
      cancellable: boolean;
      broadcastState(): void;
      broadcast(message: unknown): void;
    };
    Object.assign(document, {
      loadGeneration: 1,
      session,
      payload,
      busy: false,
      cancellable: false,
      broadcastState,
      broadcast: vi.fn(),
    });

    const navigating = document.navigate("next");
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    expect(document.busy).toBe(true);
    expect(document.cancellable).toBe(true);

    document.loadGeneration = 2;
    document.session = replacement;
    document.busy = true;
    document.cancellable = true;
    finishNavigation?.(payload);
    await navigating;

    expect(document.session).toBe(replacement);
    expect(document.busy).toBe(true);
    expect(document.cancellable).toBe(true);
    expect(broadcastState).toHaveBeenCalledOnce();
  });

  it("does not let a superseded navigation failure overwrite a newer load message", async () => {
    let failNavigation: ((error: Error) => void) | undefined;
    let finishClose: (() => void) | undefined;
    const next = vi.fn(
      () =>
        new Promise<object>((_resolve, reject) => {
          failNavigation = reject;
        }),
    );
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const session = { next, close };
    const replacement = {};
    const payload = {
      columns: [],
      rows: [],
      capturedRowCount: 1,
      truncated: false,
      truncationReasons: [],
      navigation: {
        sessionId: "result-1",
        mode: "paged" as const,
        pageIndex: 0,
        pageSize: 1,
        pageStart: 1,
        pageEnd: 1,
        loadedRowCount: 1,
        hasPrevious: false,
        hasNext: true,
        canLoadAll: true,
      },
    };
    const document = Object.create(DataViewDocument.prototype) as {
      navigate(action: "next"): Promise<void>;
      loadGeneration: number;
      pendingLoadCancel: undefined;
      session: object | undefined;
      payload: typeof payload;
      busy: boolean;
      cancellable: boolean;
      message: string | undefined;
      broadcastState(): void;
      broadcast(message: unknown): void;
    };
    Object.assign(document, {
      loadGeneration: 1,
      pendingLoadCancel: undefined,
      session,
      payload,
      busy: false,
      cancellable: false,
      message: undefined,
      broadcastState: vi.fn(),
      broadcast: vi.fn(),
    });

    const navigating = document.navigate("next");
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    failNavigation?.(new Error("old navigation failed"));
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());

    document.loadGeneration = 2;
    document.session = replacement;
    document.message = undefined;
    document.busy = true;
    document.cancellable = true;
    finishClose?.();
    await navigating;

    expect(document.session).toBe(replacement);
    expect(document.message).toBeUndefined();
    expect(document.busy).toBe(true);
    expect(document.cancellable).toBe(true);
  });

  it("cancels an opening result before a page session exists", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const broadcastState = vi.fn();
    const document = Object.create(DataViewDocument.prototype) as {
      navigate(action: "cancel"): Promise<void>;
      loadGeneration: number;
      pendingLoadCancel: (() => Promise<void>) | undefined;
      session: undefined;
      busy: boolean;
      cancellable: boolean;
      message: string | undefined;
      broadcastState(): void;
    };
    Object.assign(document, {
      loadGeneration: 1,
      pendingLoadCancel: cancel,
      session: undefined,
      busy: true,
      cancellable: true,
      message: undefined,
      broadcastState,
    });

    await document.navigate("cancel");

    expect(cancel).toHaveBeenCalledOnce();
    expect(document.loadGeneration).toBe(2);
    expect(document.pendingLoadCancel).toBeUndefined();
    expect(document.busy).toBe(false);
    expect(document.cancellable).toBe(false);
    expect(document.message).toBe("Loading cancelled. Refresh to load the rows again.");
    expect(broadcastState).toHaveBeenCalledOnce();
  });
});
