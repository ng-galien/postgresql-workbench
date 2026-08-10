import { describe, expect, it } from "vitest";
import { debugApplicationName, parseDebugApplicationName } from "./debugApplicationName.js";

describe("debug application names", () => {
  it("round-trips listener and target session identities", () => {
    expect(parseDebugApplicationName(debugApplicationName("listener", "a1b2c3d4"))).toEqual({
      role: "listener",
      sessionId: "a1b2c3d4",
    });
    expect(parseDebugApplicationName(debugApplicationName("target", "a1b2c3d4"))).toEqual({
      role: "target",
      sessionId: "a1b2c3d4",
    });
  });

  it("round-trips a routine OID while preserving legacy names", () => {
    expect(parseDebugApplicationName(debugApplicationName("listener", "a1b2c3d4", 4242))).toEqual({
      role: "listener",
      sessionId: "a1b2c3d4",
      routineOid: 4242,
    });
    expect(parseDebugApplicationName("plpgsql_dap_target_legacy-session")).toEqual({
      role: "target",
      sessionId: "legacy-session",
    });
  });

  it("rejects empty suffixes and similar non-DAP names", () => {
    expect(parseDebugApplicationName("plpgsql_dap_listener_")).toBeUndefined();
    expect(parseDebugApplicationName("plpgsql_dap_listenerish_a1b2c3d4")).toBeUndefined();
    expect(parseDebugApplicationName("ordinary_postgres_client")).toBeUndefined();
  });
});
