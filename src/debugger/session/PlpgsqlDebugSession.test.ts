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
          id: 0,
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

    expect(calls).toEqual(["drop:4242", "set:4242"]);
    expect(internal.entryBreakpointReleased).toBe(true);
  });
});
