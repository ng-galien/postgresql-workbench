import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

vi.mock("vscode", () => {
  class EventEmitter<T> {
    readonly event = vi.fn();
    fire(_value: T): void {}
    dispose(): void {}
  }

  return {
    Disposable: class {
      constructor(private readonly callback: () => void) {}
      dispose(): void {
        this.callback();
      }
    },
    EventEmitter,
    window: { showWarningMessage: vi.fn() },
  };
});

import { ScratchpadTransactionManager } from "./transactions.js";

const association = {
  connectionId: "postgres:5432/demo:postgres",
  connectionName: "postgres@postgres:5432/demo",
  database: "demo",
};

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function fixture() {
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      return {};
    }),
    end: vi.fn().mockResolvedValue(undefined),
  } as unknown as Client;
  const connections = {
    createDedicatedClient: vi.fn().mockResolvedValue(client),
  };
  const transactions = new ScratchpadTransactionManager(connections as never);
  return { client, connections, queries, transactions };
}

describe("ScratchpadTransactionManager", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it("serializes execution and resolution for one Scratchpad", async () => {
    const { client, connections, queries, transactions } = fixture();
    const firstAction = deferred();
    const events: string[] = [];

    const first = transactions.execute("scratchpad:1", "Scratch 1", association, async () => {
      events.push("first:start");
      await firstAction.promise;
      events.push("first:end");
      return 1;
    });
    await vi.waitFor(() => expect(events).toEqual(["first:start"]));

    const second = transactions.execute("scratchpad:1", "Scratch 1", association, async () => {
      events.push("second");
      return 2;
    });
    const commit = transactions.commit("scratchpad:1");
    expect(events).toEqual(["first:start"]);
    expect(queries).toEqual(["BEGIN"]);

    firstAction.resolve(undefined);
    await expect(Promise.all([first, second, commit])).resolves.toEqual([1, 2, true]);

    expect(events).toEqual(["first:start", "first:end", "second"]);
    expect(connections.createDedicatedClient).toHaveBeenCalledTimes(1);
    expect(queries).toEqual(["BEGIN", "COMMIT"]);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("exposes a fallback only when one Scratchpad owns a Transaction", async () => {
    const { transactions } = fixture();

    await transactions.execute("scratchpad:1", "Scratch 1", association, async () => undefined);
    expect(transactions.soleTransaction()?.scratchpadUri).toBe("scratchpad:1");

    await transactions.execute("scratchpad:2", "Scratch 2", association, async () => undefined);
    expect(transactions.soleTransaction()).toBeUndefined();

    await transactions.rollback("scratchpad:1");
    expect(transactions.soleTransaction()?.scratchpadUri).toBe("scratchpad:2");
  });

  it("keeps a cancelled MANUAL Transaction visible as failed until rollback", async () => {
    const { transactions } = fixture();
    await transactions.execute("scratchpad:1", "Scratch 1", association, async () => undefined);

    transactions.markFailed("scratchpad:1");

    expect(transactions.transaction("scratchpad:1")?.status).toBe("failed");
    await expect(
      transactions.execute("scratchpad:1", "Scratch 1", association, async () => undefined),
    ).rejects.toThrow("Roll it back");
    await expect(transactions.rollback("scratchpad:1")).resolves.toBe(true);
    expect(transactions.transaction("scratchpad:1")).toBeUndefined();
  });

  it("waits for in-flight work, rolls back, and refuses new work on shutdown", async () => {
    const { client, queries, transactions } = fixture();
    const action = deferred();
    const execution = transactions.execute("scratchpad:1", "Scratch 1", association, async () => {
      await action.promise;
      return "done";
    });
    await vi.waitFor(() => expect(queries).toEqual(["BEGIN"]));

    const shutdown = transactions.shutdown();
    await expect(
      transactions.execute("scratchpad:2", "Scratch 2", association, async () => "late"),
    ).rejects.toThrow("shutting down");
    expect(queries).toEqual(["BEGIN"]);

    action.resolve(undefined);
    await expect(execution).resolves.toBe("done");
    await shutdown;

    expect(queries).toEqual(["BEGIN", "ROLLBACK"]);
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("rolls back safely and blocks new Scratchpad work until a Connection change lease is released", async () => {
    const { queries, transactions } = fixture();
    await transactions.execute("scratchpad:1", "Scratch 1", association, async () => "done");

    const lease = await transactions.acquireConnectionChange(
      association.connectionId,
      "disconnecting the Connection",
    );
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(queries).toEqual(["BEGIN", "ROLLBACK"]);
    expect(transactions.transaction("scratchpad:1")).toBeUndefined();

    await expect(
      transactions.execute("scratchpad:2", "Scratch 2", association, async () => "late"),
    ).rejects.toThrow("Connection is changing");

    expect(lease).toBeDefined();
    lease?.dispose();
    await expect(
      transactions.execute("scratchpad:2", "Scratch 2", association, async () => "after"),
    ).resolves.toBe("after");
  });

  it("rolls back the Transaction of a closed Scratchpad once the user is warned", async () => {
    const { queries, transactions } = fixture();
    await transactions.execute("scratchpad:1", "Scratch 1", association, async () => "done");
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Roll Back" as never);

    await transactions.resolveClosedScratchpad("scratchpad:1");

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining("Closing the Scratchpad rolls it back"),
      { modal: true },
      "Roll Back",
    );
    expect(queries).toContain("ROLLBACK");
  });

  it("keeps the Transaction of a closed Scratchpad when the warning is cancelled", async () => {
    const { queries, transactions } = fixture();
    await transactions.execute("scratchpad:1", "Scratch 1", association, async () => "done");
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);

    await transactions.resolveClosedScratchpad("scratchpad:1");

    // A reopened Scratchpad finds its Transaction where it left it.
    expect(queries).not.toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
  });

  it("says nothing when a Scratchpad without a Transaction closes", async () => {
    const { transactions } = fixture();
    await transactions.resolveClosedScratchpad("scratchpad:1");
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("holds a Scratchpad barrier through its mutation", async () => {
    const { transactions } = fixture();
    await transactions.execute("scratchpad:1", "Scratch 1", association, async () => "done");
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("Rollback" as never);
    const mutation = deferred();
    const change = transactions.runScratchpadChange(
      "scratchpad:1",
      "changing its Mode",
      async () => {
        await mutation.promise;
        return "changed";
      },
    );
    await vi.waitFor(() => expect(vscode.window.showWarningMessage).toHaveBeenCalled());
    await expect(
      transactions.execute("scratchpad:1", "Scratch 1", association, async () => "stale"),
    ).rejects.toThrow("Scratchpad is changing");

    mutation.resolve(undefined);
    await expect(change).resolves.toEqual({ accepted: true, value: "changed" });
  });

  it("evaluates a queued Mode no-op only when its exclusive turn starts", async () => {
    const { transactions } = fixture();
    let mode: "auto" | "manual" = "manual";
    const firstMutation = deferred();
    const auto = transactions.runScratchpadChange(
      "scratchpad:1",
      "changing its Mode",
      async () => {
        await firstMutation.promise;
        mode = "auto";
      },
      () => mode === "auto",
    );
    const manual = transactions.runScratchpadChange(
      "scratchpad:1",
      "changing its Mode",
      async () => {
        mode = "manual";
      },
      () => mode === "manual",
    );

    firstMutation.resolve(undefined);
    await Promise.all([auto, manual]);

    expect(mode).toBe("manual");
  });

  it("bounds shutdown and force-closes a session when work does not drain", async () => {
    vi.useFakeTimers();
    const { client, queries, transactions } = fixture();
    void transactions.execute(
      "scratchpad:1",
      "Scratch 1",
      association,
      () => new Promise(() => {}),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(queries).toEqual(["BEGIN"]);

    const shutdown = transactions.shutdown();
    await vi.advanceTimersByTimeAsync(2_000);
    await shutdown;

    expect(queries).toEqual(["BEGIN"]);
    expect(client.end).toHaveBeenCalledTimes(1);
  });
});
