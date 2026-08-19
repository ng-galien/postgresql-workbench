/**
 * Focused integration tests for the human debug lifecycle.
 *
 * Keep this file independently runnable: these scenarios exercise timing and
 * protocol ordering that good-path feature tests do not expose reliably.
 */
import * as path from "node:path";
import { DebugClient } from "@vscode/debugadapter-testsupport";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LaunchRequestArguments } from "../packages/dap/src/debugger/index.js";
import {
  DEBUG_RESULT_EVENT,
  DEBUG_SESSION_STATUS_EVENT,
  type DebugSessionStatus,
} from "../packages/dap/src/debugger/launch/index.js";
import { type CodeMonikerTestRuntime, startCodeMonikerTestRuntime } from "./codeMonikerRuntime.js";
import {
  DEBUG_DAP_EVENT_TIMEOUT_MS,
  DEBUG_INTEGRATION_TEST_TIMEOUT_MS,
  runPacedDebugAction,
} from "./debugTestTiming.js";

const DAP_SERVER = path.resolve(__dirname, "../dist/dap/src/main.js");
const LAUNCH_ARGS = {
  host: "localhost",
  port: 5433,
  database: "testdb",
  user: "postgres",
  password: "postgres",
};
let canonicalSourceUris: Record<string, string> = {};

function launchConfig(
  sql: string,
  extra: Partial<LaunchRequestArguments> = {},
): LaunchRequestArguments {
  return { ...LAUNCH_ARGS, sourceUris: canonicalSourceUris, sql, ...extra };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopDebugClient(client: DebugClient, timeout = 3_000): Promise<void> {
  const forceStop = () => {
    (client as unknown as { stopAdapter(): void }).stopAdapter();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.stop(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          forceStop();
          resolve();
        }, timeout);
      }),
    ]);
  } catch {
    forceStop();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function launchAndWaitForEntry(dc: DebugClient, sql: string) {
  const stopped = dc.waitForEvent("stopped", DEBUG_DAP_EVENT_TIMEOUT_MS);
  await Promise.all([
    dc.launch(launchConfig(sql, { stopOnEntry: true })),
    dc.configurationSequence(),
  ]);
  return stopped;
}

async function routineOid(signature: string): Promise<number> {
  const client = new Client(LAUNCH_ARGS);
  await client.connect();
  try {
    const result = await client.query("SELECT $1::regprocedure::oid AS oid", [signature]);
    return Number(result.rows[0]?.oid ?? 0);
  } finally {
    await client.end();
  }
}

async function activeDebuggerBackends(): Promise<number> {
  const client = new Client(LAUNCH_ARGS);
  await client.connect();
  try {
    const result = await client.query(`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE application_name LIKE 'plpgsql_dap_listener_%'
         OR application_name LIKE 'plpgsql_dap_target_%'`);
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.end();
  }
}

async function waitForDebuggerBackendsToClose(): Promise<number> {
  const deadline = Date.now() + 3_000;
  let count = await activeDebuggerBackends();
  while (count > 0 && Date.now() < deadline) {
    await delay(50);
    count = await activeDebuggerBackends();
  }
  return count;
}

describe("DAP human debug lifecycle", { timeout: DEBUG_INTEGRATION_TEST_TIMEOUT_MS }, () => {
  let dc: DebugClient;
  let outputs: string[];
  let terminatedCount: number;
  let codeMoniker: CodeMonikerTestRuntime | undefined;

  beforeAll(async () => {
    codeMoniker = await startCodeMonikerTestRuntime();
    canonicalSourceUris = await codeMoniker.sourceUris(LAUNCH_ARGS);
  }, DEBUG_INTEGRATION_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await codeMoniker?.dispose();
  });

  beforeEach(async () => {
    if (!codeMoniker) throw new Error("Code Moniker test runtime did not start");
    dc = new DebugClient("node", DAP_SERVER, "plpgsql", {
      env: codeMoniker.dapEnvironment(),
    });
    dc.defaultTimeout = DEBUG_DAP_EVENT_TIMEOUT_MS;
    outputs = [];
    terminatedCount = 0;
    dc.on("output", (event) => outputs.push(String(event.body.output ?? "")));
    dc.on("terminated", () => {
      terminatedCount++;
    });
    await dc.start();
  });

  afterEach(async () => {
    await stopDebugClient(dc);
    expect(await waitForDebuggerBackendsToClose()).toBe(0);
  }, DEBUG_INTEGRATION_TEST_TIMEOUT_MS);

  it(
    "skips the recursive technical entry and reports every recursive line-breakpoint frame",
    async () => {
      let stoppedCount = 0;
      dc.on("stopped", () => {
        stoppedCount++;
      });
      const oid = await routineOid("playground.fib(integer)");
      const sourcePath = canonicalSourceUris[String(oid)];
      expect(sourcePath).toMatch(/^code\+moniker:\/\//);

      const initialized = dc.waitForEvent("initialized", DEBUG_DAP_EVENT_TIMEOUT_MS);
      // VS Code uses zero-based editor lines in its DAP session. Prove that the
      // adapter converts that client convention to PostgreSQL's one-based lines.
      await dc.initializeRequest({
        adapterID: "plpgsql",
        linesStartAt1: false,
        columnsStartAt1: false,
        pathFormat: "path",
      });
      await initialized;

      const pending = await dc.setBreakpointsRequest({
        source: { path: sourcePath },
        breakpoints: [{ line: 11 }],
      });
      expect(pending.body.breakpoints[0]?.verified).toBe(false);

      const changed = dc.waitForEvent("breakpoint", DEBUG_DAP_EVENT_TIMEOUT_MS);
      const breakpointStop = dc.waitForEvent("stopped", DEBUG_DAP_EVENT_TIMEOUT_MS);
      await dc.launchRequest(
        launchConfig("SELECT playground.fib(5)", {
          stopOnEntry: true,
        }),
      );
      await dc.configurationDoneRequest();

      expect((await changed).body.breakpoint.verified).toBe(true);
      let stopped = await breakpointStop;
      const expectedReturns = [
        { n: "2", result: "1" },
        { n: "3", result: "2" },
        { n: "2", result: "1" },
        { n: "4", result: "3" },
        { n: "2", result: "1" },
        { n: "3", result: "2" },
        { n: "5", result: "5" },
      ];
      const seenScopeReferences = new Set<number>();
      const seenFrameIds = new Set<number>();
      for (const expected of expectedReturns) {
        expect(stopped.body.reason).toBe("breakpoint");
        const stack = await dc.stackTraceRequest({ threadId: stopped.body.threadId });
        expect(stack.body.stackFrames[0]?.line).toBe(11);
        const frameId = stack.body.stackFrames[0].id;
        expect(seenFrameIds.has(frameId)).toBe(false);
        seenFrameIds.add(frameId);
        const scopes = await dc.scopesRequest({ frameId });
        const values = new Map<string, string>();
        for (const scope of scopes.body.scopes) {
          expect(seenScopeReferences.has(scope.variablesReference)).toBe(false);
          seenScopeReferences.add(scope.variablesReference);
          const variables = await dc.variablesRequest({
            variablesReference: scope.variablesReference,
          });
          for (const { name, value } of variables.body.variables) values.set(name, value);
        }
        const evaluatedN = await dc.evaluateRequest({
          context: "watch",
          expression: "n",
          frameId,
        });
        const evaluatedResult = await dc.evaluateRequest({
          context: "watch",
          expression: "result",
          frameId,
        });
        expect(values.get("n")).toBe(expected.n);
        expect(values.get("result")).toBe(expected.result);
        expect(evaluatedN.body.result).toBe(expected.n);
        expect(evaluatedResult.body.result).toBe(expected.result);
        if (expected !== expectedReturns.at(-1)) {
          const nextStop = dc.waitForEvent("stopped", DEBUG_DAP_EVENT_TIMEOUT_MS);
          await runPacedDebugAction(dc, () =>
            dc.continueRequest({ threadId: stopped.body.threadId }),
          );
          stopped = await nextStop;
        }
      }

      expect(stoppedCount).toBe(expectedReturns.length);
      const terminated = dc.waitForEvent("terminated", DEBUG_DAP_EVENT_TIMEOUT_MS);
      await runPacedDebugAction(dc, () => dc.continueRequest({ threadId: stopped.body.threadId }));
      await terminated;
      await delay(100);
      expect(stoppedCount).toBe(expectedReturns.length);
      expect(terminatedCount).toBe(1);
      expect(await waitForDebuggerBackendsToClose()).toBe(0);
    },
    DEBUG_INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "reconciles repeated and replaced breakpoints without leaving stale server state",
    async () => {
      const entry = await launchAndWaitForEntry(dc, "SELECT test_increments()");
      const stack = await dc.stackTraceRequest({ threadId: entry.body.threadId });
      const sourcePath = stack.body.stackFrames[0]?.source?.path ?? "";

      const first = await dc.setBreakpointsRequest({
        source: { path: sourcePath },
        breakpoints: [{ line: 10 }],
      });
      const repeated = await dc.setBreakpointsRequest({
        source: { path: sourcePath },
        breakpoints: [{ line: 10 }],
      });
      const replaced = await dc.setBreakpointsRequest({
        source: { path: sourcePath },
        breakpoints: [{ line: 11 }],
      });

      expect(first.body.breakpoints[0]?.verified).toBe(true);
      expect(repeated.body.breakpoints[0]?.verified).toBe(true);
      expect(replaced.body.breakpoints[0]?.verified).toBe(true);

      const stopped = dc.waitForEvent("stopped", DEBUG_DAP_EVENT_TIMEOUT_MS);
      await runPacedDebugAction(dc, () => dc.continueRequest({ threadId: entry.body.threadId }));
      expect((await stopped).body.reason).toBe("breakpoint");

      const stoppedStack = await dc.stackTraceRequest({ threadId: entry.body.threadId });
      expect(stoppedStack.body.stackFrames[0]?.line).toBe(11);
    },
    DEBUG_INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "accepts only one Continue and terminates exactly once when no breakpoint follows",
    async () => {
      const entry = await launchAndWaitForEntry(dc, "SELECT test_simple(1, 'continue')");
      const terminated = dc.waitForEvent("terminated", DEBUG_DAP_EVENT_TIMEOUT_MS);

      const responses = await Promise.allSettled([
        dc.continueRequest({ threadId: entry.body.threadId }),
        dc.continueRequest({ threadId: entry.body.threadId }),
      ]);
      await terminated;
      await delay(100);

      expect(responses.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(responses.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(terminatedCount).toBe(1);
      expect(await waitForDebuggerBackendsToClose()).toBe(0);
    },
    DEBUG_INTEGRATION_TEST_TIMEOUT_MS,
  );

  it("returns SQL output and fails promptly when the query never reaches the target", async () => {
    const structured = dc.waitForEvent(DEBUG_RESULT_EVENT, 10_000);
    const terminated = dc.waitForEvent("terminated", 10_000);
    const startedAt = Date.now();

    await Promise.all([
      dc.launch(
        launchConfig("SELECT test_simple(1, 'not-called') WHERE false", {
          attachTimeoutMs: 10_000,
        }),
      ),
      dc.configurationSequence(),
      terminated,
    ]);

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect((await structured).body).toMatchObject({
      command: "SELECT",
      rowCount: 0,
      capturedRowCount: 0,
    });
    expect(outputs.join("")).toContain("completed without reaching the debug entry");
    expect(terminatedCount).toBe(1);
    expect(await waitForDebuggerBackendsToClose()).toBe(0);
  });

  it(
    "publishes concise lifecycle information for a complete session",
    async () => {
      const entry = await launchAndWaitForEntry(dc, "SELECT test_simple(2, 'status')");
      const terminated = dc.waitForEvent("terminated", DEBUG_DAP_EVENT_TIMEOUT_MS);
      await runPacedDebugAction(dc, () => dc.continueRequest({ threadId: entry.body.threadId }));
      await terminated;

      const transcript = outputs.join("");
      expect(transcript).toContain("Preparing PL/pgSQL debug session");
      expect(transcript).toContain("Waiting for SELECT test_simple(2, 'status')");
      expect(transcript).toMatch(/Attached to PostgreSQL backend \d+/);
      expect(transcript).toContain("Execution completed");
    },
    DEBUG_INTEGRATION_TEST_TIMEOUT_MS,
  );

  it("correlates adapter state and returns the CALL output row before termination", async () => {
    const statuses: DebugSessionStatus[] = [];
    dc.on(DEBUG_SESSION_STATUS_EVENT, (event) => statuses.push(event.body));
    const entry = await launchAndWaitForEntry(dc, "CALL test_proc(7)");
    const result = dc.waitForEvent(DEBUG_RESULT_EVENT, DEBUG_DAP_EVENT_TIMEOUT_MS);
    const terminated = dc.waitForEvent("terminated", DEBUG_DAP_EVENT_TIMEOUT_MS);

    await runPacedDebugAction(dc, () => dc.continueRequest({ threadId: entry.body.threadId }));
    const callResult = await result;
    await terminated;

    expect(callResult.body).toMatchObject({
      command: "CALL",
      rowCount: 1,
      capturedRowCount: 1,
    });
    expect(callResult.body.columns.map((column: { name: string }) => column.name)).toEqual([
      "total",
    ]);
    expect(statuses.map((status) => status.state)).toEqual(
      expect.arrayContaining([
        "preparing",
        "waitingForTarget",
        "suspended",
        "resuming",
        "terminating",
        "terminated",
      ]),
    );
    const suspended = statuses.find((status) => status.state === "suspended");
    expect(suspended).toMatchObject({
      routine: {
        schema: null,
        name: "test_proc",
        kind: "procedure",
      },
    });
    expect(suspended?.routine?.oid).toBeGreaterThan(0);
    expect(suspended?.listenerPid).toBeGreaterThan(0);
    expect(suspended?.targetPid).toBeGreaterThan(0);
    expect(suspended?.source?.path).toBe(canonicalSourceUris[String(suspended?.routine?.oid)]);
    expect(suspended?.source?.path).toMatch(/^code\+moniker:\/\//);
  });

  it("publishes the exact routine source for every suspension across nested calls", async () => {
    const statuses: DebugSessionStatus[] = [];
    dc.on(DEBUG_SESSION_STATUS_EVENT, (event) => statuses.push(event.body));
    const entry = await launchAndWaitForEntry(dc, "SELECT test_step_into(5)");

    const nestedStop = dc.waitForEvent("stopped", DEBUG_DAP_EVENT_TIMEOUT_MS);
    await runPacedDebugAction(dc, () => dc.stepInRequest({ threadId: entry.body.threadId }));
    await nestedStop;

    const deadline = Date.now() + 5_000;
    let nestedStatus: DebugSessionStatus | undefined;
    while (!nestedStatus && Date.now() < deadline) {
      nestedStatus = statuses.find(
        (status) => status.state === "suspended" && status.source?.name === "public.test_inner",
      );
      if (!nestedStatus) await delay(25);
    }

    const stack = await dc.stackTraceRequest({ threadId: entry.body.threadId });
    const topFrame = stack.body.stackFrames[0];
    expect(topFrame?.name).toContain("test_inner");
    expect(nestedStatus?.source).toEqual({
      name: "public.test_inner",
      path: topFrame?.source?.path,
      line: topFrame?.line,
      sourceReference: 0,
    });
    expect(
      statuses.some(
        (status) => status.state === "suspended" && status.source?.name === "public.test_step_into",
      ),
    ).toBe(true);
  });
});
