import { afterEach, describe, expect, it, vi } from "vitest";
import { DEBUG_ACTION_INTERVAL_MS, runPacedDebugAction } from "./debugTestTiming.js";

describe("debug test action pacing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps queued actions on one debugger at least 500 ms apart", async () => {
    vi.useFakeTimers();
    const debuggerSession = {};
    const actionTimes: number[] = [];

    const actions = [1, 2, 3].map(() =>
      runPacedDebugAction(debuggerSession, async () => {
        actionTimes.push(Date.now());
      }),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(actionTimes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(DEBUG_ACTION_INTERVAL_MS - 1);
    expect(actionTimes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(actionTimes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(DEBUG_ACTION_INTERVAL_MS);
    await Promise.all(actions);

    expect(actionTimes[1] - actionTimes[0]).toBe(DEBUG_ACTION_INTERVAL_MS);
    expect(actionTimes[2] - actionTimes[1]).toBe(DEBUG_ACTION_INTERVAL_MS);
  });

  it("does not couple independent debugger sessions", async () => {
    vi.useFakeTimers();
    const actionTimes: number[] = [];

    await Promise.all([
      runPacedDebugAction({}, async () => actionTimes.push(Date.now())),
      runPacedDebugAction({}, async () => actionTimes.push(Date.now())),
    ]);

    expect(actionTimes).toEqual([Date.now(), Date.now()]);
  });
});
