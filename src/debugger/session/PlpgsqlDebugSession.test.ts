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
        setGlobalBreakpoint(oid: number): Promise<void>;
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
      async setGlobalBreakpoint(oid) {
        calls.push(`set:${oid}`);
      },
    };

    await internal.releaseEntryBreakpoint();
    await internal.releaseEntryBreakpoint();

    expect(calls).toEqual(["drop:4242", "set:4242"]);
    expect(internal.entryBreakpointReleased).toBe(true);
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
