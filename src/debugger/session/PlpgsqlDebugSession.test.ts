import type { DebugProtocol } from "@vscode/debugprotocol";
import { describe, expect, it, vi } from "vitest";
import { PlpgsqlDebugSession } from "./PlpgsqlDebugSession.js";

describe("PlpgsqlDebugSession stack frames", () => {
  it("keeps a raw frame when PostgreSQL source metadata is unavailable", async () => {
    const session = new PlpgsqlDebugSession(async () => {
      throw new Error("The syntax parser must not be used for a raw stack frame");
    });
    const internal = session as unknown as {
      frameAnalyses: Map<number, unknown>;
      getSource(oid: number): Promise<null>;
      listenerExecutor: {
        getStack(): Promise<Array<{ level: number; oid: number; line: number }>>;
      };
      sendResponse(response: DebugProtocol.StackTraceResponse): void;
      stackTraceRequest(
        response: DebugProtocol.StackTraceResponse,
        args: DebugProtocol.StackTraceArguments,
      ): Promise<void>;
    };
    internal.listenerExecutor = {
      async getStack() {
        return [{ level: 0, oid: 4242, line: 7 }];
      },
    };
    internal.getSource = async () => null;
    internal.sendResponse = vi.fn();
    const response = {
      command: "stackTrace",
      request_seq: 1,
      seq: 1,
      success: true,
      type: "response",
    } as DebugProtocol.StackTraceResponse;

    await internal.stackTraceRequest(response, { threadId: 1 });

    expect(response.body).toEqual({
      stackFrames: [
        expect.objectContaining({
          id: 1,
          line: 7,
          name: "<oid:4242>",
          source: undefined,
        }),
      ],
      totalFrames: 1,
    });
  });

  it("serializes stack projection with other PostgreSQL inspections", async () => {
    const session = new PlpgsqlDebugSession(async () => {
      throw new Error("The syntax parser must not be used for an empty stack");
    });
    const order: string[] = [];
    let releaseStack = () => {};
    const stackBlocked = new Promise<void>((resolve) => {
      releaseStack = resolve;
    });
    const internal = session as unknown as {
      listenerExecutor: {
        getStack(): Promise<Array<{ level: number; oid: number; line: number }>>;
      };
      runInspection<T>(operation: () => Promise<T>): Promise<T>;
      sendResponse(response: DebugProtocol.StackTraceResponse): void;
      stackTraceRequest(
        response: DebugProtocol.StackTraceResponse,
        args: DebugProtocol.StackTraceArguments,
      ): Promise<void>;
    };
    internal.listenerExecutor = {
      async getStack() {
        order.push("stack:start");
        await stackBlocked;
        order.push("stack:end");
        return [];
      },
    };
    internal.sendResponse = vi.fn();
    const response = {
      command: "stackTrace",
      request_seq: 1,
      seq: 1,
      success: true,
      type: "response",
    } as DebugProtocol.StackTraceResponse;

    const stack = internal.stackTraceRequest(response, { threadId: 1 });
    await Promise.resolve();
    const variables = internal.runInspection(async () => {
      order.push("variables");
    });
    await Promise.resolve();
    expect(order).toEqual(["stack:start"]);

    releaseStack();
    await Promise.all([stack, variables]);
    expect(order).toEqual(["stack:start", "stack:end", "variables"]);
  });

  it("releases the technical entry breakpoint before restoring an explicit function breakpoint", async () => {
    const session = new PlpgsqlDebugSession(async () => {
      throw new Error("The syntax parser must not be used to release an entry breakpoint");
    });
    const calls: string[] = [];
    const internal = session as unknown as {
      entryBreakpointReleased: boolean;
      entryFunctionBreakpointRequested: boolean;
      entryOid: number;
      listenerExecutor: {
        dropGlobalBreakpoint(oid: number): Promise<boolean>;
        setBreakpoint(oid: number, line: number): Promise<boolean>;
      };
      releaseEntryBreakpoint(): Promise<void>;
    };
    internal.entryOid = 4242;
    internal.entryFunctionBreakpointRequested = true;
    internal.listenerExecutor = {
      async dropGlobalBreakpoint(oid) {
        calls.push(`drop:${oid}`);
        return true;
      },
      async setBreakpoint(oid, line) {
        calls.push(`set:${oid}:${line}`);
        return true;
      },
    };

    await internal.releaseEntryBreakpoint();
    await internal.releaseEntryBreakpoint();

    expect(calls).toEqual(["drop:4242", "set:4242:-1"]);
    expect(internal.entryBreakpointReleased).toBe(true);
  });

  it("continues past repeated copies of the exact technical entry stop", async () => {
    const session = new PlpgsqlDebugSession(async () => {
      throw new Error("The syntax parser must not be used while stepping");
    });
    const steps = [
      { oid: 4242, line: 6, md5: "" },
      { oid: 4242, line: 6, md5: "" },
      { oid: 4242, line: 10, md5: "" },
    ];
    const stackStops = [
      { oid: 4242, line: 4 },
      { oid: 4242, line: 4 },
      { oid: 4242, line: 8 },
    ];
    const stopped: Array<{ reason: string; line?: number }> = [];
    const internal = session as unknown as {
      activeBreakpoints: Map<number, Map<number, unknown>>;
      entryBreakpointReleased: boolean;
      entryFunctionBreakpointRequested: boolean;
      entryStopPosition: { oid: number; line: number };
      listenerExecutor: {
        stepContinue(): Promise<{ oid: number; line: number; md5: string } | null>;
      };
      continueToVisibleStop(): Promise<void>;
      currentStopPosition(): Promise<{ oid: number; line: number } | undefined>;
      sendStoppedAndReset(reason: string, source?: { line?: number }): void;
      sourceForPosition(oid: number, line: number): Promise<{ line: number }>;
    };
    internal.entryBreakpointReleased = true;
    internal.entryFunctionBreakpointRequested = false;
    internal.entryStopPosition = { oid: 4242, line: 4 };
    internal.activeBreakpoints.set(4242, new Map([[8, {}]]));
    internal.listenerExecutor = {
      async stepContinue() {
        return steps.shift() ?? null;
      },
    };
    internal.currentStopPosition = async () => stackStops.shift();
    internal.sourceForPosition = async (_oid, line) => ({ line });
    internal.sendStoppedAndReset = (reason, source) => {
      stopped.push({ reason, line: source?.line });
    };

    await internal.continueToVisibleStop();

    expect(steps).toEqual([]);
    expect(stopped).toEqual([{ reason: "breakpoint", line: 8 }]);
  });

  it("surfaces the first suspension from a user step command", async () => {
    const session = new PlpgsqlDebugSession(async () => {
      throw new Error("The syntax parser must not be used while stepping");
    });
    const steps = [
      { oid: 4242, line: 6, md5: "" },
      { oid: 4242, line: 10, md5: "" },
    ];
    const stopped: Array<{ reason: string; line?: number }> = [];
    const internal = session as unknown as {
      listenerExecutor: {
        stepContinue(): Promise<{ oid: number; line: number; md5: string } | null>;
      };
      safeStep(
        step: () => Promise<{ oid: number; line: number; md5: string } | null>,
        reason: string,
        stopPolicy: "first-suspension" | "skip-technical-entry",
      ): Promise<void>;
      currentStopPosition(): Promise<{ oid: number; line: number } | undefined>;
      sendStoppedAndReset(reason: string, source?: { line?: number }): void;
      sourceForPosition(oid: number, line: number): Promise<{ line: number }>;
    };
    internal.listenerExecutor = {
      async stepContinue() {
        return steps.shift() ?? null;
      },
    };
    internal.currentStopPosition = async () => ({ oid: 4242, line: 4 });
    internal.sourceForPosition = async (_oid, line) => ({ line });
    internal.sendStoppedAndReset = (reason, source) => {
      stopped.push({ reason, line: source?.line });
    };

    await internal.safeStep(
      () => internal.listenerExecutor.stepContinue(),
      "step",
      "first-suspension",
    );

    expect(steps).toHaveLength(1);
    expect(stopped).toEqual([{ reason: "step", line: 4 }]);
  });

  it.each([
    ["logpoint", { logMessage: "n={n}" }],
    ["false condition", { condition: "n > 10" }],
  ])("does not auto-continue a user step that lands on a %s", async (_label, breakpoint) => {
    const session = new PlpgsqlDebugSession(async () => {
      throw new Error("The syntax parser must not be used while stepping");
    });
    const steps = [
      { oid: 4242, line: 4, md5: "" },
      { oid: 4242, line: 8, md5: "" },
    ];
    const stopped: Array<{ reason: string; line?: number }> = [];
    const getVariables = vi.fn(async () => []);
    const internal = session as unknown as {
      activeBreakpoints: Map<number, Map<number, unknown>>;
      emitLogpoint(template: string, variables: never[]): void;
      evaluateCondition(condition: string, variables: never[]): Promise<boolean>;
      listenerExecutor: {
        getVariables(): Promise<never[]>;
        stepContinue(): Promise<{ oid: number; line: number; md5: string } | null>;
      };
      safeStep(
        step: () => Promise<{ oid: number; line: number; md5: string } | null>,
        reason: string,
        stopPolicy: "first-suspension" | "skip-technical-entry",
      ): Promise<void>;
      currentStopPosition(): Promise<{ oid: number; line: number } | undefined>;
      sendStoppedAndReset(reason: string, source?: { line?: number }): void;
      sourceForPosition(oid: number, line: number): Promise<{ line: number }>;
    };
    internal.activeBreakpoints.set(4242, new Map([[4, breakpoint]]));
    internal.listenerExecutor = {
      getVariables,
      async stepContinue() {
        return steps.shift() ?? null;
      },
    };
    internal.currentStopPosition = async () => ({ oid: 4242, line: 4 });
    internal.sourceForPosition = async (_oid, line) => ({ line });
    internal.emitLogpoint = vi.fn();
    internal.evaluateCondition = vi.fn(async () => false);
    internal.sendStoppedAndReset = (reason, source) => {
      stopped.push({ reason, line: source?.line });
    };

    await internal.safeStep(
      () => internal.listenerExecutor.stepContinue(),
      "step",
      "first-suspension",
    );

    expect(steps).toHaveLength(1);
    expect(stopped).toEqual([{ reason: "step", line: 4 }]);
    if ("condition" in breakpoint) {
      expect(getVariables).not.toHaveBeenCalled();
      expect(internal.evaluateCondition).not.toHaveBeenCalled();
    }
  });

  it("emits a logpoint before prioritizing an enabled exception", async () => {
    const session = new PlpgsqlDebugSession(async () => {
      throw new Error("The syntax parser must not be used while continuing");
    });
    const steps = [
      { oid: 4242, line: 4, md5: "" },
      { oid: 4242, line: 8, md5: "" },
    ];
    const stopped: string[] = [];
    const getVariables = vi.fn(async () => []);
    const internal = session as unknown as {
      activeBreakpoints: Map<number, Map<number, unknown>>;
      emitLogpoint(template: string, variables: never[]): void;
      exceptionFilters: Set<string>;
      getSource(oid: number): Promise<{
        analysis: { exceptionHandlers: Array<{ conditions: string[]; startLine: number }> };
      }>;
      listenerExecutor: {
        getVariables(): Promise<never[]>;
        stepContinue(): Promise<{ oid: number; line: number; md5: string } | null>;
      };
      safeStep(
        step: () => Promise<{ oid: number; line: number; md5: string } | null>,
        reason: string,
        stopPolicy: "first-suspension" | "skip-technical-entry",
      ): Promise<void>;
      currentStopPosition(): Promise<{ oid: number; line: number } | undefined>;
      sendEvent(event: unknown): void;
      sendStoppedAndReset(reason: string): void;
      sourceForPosition(oid: number, line: number): Promise<{ line: number }>;
    };
    internal.activeBreakpoints.set(4242, new Map([[4, { logMessage: "ignored" }]]));
    internal.exceptionFilters = new Set(["all"]);
    internal.listenerExecutor = {
      getVariables,
      async stepContinue() {
        return steps.shift() ?? null;
      },
    };
    internal.currentStopPosition = async () => ({ oid: 4242, line: 4 });
    internal.sourceForPosition = async (_oid, line) => ({ line });
    internal.getSource = async () => ({
      analysis: { exceptionHandlers: [{ conditions: ["others"], startLine: 4 }] },
    });
    internal.emitLogpoint = vi.fn();
    internal.sendEvent = vi.fn();
    internal.sendStoppedAndReset = (reason) => {
      stopped.push(reason);
    };

    await internal.safeStep(
      () => internal.listenerExecutor.stepContinue(),
      "breakpoint",
      "skip-technical-entry",
    );

    expect(steps).toHaveLength(1);
    expect(getVariables).toHaveBeenCalledOnce();
    expect(internal.emitLogpoint).toHaveBeenCalledWith("ignored", []);
    expect(stopped).toEqual(["exception"]);
  });

  it("does not hide the exact entry position when a function breakpoint requested it", async () => {
    const session = new PlpgsqlDebugSession(async () => {
      throw new Error("The syntax parser must not be used while continuing");
    });
    const steps = [
      { oid: 4242, line: 6, md5: "" },
      { oid: 4242, line: 10, md5: "" },
    ];
    const stopped: Array<{ reason: string; line?: number }> = [];
    const internal = session as unknown as {
      entryBreakpointReleased: boolean;
      entryFunctionBreakpointRequested: boolean;
      entryStopPosition: { oid: number; line: number };
      listenerExecutor: {
        stepContinue(): Promise<{ oid: number; line: number; md5: string } | null>;
      };
      safeStep(
        step: () => Promise<{ oid: number; line: number; md5: string } | null>,
        reason: string,
        stopPolicy: "first-suspension" | "skip-technical-entry",
      ): Promise<void>;
      currentStopPosition(): Promise<{ oid: number; line: number } | undefined>;
      sendStoppedAndReset(reason: string, source?: { line?: number }): void;
      sourceForPosition(oid: number, line: number): Promise<{ line: number }>;
    };
    internal.entryBreakpointReleased = true;
    internal.entryFunctionBreakpointRequested = true;
    internal.entryStopPosition = { oid: 4242, line: 4 };
    internal.listenerExecutor = {
      async stepContinue() {
        return steps.shift() ?? null;
      },
    };
    internal.currentStopPosition = async () => ({ oid: 4242, line: 4 });
    internal.sourceForPosition = async (_oid, line) => ({ line });
    internal.sendStoppedAndReset = (reason, source) => {
      stopped.push({ reason, line: source?.line });
    };

    await internal.safeStep(
      () => internal.listenerExecutor.stepContinue(),
      "breakpoint",
      "skip-technical-entry",
    );

    expect(steps).toHaveLength(1);
    expect(stopped).toEqual([{ reason: "breakpoint", line: 4 }]);
  });

  it("surfaces an unexpected unregistered stop during Continue", async () => {
    const session = new PlpgsqlDebugSession(async () => {
      throw new Error("The syntax parser must not be used while continuing");
    });
    const steps = [
      { oid: 4242, line: 8, md5: "" },
      { oid: 4242, line: 10, md5: "" },
    ];
    const stopped: Array<{ reason: string; line?: number }> = [];
    const internal = session as unknown as {
      activeBreakpoints: Map<number, Map<number, unknown>>;
      entryBreakpointReleased: boolean;
      entryFunctionBreakpointRequested: boolean;
      entryStopPosition: { oid: number; line: number };
      listenerExecutor: {
        stepContinue(): Promise<{ oid: number; line: number; md5: string } | null>;
      };
      safeStep(
        step: () => Promise<{ oid: number; line: number; md5: string } | null>,
        reason: string,
        stopPolicy: "first-suspension" | "skip-technical-entry",
      ): Promise<void>;
      currentStopPosition(): Promise<{ oid: number; line: number } | undefined>;
      sendStoppedAndReset(reason: string, source?: { line?: number }): void;
      sourceForPosition(oid: number, line: number): Promise<{ line: number }>;
    };
    internal.entryBreakpointReleased = true;
    internal.entryFunctionBreakpointRequested = false;
    internal.entryStopPosition = { oid: 4242, line: 4 };
    internal.activeBreakpoints.set(4242, new Map([[8, {}]]));
    internal.listenerExecutor = {
      async stepContinue() {
        return steps.shift() ?? null;
      },
    };
    internal.currentStopPosition = async () => ({ oid: 4242, line: 6 });
    internal.sourceForPosition = async (_oid, line) => ({ line });
    internal.sendStoppedAndReset = (reason, source) => {
      stopped.push({ reason, line: source?.line });
    };

    await internal.safeStep(
      () => internal.listenerExecutor.stepContinue(),
      "breakpoint",
      "skip-technical-entry",
    );

    expect(steps).toHaveLength(1);
    expect(stopped).toEqual([{ reason: "breakpoint", line: 6 }]);
  });

  it("uses the current PostgreSQL frame for absent or zero DAP frame IDs", () => {
    const session = new PlpgsqlDebugSession(async () => {
      throw new Error("The syntax parser must not be used to resolve a DAP frame");
    });
    const internal = session as unknown as {
      frameLevelById: Map<number, number>;
      postgresFrameLevelForEvaluation(frameId: number | undefined): number | undefined;
      selectedPostgresFrameLevel: number | undefined;
    };
    internal.selectedPostgresFrameLevel = 3;
    internal.frameLevelById.set(17, 2);

    expect(internal.postgresFrameLevelForEvaluation(undefined)).toBe(3);
    expect(internal.postgresFrameLevelForEvaluation(0)).toBe(3);
    expect(internal.postgresFrameLevelForEvaluation(17)).toBe(2);
    expect(internal.postgresFrameLevelForEvaluation(99)).toBeUndefined();
  });

  it("does not reuse DAP variable handles across suspended states", () => {
    const session = new PlpgsqlDebugSession(async () => {
      throw new Error("The syntax parser must not be used to allocate DAP variable handles");
    });
    const internal = session as unknown as {
      frameLevelById: Map<number, number>;
      scopesRequest(
        response: DebugProtocol.ScopesResponse,
        args: DebugProtocol.ScopesArguments,
      ): void;
      sendEvent(event: unknown): void;
      sendResponse(response: DebugProtocol.ScopesResponse): void;
      sendStoppedAndReset(reason: string): void;
    };
    internal.sendEvent = vi.fn();
    internal.sendResponse = vi.fn();

    internal.frameLevelById.set(1, 0);
    const first = scopesResponse();
    internal.scopesRequest(first, { frameId: 1 });
    internal.sendStoppedAndReset("breakpoint");
    internal.frameLevelById.set(2, 0);
    const second = scopesResponse();
    internal.scopesRequest(second, { frameId: 2 });

    const firstReferences = first.body!.scopes.map((scope) => scope.variablesReference);
    const secondReferences = second.body!.scopes.map((scope) => scope.variablesReference);
    expect(secondReferences).not.toEqual(firstReferences);
    expect(Math.min(...secondReferences)).toBeGreaterThan(Math.max(...firstReferences));
  });

  it("does not reselect the PostgreSQL frame that already has debugger focus", async () => {
    const session = new PlpgsqlDebugSession(async () => {
      throw new Error("The syntax parser must not be used to select a stack frame");
    });
    const selectFrame = vi.fn(async (_frame: number) => {});
    const internal = session as unknown as {
      listenerExecutor: { selectFrame(frame: number): Promise<void> };
      selectedPostgresFrameLevel: number | undefined;
      selectPostgresFrame(frame: number): Promise<void>;
    };
    internal.listenerExecutor = { selectFrame };
    internal.selectedPostgresFrameLevel = 0;

    await internal.selectPostgresFrame(0);
    await internal.selectPostgresFrame(2);
    await internal.selectPostgresFrame(2);
    await internal.selectPostgresFrame(0);

    expect(selectFrame.mock.calls).toEqual([[2], [0]]);
  });

  it("reads variables once per PostgreSQL frame and suspended state", async () => {
    const session = new PlpgsqlDebugSession(async () => {
      throw new Error("The syntax parser must not be used to inspect variables");
    });
    const variables = [
      {
        isArg: true,
        line: 1,
        value: {
          arrayType: "text",
          isArray: false,
          isText: false,
          kind: "b",
          name: "n",
          oid: 23,
          pretty: "3",
          type: "integer",
          value: "3",
        },
        varNo: 0,
      },
    ];
    const getVariables = vi.fn(async () => variables);
    const internal = session as unknown as {
      frameVariables(frame: number): Promise<typeof variables>;
      listenerExecutor: {
        getVariables(): Promise<typeof variables>;
        selectFrame(frame: number): Promise<void>;
      };
      selectedPostgresFrameLevel: number | undefined;
    };
    internal.listenerExecutor = { getVariables, selectFrame: vi.fn() };
    internal.selectedPostgresFrameLevel = 0;

    expect(await internal.frameVariables(0)).toBe(variables);
    expect(await internal.frameVariables(0)).toBe(variables);

    expect(getVariables).toHaveBeenCalledTimes(1);
  });
});

function scopesResponse(): DebugProtocol.ScopesResponse {
  return {
    body: { scopes: [] },
    command: "scopes",
    request_seq: 1,
    seq: 1,
    success: true,
    type: "response",
  };
}
