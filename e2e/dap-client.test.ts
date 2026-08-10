/**
 * Full DAP client e2e tests using @vscode/debugadapter-testsupport.
 * Tests the debug adapter protocol over stdio — no VS Code needed.
 * Requires: PostgreSQL e2e container running on port 5433.
 */

import * as path from "node:path";
import { DebugClient } from "@vscode/debugadapter-testsupport";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEBUG_RESULT_EVENT, DEBUG_RESULT_STATUS_EVENT } from "../src/debugger/launch/index.js";
import { type CodeMonikerTestRuntime, startCodeMonikerTestRuntime } from "./codeMonikerRuntime.js";

const DAP_SERVER = path.resolve(__dirname, "../dist/main.js");
const LAUNCH_ARGS = {
  host: "localhost",
  port: 5433,
  database: "testdb",
  user: "postgres",
  password: "postgres",
};
let canonicalSourceUris: Record<string, string> = {};

function launchConfig(sql: string) {
  return { ...LAUNCH_ARGS, sourceUris: canonicalSourceUris, sql };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function activeDebuggerBackends(client: Client): Promise<number> {
  const result = await client.query(`
    SELECT count(*)::int AS count
    FROM pg_stat_activity
    WHERE application_name LIKE 'plpgsql_dap_listener_%'
       OR application_name LIKE 'plpgsql_dap_target_%'`);
  return Number(result.rows[0]?.count ?? 0);
}

async function waitForDebuggerBackendsToClose(client: Client): Promise<number> {
  const deadline = Date.now() + 3_000;
  let count = await activeDebuggerBackends(client);
  while (count > 0 && Date.now() < deadline) {
    await delay(50);
    count = await activeDebuggerBackends(client);
  }
  return count;
}

async function launchAndWaitForStop(dc: DebugClient, args: unknown, timeout = 15_000) {
  const stopped = dc.waitForEvent("stopped", timeout);
  const [, , event] = await Promise.all([dc.launch(args), dc.configurationSequence(), stopped]);
  return event;
}

async function runAndWaitForStop(
  dc: DebugClient,
  action: () => Promise<unknown>,
  timeout = 15_000,
) {
  const stopped = dc.waitForEvent("stopped", timeout);
  await action();
  return stopped;
}

describe("DAP client e2e", () => {
  let dc: DebugClient;
  let codeMoniker: CodeMonikerTestRuntime;

  beforeAll(async () => {
    codeMoniker = await startCodeMonikerTestRuntime();
    canonicalSourceUris = await codeMoniker.sourceUris(LAUNCH_ARGS);
  }, 30_000);

  afterAll(async () => {
    await codeMoniker.dispose();
  });

  beforeEach(async () => {
    dc = new DebugClient("node", DAP_SERVER, "plpgsql", {
      env: codeMoniker.dapEnvironment(),
    });
    await dc.start();
  });

  afterEach(async () => {
    try {
      await Promise.race([dc.stop(), delay(3000)]);
    } catch {
      // session may already be closed
    }
  }, 10_000);

  // ----- Launch & terminate -----

  it("launches and stops on entry", async () => {
    const stopped = await launchAndWaitForStop(dc, launchConfig("SELECT test_simple(1, 'hello')"));
    expect(stopped.body.reason).toBe("entry");
  });

  it("launches a schema-qualified function call", async () => {
    const stopped = await launchAndWaitForStop(
      dc,
      launchConfig("SELECT public.test_simple(1, 'qualified')"),
    );
    expect(stopped.body.reason).toBe("entry");
  });

  it("reports the target SQL result in the Debug Console before termination", async () => {
    await launchAndWaitForStop(dc, launchConfig("SELECT test_simple(7, 'lens')"));
    const threadId = (await dc.threadsRequest()).body.threads[0].id;
    const output = dc.waitForEvent("output", 15_000);
    const terminated = dc.waitForEvent("terminated", 15_000);

    await dc.continueRequest({ threadId });

    expect((await output).body).toMatchObject({
      category: "console",
      output: "SQL result:\nlens - 8\n",
    });
    await terminated;
  });

  it("streams a large target result into a bounded structured preview", async () => {
    const pending = dc.waitForEvent(DEBUG_RESULT_STATUS_EVENT, 15_000);
    await launchAndWaitForStop(dc, {
      ...launchConfig("SELECT * FROM test_many_rows(250)"),
      resultMaxRows: 20,
    });
    const threadId = (await dc.threadsRequest()).body.threads[0].id;
    expect((await pending).body).toMatchObject({
      status: "pending",
      query: "SELECT * FROM test_many_rows(250)",
    });
    const structured = dc.waitForEvent(DEBUG_RESULT_EVENT, 15_000);
    const terminated = dc.waitForEvent("terminated", 15_000);

    await dc.continueRequest({ threadId });

    const body = (await structured).body;
    expect(body).toMatchObject({
      command: "SELECT",
      rowCount: 250,
      capturedRowCount: 20,
      truncated: true,
      truncationReasons: ["rows"],
    });
    expect(body.columns).toEqual([
      { name: "id", dataTypeId: 23, typeName: "integer" },
      { name: "payload", dataTypeId: 3802, typeName: "jsonb" },
    ]);
    expect(body.rows).toHaveLength(20);
    expect(body.payloadBytes).toBeLessThanOrEqual(1024 * 1024);
    await terminated;
  });

  it("reports SETOF named composite rows as a typed structured result", async () => {
    await launchAndWaitForStop(dc, launchConfig("SELECT * FROM test_setof_record_rows()"));
    const threadId = (await dc.threadsRequest()).body.threads[0].id;
    const structured = dc.waitForEvent(DEBUG_RESULT_EVENT, 15_000);
    const terminated = dc.waitForEvent("terminated", 15_000);

    await dc.continueRequest({ threadId });

    const body = (await structured).body;
    expect(body).toMatchObject({
      command: "SELECT",
      rowCount: 3,
      capturedRowCount: 3,
      truncated: false,
    });
    expect(body.columns).toEqual([
      { name: "id", dataTypeId: 23, typeName: "integer" },
      { name: "name", dataTypeId: 25, typeName: "text" },
      { name: "active", dataTypeId: 16, typeName: "boolean" },
    ]);
    expect(body.rows).toEqual([
      [
        { kind: "number", value: "1" },
        { kind: "text", value: "first" },
        { kind: "boolean", value: "true" },
      ],
      [
        { kind: "number", value: "2" },
        { kind: "text", value: "" },
        { kind: "boolean", value: "false" },
      ],
      [
        { kind: "number", value: "3" },
        { kind: "null", value: null },
        { kind: "null", value: null },
      ],
    ]);
    await terminated;
  }, 20_000);

  it("reports SETOF anonymous record rows using the callsite descriptor", async () => {
    const sql = `SELECT *
      FROM test_setof_anonymous_rows()
        AS row_result(id integer, name text, amount numeric, note text)`;
    await launchAndWaitForStop(dc, launchConfig(sql));
    const threadId = (await dc.threadsRequest()).body.threads[0].id;
    const structured = dc.waitForEvent(DEBUG_RESULT_EVENT, 15_000);
    const terminated = dc.waitForEvent("terminated", 15_000);

    await dc.continueRequest({ threadId });

    const body = (await structured).body;
    expect(body).toMatchObject({
      command: "SELECT",
      rowCount: 2,
      capturedRowCount: 2,
      truncated: false,
    });
    expect(body.columns).toEqual([
      { name: "id", dataTypeId: 23, typeName: "integer" },
      { name: "name", dataTypeId: 25, typeName: "text" },
      { name: "amount", dataTypeId: 1700, typeName: "numeric" },
      { name: "note", dataTypeId: 25, typeName: "text" },
    ]);
    expect(body.rows).toEqual([
      [
        { kind: "number", value: "10" },
        { kind: "text", value: "alpha" },
        { kind: "number", value: "1.50" },
        { kind: "null", value: null },
      ],
      [
        { kind: "number", value: "11" },
        { kind: "text", value: "" },
        { kind: "number", value: "2.25" },
        { kind: "text", value: "note" },
      ],
    ]);
    await terminated;
  }, 20_000);

  it("launches from a structured routine target", async () => {
    const stopped = await launchAndWaitForStop(dc, {
      ...LAUNCH_ARGS,
      sourceUris: canonicalSourceUris,
      routine: {
        schema: "public",
        name: "test_simple",
        kind: "function",
        argTypes: ["integer", "text"],
      },
      routineArgs: [{ value: "42" }, { value: "bound" }],
    });
    expect(stopped.body.reason).toBe("entry");
  });

  it("launches a zero-arg structured routine target", async () => {
    const stopped = await launchAndWaitForStop(dc, {
      ...LAUNCH_ARGS,
      sourceUris: canonicalSourceUris,
      routine: {
        schema: "public",
        name: "test_array_var",
        kind: "function",
        argTypes: [],
      },
      routineArgs: [],
    });
    expect(stopped.body.reason).toBe("entry");
  });

  it("launches a structured routine target with parser-style type aliases", async () => {
    const stopped = await launchAndWaitForStop(dc, {
      ...LAUNCH_ARGS,
      sourceUris: canonicalSourceUris,
      routine: {
        schema: "public",
        name: "test_inner",
        kind: "function",
        argTypes: ["int4"],
      },
      routineArgs: [{ value: "5" }],
    });
    expect(stopped.body.reason).toBe("entry");
  });

  it("rejects a multi-statement target and closes the listener backend", async () => {
    await expect(
      dc.launch(launchConfig("SELECT test_simple(1, 'first'); SELECT test_simple(2, 'second')")),
    ).rejects.toThrow(/exactly one SQL statement/);

    const inspector = new Client(LAUNCH_ARGS);
    await inspector.connect();
    try {
      expect(await waitForDebuggerBackendsToClose(inspector)).toBe(0);
    } finally {
      await inspector.end();
    }
  });

  it("fails promptly when a target never enters the routine and closes its backends", async () => {
    const outputs: string[] = [];
    dc.on("output", (event) => outputs.push(String(event.body.output ?? "")));
    const terminated = dc.waitForEvent("terminated", 10_000);
    const startedAt = Date.now();

    await Promise.all([
      dc.launch({
        ...launchConfig("SELECT test_simple(1, 'timeout') WHERE false"),
        attachTimeoutMs: 250,
      }),
      dc.configurationSequence(),
      terminated,
    ]);

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(outputs.join("")).toContain("without reaching the debug entry");

    const inspector = new Client(LAUNCH_ARGS);
    await inspector.connect();
    try {
      expect(await waitForDebuggerBackendsToClose(inspector)).toBe(0);
    } finally {
      await inspector.end();
    }
  });

  it("rejects a conflicting launch without terminating the active session", async () => {
    const second = new DebugClient("node", DAP_SERVER, "plpgsql", {
      env: codeMoniker.dapEnvironment(),
    });
    await second.start();

    try {
      const firstStopped = dc.waitForEvent("stopped", 15_000);
      await Promise.all([
        dc.launch(launchConfig("SELECT test_simple(1, 'first')")),
        dc.configurationSequence(),
      ]);
      const stopped = await firstStopped;

      await expect(second.launch(launchConfig("SELECT test_simple(2, 'second')"))).rejects.toThrow(
        /already owns this routine breakpoint/,
      );

      const stack = await dc.stackTraceRequest({ threadId: stopped.body.threadId });
      expect(stack.body.stackFrames[0]?.name).toContain("test_simple");
    } finally {
      await dc.disconnectRequest().catch(() => {});
      await Promise.race([second.stop(), delay(3000)]).catch(() => {});
    }
  });

  it("replays function breakpoints configured before launch", async () => {
    const initialized = dc.waitForEvent("initialized", 5_000);
    await dc.initializeRequest();
    await initialized;

    const configured = await dc.setFunctionBreakpointsRequest({
      breakpoints: [{ name: "public.test_inner" }],
    });
    expect(configured.body.breakpoints[0]?.verified).toBe(false);

    const changed = dc.waitForEvent("breakpoint", 15_000);
    const stopped = dc.waitForEvent("stopped", 15_000);
    await dc.launchRequest({
      ...launchConfig("SELECT test_step_into(5)"),
      stopOnEntry: false,
    });
    await dc.configurationDoneRequest();

    expect((await changed).body.breakpoint.verified).toBe(true);
    const stop = await stopped;
    expect(stop.body.reason).toBe("breakpoint");

    const stack = await dc.stackTraceRequest({ threadId: stop.body.threadId });
    expect(stack.body.stackFrames[0]?.name).toContain("test_inner");

    await dc.disconnectRequest();
  });

  // ----- Stack trace -----

  it("reports correct function name in stack trace", async () => {
    const stopped = await launchAndWaitForStop(dc, launchConfig("SELECT test_simple(1, 'hi')"));
    const stack = await dc.stackTraceRequest({ threadId: stopped.body.threadId });

    expect(stack.body.stackFrames.length).toBeGreaterThan(0);
    expect(stack.body.stackFrames[0].name).toContain("test_simple");
    expect(stack.body.stackFrames[0].line).toBeGreaterThan(0);

    await dc.disconnectRequest();
  });

  // ----- Variables: arguments -----

  it("shows argument variables with correct values", async () => {
    const stopped = await launchAndWaitForStop(dc, launchConfig("SELECT test_simple(42, 'world')"));
    const tid = stopped.body.threadId;

    const stack = await dc.stackTraceRequest({ threadId: tid });
    const scopes = await dc.scopesRequest({ frameId: stack.body.stackFrames[0].id });

    // Scope 0 = Arguments, Scope 1 = Local Variables
    expect(scopes.body.scopes.length).toBeGreaterThanOrEqual(2);
    const argsRef = scopes.body.scopes[0].variablesReference;

    const args = await dc.variablesRequest({ variablesReference: argsRef });
    const a = args.body.variables.find((v) => v.name === "a");
    const b = args.body.variables.find((v) => v.name === "b");
    expect(a).toBeDefined();
    expect(a!.value).toBe("42");
    expect(b).toBeDefined();
    expect(b!.value).toBe("world");

    await dc.disconnectRequest();
  });

  // ----- Step over -----

  it("step over advances to next line and updates variables", async () => {
    const stopped = await launchAndWaitForStop(dc, launchConfig("SELECT test_simple(1, 'step')"));
    const tid = stopped.body.threadId;

    const stack1 = await dc.stackTraceRequest({ threadId: tid });
    const line1 = stack1.body.stackFrames[0].line;

    // Step over
    const stopped2 = await runAndWaitForStop(dc, () => dc.nextRequest({ threadId: tid }), 10_000);
    expect(stopped2.body.reason).toBe("step");

    const stack2 = await dc.stackTraceRequest({ threadId: tid });
    const line2 = stack2.body.stackFrames[0].line;
    expect(line2).not.toBe(line1);

    // Check counter variable was assigned
    const scopes = await dc.scopesRequest({ frameId: stack2.body.stackFrames[0].id });
    const locals = await dc.variablesRequest({
      variablesReference: scopes.body.scopes[1].variablesReference,
    });
    const counter = locals.body.variables.find((v) => v.name === "counter");
    expect(counter).toBeDefined();
    expect(counter!.value).toBe("2"); // a(1) + 1

    await dc.disconnectRequest();
  });

  // ----- Step into -----

  it("step into enters nested function with correct stack depth", async () => {
    await launchAndWaitForStop(dc, launchConfig("SELECT test_step_into(5)"));

    const tid = (await dc.threadsRequest()).body.threads[0].id;

    // Entry stop is already on the call line (result := test_inner(val)) — step into directly
    await runAndWaitForStop(dc, () => dc.stepInRequest({ threadId: tid }));

    const stack = await dc.stackTraceRequest({ threadId: tid });
    expect(stack.body.stackFrames.length).toBeGreaterThanOrEqual(2);
    expect(stack.body.stackFrames[0].name).toContain("test_inner");
    expect(stack.body.stackFrames[1].name).toContain("test_step_into");

    // Verify x=5 in test_inner
    const scopes = await dc.scopesRequest({ frameId: stack.body.stackFrames[0].id });
    const argVars = await dc.variablesRequest({
      variablesReference: scopes.body.scopes[0].variablesReference,
    });
    const x = argVars.body.variables.find((v) => v.name === "x");
    expect(x).toBeDefined();
    expect(x!.value).toBe("5");

    await dc.disconnectRequest();
  });

  // ----- Record type (JSON expansion) -----

  it("record variable is expandable with child fields", async () => {
    const stopped = await launchAndWaitForStop(dc, launchConfig("SELECT test_record_var()"));
    const tid = stopped.body.threadId;

    // Step 3 times to fill the record (rec.id, rec.name, rec.active)
    for (let i = 0; i < 3; i++) {
      await runAndWaitForStop(dc, () => dc.nextRequest({ threadId: tid }));
    }

    const stack = await dc.stackTraceRequest({ threadId: tid });
    const scopes = await dc.scopesRequest({ frameId: stack.body.stackFrames[0].id });
    const locals = await dc.variablesRequest({
      variablesReference: scopes.body.scopes[1].variablesReference,
    });
    const rec = locals.body.variables.find((v) => v.name === "rec");
    expect(rec).toBeDefined();
    expect(rec!.variablesReference).toBeGreaterThan(0); // expandable

    const children = await dc.variablesRequest({ variablesReference: rec!.variablesReference });
    expect(children.body.variables.length).toBeGreaterThan(0);
    const id = children.body.variables.find((v) => v.name === "id");
    expect(id).toBeDefined();
    expect(id!.value).toBe("42");

    await dc.disconnectRequest();
  });

  it("shows multiple composite records as compact expandable values", async () => {
    const stopped = await launchAndWaitForStop(dc, launchConfig("SELECT test_composite_records()"));
    const tid = stopped.body.threadId;

    await runAndWaitForStop(dc, () => dc.nextRequest({ threadId: tid }));
    await runAndWaitForStop(dc, () => dc.nextRequest({ threadId: tid }));

    const stack = await dc.stackTraceRequest({ threadId: tid });
    const scopes = await dc.scopesRequest({ frameId: stack.body.stackFrames[0].id });
    const locals = await dc.variablesRequest({
      variablesReference: scopes.body.scopes[1].variablesReference,
    });
    const prod = locals.body.variables.find((variable) => variable.name === "prod");
    const cust = locals.body.variables.find((variable) => variable.name === "cust");

    expect(prod?.variablesReference).toBeGreaterThan(0);
    expect(cust?.variablesReference).toBeGreaterThan(0);
    expect(prod?.value).toBe("{…}");
    expect(cust?.value).toBe("{…}");

    const prodFields = await dc.variablesRequest({ variablesReference: prod!.variablesReference });
    const custFields = await dc.variablesRequest({ variablesReference: cust!.variablesReference });
    expect(prodFields.body.variables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "id", value: "1" }),
        expect.objectContaining({ name: "name", value: "Saumon fumé" }),
        expect.objectContaining({ name: "stock", value: "12" }),
      ]),
    );
    expect(custFields.body.variables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "id", value: "1" }),
        expect.objectContaining({ name: "name", value: "Alice" }),
        expect.objectContaining({ name: "loyalty_points", value: "120" }),
      ]),
    );

    await dc.disconnectRequest();
  });

  it("expands a SELECT INTO anonymous record with AST field types", async () => {
    const stopped = await launchAndWaitForStop(dc, launchConfig("SELECT test_anonymous_record()"));
    const tid = stopped.body.threadId;
    await runAndWaitForStop(dc, () => dc.nextRequest({ threadId: tid }));

    const stack = await dc.stackTraceRequest({ threadId: tid });
    const scopes = await dc.scopesRequest({ frameId: stack.body.stackFrames[0].id });
    const locals = await dc.variablesRequest({
      variablesReference: scopes.body.scopes[1].variablesReference,
    });
    const rec = locals.body.variables.find((v) => v.name === "rec");
    expect(rec).toMatchObject({ type: "record" });
    expect(rec!.variablesReference).toBeGreaterThan(0);

    const children = await dc.variablesRequest({ variablesReference: rec!.variablesReference });
    expect(children.body.variables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "id", value: "42", type: "int4", evaluateName: "rec.id" }),
        expect.objectContaining({ name: "amount", value: "15", type: "numeric" }),
        expect.objectContaining({
          name: "created_at",
          value: "2026-01-02",
          type: "date",
        }),
        expect.objectContaining({ name: "note", value: "null", type: "text" }),
        expect.objectContaining({ name: "tags", type: "int4[]" }),
        expect.objectContaining({ name: "meta", type: "jsonb" }),
      ]),
    );

    await dc.disconnectRequest();
  });

  it("expands the current anonymous FOR record", async () => {
    const stopped = await launchAndWaitForStop(
      dc,
      launchConfig("SELECT test_anonymous_loop_record()"),
    );
    const tid = stopped.body.threadId;
    await runAndWaitForStop(dc, () => dc.nextRequest({ threadId: tid }));

    const stack = await dc.stackTraceRequest({ threadId: tid });
    const scopes = await dc.scopesRequest({ frameId: stack.body.stackFrames[0].id });
    const locals = await dc.variablesRequest({
      variablesReference: scopes.body.scopes[1].variablesReference,
    });
    const rec = locals.body.variables.find((v) => v.name === "rec");
    expect(rec!.variablesReference).toBeGreaterThan(0);

    const children = await dc.variablesRequest({ variablesReference: rec!.variablesReference });
    expect(children.body.variables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "id", value: "1", type: "int4" }),
        expect.objectContaining({ name: "amount", value: "1.5", type: "numeric" }),
      ]),
    );

    await dc.disconnectRequest();
  });

  // ----- JSONB variable -----

  it("JSONB variable contains expected data", async () => {
    const stopped = await launchAndWaitForStop(dc, launchConfig("SELECT test_json_var()"));
    const tid = stopped.body.threadId;

    // Step once to assign j
    await runAndWaitForStop(dc, () => dc.nextRequest({ threadId: tid }));

    const stack = await dc.stackTraceRequest({ threadId: tid });
    const scopes = await dc.scopesRequest({ frameId: stack.body.stackFrames[0].id });
    const locals = await dc.variablesRequest({
      variablesReference: scopes.body.scopes[1].variablesReference,
    });
    const j = locals.body.variables.find((v) => v.name === "j");
    expect(j).toBeDefined();
    expect(j).toMatchObject({ value: "{…}", type: "jsonb" });
    expect(j!.variablesReference).toBeGreaterThan(0);

    const fields = await dc.variablesRequest({ variablesReference: j!.variablesReference });
    expect(fields.body.variables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "name", value: "alice" }),
        expect.objectContaining({ name: "age", value: "30" }),
      ]),
    );

    await dc.disconnectRequest();
  });

  // ----- Array variable -----

  it("array variable is expandable with indexed elements", async () => {
    const stopped = await launchAndWaitForStop(dc, launchConfig("SELECT test_array_var()"));
    const tid = stopped.body.threadId;

    // Step once to get past DECLARE defaults
    await runAndWaitForStop(dc, () => dc.nextRequest({ threadId: tid }));

    const stack = await dc.stackTraceRequest({ threadId: tid });
    const scopes = await dc.scopesRequest({ frameId: stack.body.stackFrames[0].id });
    const locals = await dc.variablesRequest({
      variablesReference: scopes.body.scopes[1].variablesReference,
    });
    const arr = locals.body.variables.find((v) => v.name === "arr");
    expect(arr).toBeDefined();
    expect(arr!.variablesReference).toBeGreaterThan(0);

    const elements = await dc.variablesRequest({ variablesReference: arr!.variablesReference });
    expect(elements.body.variables.length).toBeGreaterThanOrEqual(3);

    await dc.disconnectRequest();
  });

  // ----- Evaluate (watch + REPL) -----

  it("evaluate returns variable value for watch context", async () => {
    await launchAndWaitForStop(dc, launchConfig("SELECT test_simple(10, 'eval')"));

    const resp = await dc.evaluateRequest({
      expression: "a",
      context: "watch",
      frameId: 0,
    });
    expect(resp.body.result).toBe("10");

    await dc.disconnectRequest();
  });

  it("evaluate executes SQL in REPL context", async () => {
    await launchAndWaitForStop(dc, launchConfig("SELECT test_simple(1, 'repl')"));

    const resp = await dc.evaluateRequest({
      expression: "SELECT 1 + 1 AS result",
      context: "repl",
      frameId: 0,
    });
    expect(resp.body.result).toBe("2");

    await dc.disconnectRequest();
  });

  // ----- Loop stepping -----

  it("stepping through a loop accumulates variable values", async () => {
    const stopped = await launchAndWaitForStop(dc, launchConfig("SELECT test_loop(3)"));
    const tid = stopped.body.threadId;

    // Track session end — stepping past the last line terminates the session
    let terminated = false;
    dc.on("terminated", () => {
      terminated = true;
    });

    // Step until the function finishes, reading `total` at each stop
    let lastTotal = -1;
    for (let i = 0; i < 12 && !terminated; i++) {
      const stoppedAgain = await runAndWaitForStop(
        dc,
        () => dc.nextRequest({ threadId: tid }),
        5_000,
      ).catch(() => null);
      if (!stoppedAgain || terminated) break;

      const stack = await dc.stackTraceRequest({ threadId: tid });
      if (stack.body.stackFrames.length === 0) break;
      const scopes = await dc.scopesRequest({ frameId: stack.body.stackFrames[0].id });
      const locals = await dc.variablesRequest({
        variablesReference: scopes.body.scopes[1].variablesReference,
      });
      const total = locals.body.variables.find((v) => v.name === "total");
      if (total && total.value !== "NULL") {
        lastTotal = parseInt(total.value, 10);
      }
    }

    // At the RETURN stop the loop has fully accumulated: 1 + 2 + 3
    expect(lastTotal).toBe(6);

    if (!terminated) {
      await dc.disconnectRequest();
    }
  }, 30_000);

  // ----- Stepping semantics contract -----
  //
  // Standard debugger convention, asserted with EXACT lines and EXACT values:
  // the reported line is the NEXT statement to execute; everything above it
  // has run. test_increments (pg_get_functiondef space):
  //   line 6:  i int := 0;   (runs at block entry)
  //   line 8:  i := i + 1;   ← entry stop
  //   lines 9-12: i := i + 1;
  //   line 13: RETURN i;

  async function readLineAndI(dc: DebugClient): Promise<{ line: number; i: string }> {
    const tid = (await dc.threadsRequest()).body.threads[0].id;
    const stack = await dc.stackTraceRequest({ threadId: tid });
    const frame = stack.body.stackFrames[0];
    let i = "<missing>";
    const scopes = await dc.scopesRequest({ frameId: frame.id });
    for (const scope of scopes.body.scopes) {
      const vars = await dc.variablesRequest({
        variablesReference: scope.variablesReference,
      });
      const v = vars.body.variables.find((x) => x.name === "i");
      if (v) i = v.value;
    }
    return { line: frame.line, i };
  }

  it("stepping contract: exact full trajectory from entry to termination", async () => {
    await launchAndWaitForStop(dc, launchConfig("SELECT test_increments()"));
    const tid = (await dc.threadsRequest()).body.threads[0].id;

    // Every stop of the function's life, in order — through RETURN included.
    expect(await readLineAndI(dc)).toEqual({ line: 8, i: "0" });
    const trajectory = [
      { line: 9, i: "1" },
      { line: 10, i: "2" },
      { line: 11, i: "3" },
      { line: 12, i: "4" },
      { line: 13, i: "5" }, // RETURN i — all five increments visible
    ];
    for (const step of trajectory) {
      await runAndWaitForStop(dc, () => dc.nextRequest({ threadId: tid }));
      expect(await readLineAndI(dc)).toEqual(step);
    }

    // Stepping the RETURN line ends the function: clean termination, no hang.
    const terminated = dc.waitForEvent("terminated", 15_000);
    await dc.nextRequest({ threadId: tid });
    await terminated;
  }, 45_000);

  it("loop contract: exact per-iteration trajectory of a FOR loop", async () => {
    // test_loop(3): line 9 FOR header, line 10 loop body, line 12 RETURN.
    // END LOOP (line 11) is not steppable and must never appear as a stop.
    await launchAndWaitForStop(dc, launchConfig("SELECT test_loop(3)"));
    const tid = (await dc.threadsRequest()).body.threads[0].id;

    async function readState(): Promise<{ line: number; total: string; i: string }> {
      const stack = await dc.stackTraceRequest({ threadId: tid });
      const scopes = await dc.scopesRequest({ frameId: stack.body.stackFrames[0].id });
      const state = { line: stack.body.stackFrames[0].line, total: "<none>", i: "<none>" };
      for (const scope of scopes.body.scopes) {
        const vars = await dc.variablesRequest({
          variablesReference: scope.variablesReference,
        });
        for (const v of vars.body.variables) {
          if (v.name === "total") state.total = v.value;
          if (v.name === "i") state.i = v.value;
        }
      }
      return state;
    }

    expect(await readState()).toEqual({ line: 9, total: "0", i: "NULL" });
    const trajectory = [
      { line: 10, total: "0", i: "1" }, // FOR assigned i, body not yet run
      { line: 10, total: "1", i: "2" }, // iteration 1 done
      { line: 10, total: "3", i: "3" }, // iteration 2 done
      { line: 12, total: "6", i: "3" }, // loop finished → RETURN total
    ];
    for (const step of trajectory) {
      await runAndWaitForStop(dc, () => dc.nextRequest({ threadId: tid }));
      expect(await readState()).toEqual(step);
    }

    const terminated = dc.waitForEvent("terminated", 15_000);
    await dc.nextRequest({ threadId: tid });
    await terminated;
  }, 45_000);

  it("breakpoint contract: stops exactly on the requested line with all prior lines evaluated", async () => {
    await launchAndWaitForStop(dc, launchConfig("SELECT test_increments()"));
    const tid = (await dc.threadsRequest()).body.threads[0].id;
    const stack = await dc.stackTraceRequest({ threadId: tid });

    // Break on the 4th increment (line 11): lines 8-10 must have run, 11 not.
    const bpResponse = await dc.setBreakpointsRequest({
      source: { path: stack.body.stackFrames[0].source?.path ?? "" },
      breakpoints: [{ line: 11 }],
    });
    expect(bpResponse.body.breakpoints[0]?.verified).toBe(true);

    const next = await runAndWaitForStop(dc, () => dc.continueRequest({ threadId: tid }));
    expect(next.body.reason).toBe("breakpoint");
    expect(await readLineAndI(dc)).toEqual({ line: 11, i: "3" });

    await dc.disconnectRequest();
  });

  // ----- Breakpoints -----

  it("stops at a set breakpoint and verifies location", async () => {
    const stopped = await launchAndWaitForStop(dc, launchConfig("SELECT test_increments()"));
    expect(stopped.body.reason).toBe("entry");

    const threadId = (await dc.threadsRequest()).body.threads[0].id;
    const stack = await dc.stackTraceRequest({ threadId });
    const frame = stack.body.stackFrames[0];
    // Entry stops on the first `i := i + 1`; break two assignments later.
    const bpLine = frame.line + 2;

    const bpResponse = await dc.setBreakpointsRequest({
      source: { path: frame.source?.path ?? "" },
      breakpoints: [{ line: bpLine }],
    });
    expect(bpResponse.body.breakpoints[0]?.verified).toBe(true);

    const next = await runAndWaitForStop(dc, () => dc.continueRequest({ threadId }));
    expect(next.body.reason).toBe("breakpoint");
    const stack2 = await dc.stackTraceRequest({ threadId });
    expect(stack2.body.stackFrames[0]?.line).toBe(bpLine);

    await dc.disconnectRequest();
  });

  it("rejects a breakpoint on a non-steppable line", async () => {
    const stopped = await launchAndWaitForStop(dc, launchConfig("SELECT test_increments()"));
    expect(stopped.body.reason).toBe("entry");

    const threadId = (await dc.threadsRequest()).body.threads[0].id;
    const stack = await dc.stackTraceRequest({ threadId });
    const frame = stack.body.stackFrames[0];

    // Line 1 of the definition is `CREATE OR REPLACE FUNCTION ...` — never steppable.
    const bpResponse = await dc.setBreakpointsRequest({
      source: { path: frame.source?.path ?? "" },
      breakpoints: [{ line: 1 }],
    });
    expect(bpResponse.body.breakpoints[0]?.verified).toBe(false);

    await dc.disconnectRequest();
  });

  it("emits the exact canonical Code Moniker source path when a server id is provided", async () => {
    await launchAndWaitForStop(dc, {
      ...launchConfig("SELECT test_simple(1, 'scoped')"),
      server: "localhost:5433/testdb:postgres",
    });

    const tid = (await dc.threadsRequest()).body.threads[0].id;
    const stack = await dc.stackTraceRequest({ threadId: tid });
    const sourcePath = stack.body.stackFrames[0]?.source?.path ?? "";
    const oid = await routineOid("test_simple(integer,text)");
    expect(sourcePath).toBe(canonicalSourceUris[String(oid)]);
    expect(sourcePath).toMatch(/^code\+moniker:\/\//);

    await dc.disconnectRequest();
  });

  // ----- Procedures -----

  it("debugs a CALL procedure end to end", async () => {
    const stopped = await launchAndWaitForStop(dc, launchConfig("CALL test_proc(5)"));
    expect(stopped.body.reason).toBe("entry");

    const threadId = (await dc.threadsRequest()).body.threads[0].id;
    const stack = await dc.stackTraceRequest({ threadId });
    expect(stack.body.stackFrames[0]?.name).toContain("test_proc");

    const scopes = await dc.scopesRequest({ frameId: stack.body.stackFrames[0].id });
    const args = await dc.variablesRequest({
      variablesReference: scopes.body.scopes[0].variablesReference,
    });
    const total = args.body.variables.find((v) => v.name === "total");
    expect(total?.value).toBe("5");

    const terminated = dc.waitForEvent("terminated", 15_000);
    await dc.continueRequest({ threadId });
    await terminated;
  });

  // ----- Clean disconnect -----

  it("disconnect mid-session does not crash", async () => {
    await launchAndWaitForStop(dc, launchConfig("SELECT test_simple(0, 'disconnect')"));

    // Disconnect without continuing
    await dc.disconnectRequest();
    // Should not throw or hang
  });
});
