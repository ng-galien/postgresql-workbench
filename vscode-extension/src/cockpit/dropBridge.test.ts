import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeState = vi.hoisted(() => ({
  close: vi.fn(),
  groups: [] as Array<{ tabs: unknown[] }>,
}));

vi.mock("vscode", () => ({
  TabInputText: class {
    constructor(readonly uri: { toString(): string }) {}
  },
  window: {
    tabGroups: {
      get all() {
        return vscodeState.groups;
      },
      close: vscodeState.close,
    },
  },
}));

import { completeGraphDrop } from "./dropBridge.js";

describe("Workbench graph drop bridge", () => {
  beforeEach(() => {
    vscodeState.close.mockReset().mockResolvedValue(true);
    vscodeState.groups = [];
  });

  it("closes the synthetic resource before revealing the graph", async () => {
    const uri = resourceUri();
    const tab = { input: new (await import("vscode")).TabInputText(uri as never) };
    vscodeState.groups = [{ tabs: [tab] }];
    const acceptTreeDrop = vi.fn().mockResolvedValue(true);
    const reveal = vi.fn();

    await completeGraphDrop(uri as never, acceptedPayload(), { acceptTreeDrop, reveal });

    expect(vscodeState.close).toHaveBeenCalledWith(tab);
    expect(reveal).toHaveBeenCalledOnce();
    expect(vscodeState.close.mock.invocationCallOrder[0]).toBeLessThan(
      acceptTreeDrop.mock.invocationCallOrder[0],
    );
    expect(acceptTreeDrop.mock.invocationCallOrder[0]).toBeLessThan(
      reveal.mock.invocationCallOrder[0],
    );
  });

  it("closes the synthetic resource without revealing an unavailable graph", async () => {
    const uri = resourceUri();
    const tab = { input: new (await import("vscode")).TabInputText(uri as never) };
    vscodeState.groups = [{ tabs: [tab] }];
    const reveal = vi.fn();

    await completeGraphDrop(uri as never, acceptedPayload(), {
      acceptTreeDrop: vi.fn().mockResolvedValue(false),
      reveal,
    });

    expect(vscodeState.close).toHaveBeenCalledWith(tab);
    expect(reveal).not.toHaveBeenCalled();
  });

  it("still closes the synthetic resource when focusing the graph fails", async () => {
    const uri = resourceUri();
    const tab = { input: new (await import("vscode")).TabInputText(uri as never) };
    vscodeState.groups = [{ tabs: [tab] }];
    const failure = new Error("focus failed");
    const reveal = vi.fn();

    await expect(
      completeGraphDrop(uri as never, acceptedPayload(), {
        acceptTreeDrop: vi.fn().mockRejectedValue(failure),
        reveal,
      }),
    ).rejects.toBe(failure);

    expect(vscodeState.close).toHaveBeenCalledWith(tab);
    expect(reveal).not.toHaveBeenCalled();
  });
});

function resourceUri() {
  return { toString: () => "postgresql-workbench-graph-drop:/source/test/payload" };
}

function acceptedPayload() {
  return {
    version: 1 as const,
    availability: "accepted" as const,
    connectionId: "connection",
    database: "demo",
    sourceUri: "postgresql://connection/demo/shop/table/orders.sql",
    symbolUri: "code+moniker://orders",
    kind: "table" as const,
    label: "shop.orders",
  };
}
