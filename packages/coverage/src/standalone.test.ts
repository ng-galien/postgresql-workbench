import type { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoverageSuiteRunResult } from "./runner.js";

const disposeWorker = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../sql/src/localCodeMonikerSyntax.js", () => ({
  StatelessCodeMonikerSyntaxRuntime: class {
    dispose = disposeWorker;
    parser = vi.fn();
  },
}));

import { CoverageRunner } from "./runner.js";
import { StandaloneCoverage } from "./standalone.js";

afterEach(() => {
  vi.restoreAllMocks();
  disposeWorker.mockClear();
});

describe("standalone coverage lifecycle", () => {
  it("disposes during connection discovery and closes a client that arrives later", async () => {
    let connect!: (client: Client) => void;
    const connected = new Promise<Client>((resolve) => {
      connect = resolve;
    });
    const factory = vi.fn(() => connected);
    const coverage = new StandaloneCoverage(factory);
    const run = coverage.runSchema({ schema: "app" });
    const rejected = expect(run).rejects.toThrow();
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    await coverage.dispose();
    await rejected;
    const end = vi.fn(async () => {});
    connect({ end } as unknown as Client);
    await vi.waitFor(() => expect(end).toHaveBeenCalledOnce());
  });

  it("disconnects a blocked catalog query on cancellation", async () => {
    const query = vi.fn(() => new Promise(() => {}));
    const end = vi.fn(async () => {});
    const coverage = new StandaloneCoverage(async () => ({ query, end }) as unknown as Client);
    const run = coverage.runSchema({ schema: "app" });
    const rejected = expect(run).rejects.toThrow();
    await vi.waitFor(() => expect(query).toHaveBeenCalled());
    await coverage.dispose();
    await rejected;
    expect(end).toHaveBeenCalledOnce();
  });

  it("cancels active runs and waits for database cleanup before disposing the worker", async () => {
    let finish!: () => void;
    let signal: AbortSignal | undefined;
    const cleanup = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(CoverageRunner.prototype, "runSuite").mockImplementation(async (request) => {
      signal = request.signal;
      await cleanup;
      throw new Error("cancelled after cleanup");
    });
    const coverage = new StandaloneCoverage(vi.fn());
    const operation = coverage.runSuite({
      connectionId: "test",
      routineOids: [1],
      executeTests: vi.fn(),
    });
    const rejected = expect(operation).rejects.toThrow("cancelled after cleanup");
    const disposal = coverage.dispose();
    expect(coverage.dispose()).toBe(disposal);
    expect(signal?.aborted).toBe(true);
    expect(disposeWorker).not.toHaveBeenCalled();
    finish();
    await rejected;
    await disposal;
    expect(disposeWorker).toHaveBeenCalledTimes(1);
    await expect(
      coverage.runSuite({ connectionId: "test", routineOids: [1], executeTests: vi.fn() }),
    ).rejects.toThrow("disposed");
  });

  it("keeps the caller's cancellation signal and allows subsequent runs", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    vi.spyOn(CoverageRunner.prototype, "runSuite").mockImplementation(async (request) => {
      signals.push(request.signal);
      return {} as CoverageSuiteRunResult;
    });
    const coverage = new StandaloneCoverage(vi.fn());
    const controller = new AbortController();
    await coverage.runSuite({
      connectionId: "test",
      routineOids: [1],
      signal: controller.signal,
      executeTests: vi.fn(),
    });
    controller.abort();
    expect(signals[0]?.aborted).toBe(true);
    await coverage.runSuite({ connectionId: "test", routineOids: [1], executeTests: vi.fn() });
    expect(signals[1]?.aborted).toBe(false);
    await coverage.dispose();
  });
});
