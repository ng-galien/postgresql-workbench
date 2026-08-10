import type { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  DedicatedNotebookConnectionError,
  withDedicatedNotebookClient,
} from "./sqlNotebookConnection.js";

describe("dedicated SQL notebook connections", () => {
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
});
