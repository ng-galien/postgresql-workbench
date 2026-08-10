import { describe, expect, it } from "vitest";
import type { DebugSessionInfo } from "./debugSessionRecovery.js";
import { enrichDebugSessions } from "./debugSessionRecovery.js";

describe("enrichDebugSessions", () => {
  it("replaces database inference with exact correlated adapter state", () => {
    const sessions: DebugSessionInfo[] = [
      {
        id: "a1b2c3d4",
        startedAt: new Date("2026-07-26T10:00:00.000Z"),
        state: "unknown",
        stateSource: "database",
        query: "CALL shop.try_order(2, 3, 1)",
        backends: [
          {
            pid: 101,
            role: "listener",
            applicationName: "plpgsql_dap_listener_a1b2c3d4",
            user: "postgres",
            state: "idle",
            ownedByCurrentUser: true,
          },
          {
            pid: 102,
            role: "target",
            applicationName: "plpgsql_dap_target_a1b2c3d4",
            user: "postgres",
            state: "active",
            ownedByCurrentUser: true,
          },
        ],
      },
    ];

    expect(
      enrichDebugSessions(sessions, [
        {
          sessionId: "a1b2c3d4",
          state: "suspended",
          timestamp: "2026-07-26T10:00:01.000Z",
          query: "CALL shop.try_order(2, 3, 1)",
          routine: {
            oid: 4242,
            schema: "shop",
            name: "try_order",
            kind: "procedure",
          },
          listenerPid: 101,
          targetPid: 102,
        },
      ]),
    ).toMatchObject([
      {
        state: "suspended",
        stateSource: "adapter",
        routine: {
          oid: 4242,
          schema: "shop",
          name: "try_order",
        },
      },
    ]);
  });
});
