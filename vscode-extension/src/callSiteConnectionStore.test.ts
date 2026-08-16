import { describe, expect, it } from "vitest";
import {
  type CallSiteConnectionReference,
  type CallSiteConnectionState,
  CallSiteConnectionStore,
} from "./callSiteConnectionStore.js";

class MemoryState implements CallSiteConnectionState {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue: T): T {
    return (this.values.get(key) as T | undefined) ?? defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

function call(line: number, routine = "restock_report"): CallSiteConnectionReference {
  return {
    documentUri: "file:///workspace/demo.sql",
    line,
    kind: "select",
    schema: "shop",
    routine,
  };
}

describe("CallSiteConnectionStore", () => {
  it("uses one Document Association for every callsite in a SQL file", async () => {
    const store = new CallSiteConnectionStore(new MemoryState());
    await store.assign(call(24), "demo");
    await store.assign(call(27, "try_order"), "staging");

    expect(store.get(call(24))).toBe("staging");
    expect(store.get(call(27, "try_order"))).toBe("staging");
    expect(store.getDocument("file:///workspace/demo.sql")).toBe("staging");
  });

  it("clears the Document Association for every callsite in that file", async () => {
    const store = new CallSiteConnectionStore(new MemoryState());
    await store.assign(call(24), "demo");
    await store.assign(call(25), "other");

    await store.clear(call(24));

    expect(store.get(call(24))).toBeUndefined();
    expect(store.get(call(25))).toBeUndefined();
  });
});
