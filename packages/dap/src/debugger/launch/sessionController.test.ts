import { describe, expect, it, vi } from "vitest";
import { DebugSessionController } from "./sessionController.js";

const descriptor = {
  name: "Debug shop.try_order",
  sql: "CALL shop.try_order(2, 3, 1)",
};

describe("DebugSessionController", () => {
  it("atomically blocks a second launch until the bound session terminates", () => {
    const changed = vi.fn();
    const controller = new DebugSessionController(changed);

    const first = controller.reserve(descriptor);
    expect(first).toBeTruthy();
    expect(controller.reserve(descriptor)).toBeUndefined();

    expect(controller.admit(descriptor, first)).toBe(first);
    expect(controller.observeStart("vscode-1", first)).toBe(true);
    expect(
      controller.applyStatus("vscode-1", {
        sessionId: "adapter-1",
        state: "waitingForTarget",
        timestamp: "2026-07-26T10:00:00.000Z",
        query: descriptor.sql,
        routine: {
          oid: 42,
          schema: "shop",
          name: "try_order",
          kind: "procedure",
        },
        listenerPid: 101,
        targetPid: 102,
      }),
    ).toBe(true);
    expect(controller.active).toMatchObject({
      state: "waitingForTarget",
      vscodeSessionId: "vscode-1",
      adapterSessionId: "adapter-1",
    });
    expect(controller.reserve(descriptor)).toBeUndefined();

    expect(controller.observeTermination("vscode-1")).toBe(true);
    expect(controller.reserve(descriptor)).toBeTruthy();
    expect(changed).toHaveBeenCalled();
  });

  it("ignores stale status and termination events from another VS Code session", () => {
    const controller = new DebugSessionController();
    const token = controller.reserve(descriptor);
    controller.observeStart("vscode-current", token);

    expect(
      controller.applyStatus("vscode-stale", {
        sessionId: "adapter-stale",
        state: "suspended",
        timestamp: "2026-07-26T10:00:00.000Z",
      }),
    ).toBe(false);
    expect(controller.observeTermination("vscode-stale")).toBe(false);
    expect(controller.active?.vscodeSessionId).toBe("vscode-current");
  });

  it("releases only an unbound failed reservation", () => {
    const controller = new DebugSessionController();
    const token = controller.reserve(descriptor)!;
    controller.cancelReservation(token);
    expect(controller.active).toBeUndefined();

    const bound = controller.reserve(descriptor)!;
    controller.observeStart("vscode-1", bound);
    controller.cancelReservation(bound);
    expect(controller.active?.vscodeSessionId).toBe("vscode-1");
  });

  it("admits an external launch once and rejects concurrent configurations", () => {
    const controller = new DebugSessionController();

    const externalToken = controller.admit(descriptor);
    expect(externalToken).toBeTruthy();
    expect(controller.admit({ ...descriptor, sql: "SELECT test_simple(2, 'second')" })).toBe(
      undefined,
    );
    expect(controller.observeStart("vscode-external", externalToken)).toBe(true);
    expect(controller.observeStart("vscode-bypass")).toBe(false);
  });

  it("does not let a different token claim an admitted launch", () => {
    const controller = new DebugSessionController();
    const token = controller.admit(descriptor)!;

    expect(controller.admit(descriptor, "launch-stale")).toBeUndefined();
    expect(controller.observeStart("vscode-stale", "launch-stale")).toBe(false);
    expect(controller.observeStart("vscode-current", token)).toBe(true);
  });

  it("admits the next launch once failed cleanup has reached a terminal state", () => {
    const controller = new DebugSessionController();
    const token = controller.admit(descriptor)!;
    controller.observeStart("vscode-failed", token);
    controller.applyStatus("vscode-failed", {
      sessionId: "adapter-failed",
      state: "failed",
      timestamp: "2026-07-26T10:00:00.000Z",
    });

    expect(controller.admit({ ...descriptor, name: "Retry" })).toBeTruthy();
    expect(controller.active?.name).toBe("Retry");
  });
});
