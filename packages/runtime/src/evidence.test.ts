import { describe, expect, it } from "vitest";
import { EvidenceStore } from "./evidence.js";

describe("retained evidence", () => {
  it("reserves result capacity before execution and protects it from concurrent observations", () => {
    const store = new EvidenceStore(1000);
    const release = store.reserve(950);
    expect(() => store.capture("session", "catalog", {})).toThrow("capacity");
    expect(() => store.reserve(100)).toThrow("capacity");
    release();
    release();
    expect(store.capture("session", "execution", {}).kind).toBe("execution");
  });
  it("isolates captured data from both caller mutation and later read mutation", () => {
    const store = new EvidenceStore();
    const data = { rows: [1] };
    const original = store.capture("session", "execution", data);
    data.rows.push(2);
    (original.data as typeof data).rows.push(3);
    expect(store.read(original.id).data).toEqual({ rows: [1] });
  });

  it("reports capacity and explicit forgetting instead of evicting evidence silently", () => {
    const store = new EvidenceStore(300);
    const original = store.capture("session", "execution", { value: "first" });
    expect(() => store.capture("session", "execution", { value: "x".repeat(200) })).toThrow(
      "capacity",
    );
    expect(store.read(original.id).data).toEqual({ value: "first" });
    store.forget(original.id);
    expect(() => store.read(original.id)).toThrow("forgotten");
  });
});
