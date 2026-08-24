import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({}));

import { DataViewDocument } from "./dataViewDocument.js";

describe("Data View result cancellation", () => {
  it("cancels an opening result before a page session exists", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const broadcastState = vi.fn();
    const document = Object.create(DataViewDocument.prototype) as {
      navigate(action: "cancel"): Promise<void>;
      loadGeneration: number;
      pendingLoadCancel: (() => Promise<void>) | undefined;
      session: undefined;
      busy: boolean;
      message: string | undefined;
      broadcastState(): void;
    };
    Object.assign(document, {
      loadGeneration: 1,
      pendingLoadCancel: cancel,
      session: undefined,
      busy: true,
      message: undefined,
      broadcastState,
    });

    await document.navigate("cancel");

    expect(cancel).toHaveBeenCalledOnce();
    expect(document.loadGeneration).toBe(2);
    expect(document.pendingLoadCancel).toBeUndefined();
    expect(document.busy).toBe(false);
    expect(document.message).toBe("Loading cancelled. Refresh to load the rows again.");
    expect(broadcastState).toHaveBeenCalledOnce();
  });
});
