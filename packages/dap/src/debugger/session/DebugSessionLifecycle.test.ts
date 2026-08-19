import { describe, expect, it } from "vitest";
import { DebugSessionLifecycle } from "./DebugSessionLifecycle.js";

describe("DebugSessionLifecycle", () => {
  it("serializes execution commands around suspended states", () => {
    const lifecycle = new DebugSessionLifecycle();
    lifecycle.transition("preparing");
    lifecycle.transition("waitingForTarget");
    lifecycle.transition("suspended");

    expect(lifecycle.beginExecution()).toBe(true);
    expect(lifecycle.beginExecution()).toBe(false);

    lifecycle.transition("suspended");
    expect(lifecycle.beginExecution()).toBe(true);
  });

  it("makes termination idempotent", () => {
    const lifecycle = new DebugSessionLifecycle();
    lifecycle.transition("preparing");

    expect(lifecycle.beginTermination()).toBe(true);
    expect(lifecycle.beginTermination()).toBe(false);
    lifecycle.finishTermination(false);
    expect(lifecycle.state).toBe("terminated");
    expect(lifecycle.beginTermination()).toBe(false);
  });

  it("rejects invalid protocol transitions", () => {
    const lifecycle = new DebugSessionLifecycle();
    expect(() => lifecycle.transition("suspended")).toThrow(
      "Invalid debug lifecycle transition: idle -> suspended",
    );
  });
});
