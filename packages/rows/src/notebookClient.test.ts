import type { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  cancelNotebookClient,
  configureNotebookStatementTimeout,
  DedicatedNotebookConnectionError,
  NotebookClientCancellation,
  NotebookExecutionCancelledError,
  withDedicatedNotebookClient,
} from "./notebookClient.js";

describe("dedicated SQL notebook connections", () => {
  it("sets the PostgreSQL Statement timeout for the dedicated Scratchpad session", async () => {
    const query = vi.fn().mockResolvedValue({});

    await configureNotebookStatementTimeout({ query } as unknown as Client, 300_000);

    expect(query).toHaveBeenCalledWith("SELECT set_config('statement_timeout', $1, false)", [
      "300000ms",
    ]);
  });

  it("closes the dedicated client after success without changing another context", async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const provider = {
      createDedicatedClient: vi.fn().mockResolvedValue({ end } as unknown as Client),
    };

    await expect(
      withDedicatedNotebookClient(provider, "bound-context", async () => "done"),
    ).resolves.toBe("done");
    expect(provider.createDedicatedClient).toHaveBeenCalledWith("bound-context");
    expect(end).toHaveBeenCalledOnce();
  });

  it("closes the dedicated client when SQL execution fails", async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const provider = {
      createDedicatedClient: vi.fn().mockResolvedValue({ end } as unknown as Client),
    };

    await expect(
      withDedicatedNotebookClient(provider, "bound-context", async () => {
        throw new Error("query failed");
      }),
    ).rejects.toThrow("query failed");
    expect(end).toHaveBeenCalledOnce();
  });

  it("distinguishes a binding connection failure from a SQL execution failure", async () => {
    const provider = {
      createDedicatedClient: vi.fn().mockRejectedValue(new Error("connection refused")),
    };

    await expect(
      withDedicatedNotebookClient(provider, "bound-context", async () => "never"),
    ).rejects.toBeInstanceOf(DedicatedNotebookConnectionError);
    await expect(
      withDedicatedNotebookClient(provider, "bound-context", async () => "never"),
    ).rejects.toThrow("connection refused");
  });

  it("cancels the bound PostgreSQL backend when VS Code cancels before the client is ready", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ cancelled: true }] });
    const end = vi.fn().mockResolvedValue(undefined);
    const provider = {
      createDedicatedClient: vi.fn().mockResolvedValue({ query, end } as unknown as Client),
    };
    const target = { processID: 4242 } as unknown as Client;
    const cancellation = new NotebookClientCancellation();

    cancellation.request();
    cancellation.bind(provider, "bound-context", target);
    await cancellation.settle();

    expect(provider.createDedicatedClient).toHaveBeenCalledWith("bound-context");
    expect(query).toHaveBeenCalledWith("SELECT pg_cancel_backend($1) AS cancelled", [4242]);
    expect(end).toHaveBeenCalledOnce();
    expect(cancellation.isCancellationRequested).toBe(true);
    expect(() => cancellation.throwIfCancellationRequested()).toThrow(
      NotebookExecutionCancelledError,
    );
  });

  it("force-closes the target socket when PostgreSQL cannot cancel its backend", async () => {
    const destroy = vi.fn();
    const target = {
      processID: 4242,
      connection: { stream: { destroy } },
    } as unknown as Client;
    const control = {
      query: vi.fn().mockResolvedValue({ rows: [{ cancelled: false }] }),
      end: vi.fn().mockResolvedValue(undefined),
    } as unknown as Client;
    const provider = { createDedicatedClient: vi.fn().mockResolvedValue(control) };

    await cancelNotebookClient(provider, "bound-context", target);

    expect(destroy).toHaveBeenCalledOnce();
  });
});
