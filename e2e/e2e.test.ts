import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parseCall } from "../src/callParser.js";
import { PostgresDebugger } from "../src/debugger/postgres/index.js";
import { analyzeFunction } from "../src/functionSource.js";
import { type CodeMonikerTestRuntime, startCodeMonikerTestRuntime } from "./codeMonikerRuntime.js";
import { DEBUG_INTEGRATION_TEST_TIMEOUT_MS, runPacedDebugAction } from "./debugTestTiming.js";

const PG_CONFIG = {
  host: "127.0.0.1",
  port: 5433,
  database: "testdb",
  user: "postgres",
  password: "postgres",
  application_name: "plpgsql_dap_e2e_direct",
};

function stepOver(debuggerSession: PostgresDebugger) {
  return runPacedDebugAction(debuggerSession, () => debuggerSession.stepOver());
}

function stepContinue(debuggerSession: PostgresDebugger) {
  return runPacedDebugAction(debuggerSession, () => debuggerSession.stepContinue());
}

async function waitForDirectDebuggerClientsToClose(): Promise<number> {
  const inspector = new Client({
    ...PG_CONFIG,
    application_name: "plpgsql_dap_e2e_inspector",
  });
  await inspector.connect();
  try {
    const deadline = Date.now() + 3_000;
    let count = Number.POSITIVE_INFINITY;
    do {
      const result = await inspector.query<{ count: number }>(`
        SELECT count(*)::int AS count
        FROM pg_stat_activity
        WHERE application_name = 'plpgsql_dap_e2e_direct'
      `);
      count = Number(result.rows[0]?.count ?? 0);
      if (count === 0) return count;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    return count;
  } finally {
    await inspector.end();
  }
}

describe("e2e: pldbgapi integration", { timeout: DEBUG_INTEGRATION_TEST_TIMEOUT_MS }, () => {
  let listenerClient: Client;
  let targetClient: Client;
  let executor: PostgresDebugger;
  let codeMoniker: CodeMonikerTestRuntime;

  beforeAll(async () => {
    codeMoniker = await startCodeMonikerTestRuntime();
    listenerClient = new Client({ ...PG_CONFIG, application_name: "plpgsql_dap_e2e_metadata" });
    await listenerClient.connect();
    executor = new PostgresDebugger(listenerClient);
  });

  afterAll(async () => {
    await listenerClient.end().catch(() => {});
    await codeMoniker.dispose();
  });

  afterEach(async () => {
    // Every per-test listener and target must have disappeared before another
    // test can acquire the process-global pldebugger breakpoint owner.
    expect(await waitForDirectDebuggerClientsToClose()).toBe(0);
  });

  it("checks debugger prerequisites", async () => {
    const diag = await executor.checkDebugger();
    expect(diag.sharedLibraryOk).toBe(true);
    expect(diag.extensionOk).toBe(true);
  });

  it("resolves function OID via getCallArgs", async () => {
    const args = await executor.getCallArgs("public", "test_simple");
    expect(args.length).toBeGreaterThan(0);
    expect(args[0].oid).toBeGreaterThan(0);
    expect(args[0].name).toBe("a");
  });

  it("retrieves function definition with source and body", async () => {
    const args = await executor.getCallArgs("public", "test_simple");
    const funcDef = await executor.getFunctionDef(args[0].oid);
    expect(funcDef).not.toBeNull();
    expect(funcDef!.name).toBe("test_simple");
    // source = full pg_get_functiondef (CREATE OR REPLACE FUNCTION ...)
    expect(funcDef!.source).toContain("CREATE");
    expect(funcDef!.source).toContain("test_simple");
    expect(funcDef!.source).toContain("DECLARE");
    // body = prosrc (just the function body, no CREATE)
    expect(funcDef!.body).toContain("DECLARE");
    expect(funcDef!.body).toContain("result text");
    expect(funcDef!.body).not.toContain("CREATE");
  });

  it("computes correct body line offset for line number alignment", async () => {
    const args = await executor.getCallArgs("public", "test_simple");
    const funcDef = await executor.getFunctionDef(args[0].oid);
    expect(funcDef).not.toBeNull();

    const bodyIdx = funcDef!.source.indexOf(funcDef!.body);
    expect(bodyIdx).toBeGreaterThan(0);
    const bodyLineOffset = funcDef!.source.slice(0, bodyIdx).split("\n").length - 1;
    expect(bodyLineOffset).toBeGreaterThan(0);
    // The line just before the body should be the $$ delimiter
    const linesBeforeBody = funcDef!.source.slice(0, bodyIdx).split("\n");
    const lastHeaderLine = linesBeforeBody[linesBeforeBody.length - 1];
    expect(lastHeaderLine).toMatch(/\$\w*\$\s*$/);
  });

  it("analyzes the authoritative function body with Code Moniker", async () => {
    const args = await executor.getCallArgs("public", "test_simple");
    const funcDef = await executor.getFunctionDef(args[0].oid);
    expect(funcDef).not.toBeNull();

    const analysis = await analyzeFunction(funcDef!.body, codeMoniker.parser);
    expect(analysis.variables.length).toBeGreaterThan(0);
    const varNames = analysis.variables.map((v) => v.name);
    expect(varNames).toContain("result");
    expect(varNames).toContain("counter");
  });

  it("parses a debug target with Code Moniker", async () => {
    const parsed = await parseCall("SELECT test_simple(1, 'hello');", codeMoniker.parser);
    expect(parsed.routine).toBe("test_simple");
    expect(parsed.args).toEqual(["1", "'hello'"]);
  });

  describe("debug session", () => {
    let debugListener: Client;
    let debugExecutor: PostgresDebugger;

    beforeAll(async () => {
      debugListener = new Client({
        ...PG_CONFIG,
        application_name: "plpgsql_dap_e2e_nested_listener",
      });
      await debugListener.connect();
      debugExecutor = new PostgresDebugger(debugListener);
    });

    afterAll(async () => {
      await debugExecutor.abort().catch(() => {});
      await debugExecutor.close().catch(() => {});
    });

    it(
      "runs a full debug cycle: create listener, breakpoint, step, variables",
      async () => {
        // Create listener
        await debugExecutor.createListener();
        expect(debugExecutor.getSession()).not.toBe(0);

        // Get OID
        const args = await debugExecutor.getCallArgs("public", "test_simple");
        const oid = args[0].oid;

        // Set global breakpoint
        await debugExecutor.setGlobalBreakpoint(oid);

        // Execute in background on separate connection
        targetClient = new Client(PG_CONFIG);
        await targetClient.connect();
        const queryPromise = targetClient.query("SELECT test_simple(42, 'debug');").catch(() => {});

        // Wait for target to hit breakpoint
        const targetSession = await debugExecutor.waitForTarget();
        expect(targetSession).toBeGreaterThan(0);

        // Get stack
        const stack = await debugExecutor.getStack();
        expect(stack.length).toBeGreaterThan(0);
        expect(stack[0].oid).toBe(oid);

        // Get variables
        const vars = await debugExecutor.getVariables();
        expect(vars.length).toBeGreaterThan(0);
        const varNames = vars.map((v) => v.value.name);
        expect(varNames).toContain("a");
        expect(varNames).toContain("b");

        // Step over
        const step1 = await stepOver(debugExecutor);
        expect(step1).not.toBeNull();
        expect(step1!.oid).toBe(oid);

        // Step over again
        const step2 = await stepOver(debugExecutor);
        expect(step2).not.toBeNull();

        // Check variables after stepping
        const varsAfter = await debugExecutor.getVariables();
        const counterVar = varsAfter.find((v) => v.value.name === "counter");
        expect(counterVar).toBeDefined();
        // counter should be 43 (a + 1 = 42 + 1)
        expect(counterVar!.value.value).toBe("43");

        // Continue to end
        await stepContinue(debugExecutor);

        await queryPromise;
        await targetClient.end().catch(() => {});
      },
      DEBUG_INTEGRATION_TEST_TIMEOUT_MS,
    );
  });

  describe("breakpoints", () => {
    it(
      "stops at each breakpoint and verifies variable value",
      async () => {
        const debugListener = new Client(PG_CONFIG);
        await debugListener.connect();
        const debugExecutor = new PostgresDebugger(debugListener);

        try {
          await debugExecutor.createListener();
          const callArgs = await debugExecutor.getCallArgs("public", "test_increments");
          const oid = callArgs[0].oid;
          await debugExecutor.setGlobalBreakpoint(oid);

          // Execute in background
          targetClient = new Client(PG_CONFIG);
          await targetClient.connect();
          const queryPromise = targetClient.query("SELECT test_increments();").catch(() => {});

          await debugExecutor.waitForTarget();

          // test_increments prosrc body:
          //   line 5: i := i + 1;   (entry, i becomes 1)
          //   line 6: i := i + 1;   (i becomes 2)
          //   line 7: i := i + 1;   (i becomes 3)
          //   line 8: i := i + 1;   (i becomes 4)
          //   line 9: i := i + 1;   (i becomes 5)
          //   line 10: RETURN i;
          //
          // Entry is at line 5. Set breakpoints on lines 6-10 (after entry).
          for (let line = 6; line <= 10; line++) {
            expect(await debugExecutor.setBreakpoint(oid, line)).toBe(true);
          }

          // stepContinue through each breakpoint, recording line + i value.
          const stops: Array<{ line: number; i: string }> = [];

          for (;;) {
            const step = await stepContinue(debugExecutor);
            if (!step || step.oid === 0) break;
            const vars = await debugExecutor.getVariables();
            const iVal = vars.find((v) => v.value.name === "i")!.value.value;
            stops.push({ line: step.line, i: iVal });
          }

          // We should have stopped 5 times (one per breakpoint on lines 6-10)
          expect(stops.length).toBe(5);

          // pldbgapi breakpoints: setBreakpoint(oid, N) stops after line N
          // executes, reporting step.line = N + 1.
          // Breakpoint on 6 → stops at 7 with i=1 (line 6 "i := i+1" executed)
          // Breakpoint on 7 → stops at 8 with i=2 (line 7 executed)
          // ...etc
          for (let n = 0; n < stops.length; n++) {
            const bpLine = 6 + n;
            expect(stops[n].line).toBe(bpLine + 1);
            expect(stops[n].i).toBe(String(n + 1));
          }

          // Continue to end
          await stepContinue(debugExecutor);
          await queryPromise;
          await targetClient.end().catch(() => {});
        } finally {
          await debugExecutor.abort().catch(() => {});
          await debugExecutor.close().catch(() => {});
        }
      },
      DEBUG_INTEGRATION_TEST_TIMEOUT_MS,
    );

    it(
      "drops breakpoints",
      async () => {
        const debugListener = new Client(PG_CONFIG);
        await debugListener.connect();
        const debugExecutor = new PostgresDebugger(debugListener);

        try {
          await debugExecutor.createListener();
          const args = await debugExecutor.getCallArgs("public", "test_simple");
          const oid = args[0].oid;
          await debugExecutor.setGlobalBreakpoint(oid);

          // Execute in background
          targetClient = new Client(PG_CONFIG);
          await targetClient.connect();
          const queryPromise = targetClient
            .query("SELECT test_simple(1, 'no-bp');")
            .catch(() => {});

          await debugExecutor.waitForTarget();

          // Set and then drop a breakpoint (must be after attach)
          const bpOk = await debugExecutor.setBreakpoint(oid, 7);
          expect(bpOk).toBe(true);

          const dropOk = await debugExecutor.dropBreakpoint(oid, 7);
          expect(dropOk).toBe(true);

          // Verify breakpoint is gone (filter out global breakpoints which have line -1)
          const bps = await debugExecutor.getBreakpoints();
          expect(
            bps.some((bp: { oid: number; line: number }) => bp.oid === oid && bp.line === 7),
          ).toBe(false);

          // stepContinue should finish (no breakpoint to stop at)
          const step = await stepContinue(debugExecutor);
          expect(step).toBeNull(); // function completed

          await queryPromise;
          await targetClient.end().catch(() => {});
        } finally {
          await debugExecutor.abort().catch(() => {});
          await debugExecutor.close().catch(() => {});
        }
      },
      DEBUG_INTEGRATION_TEST_TIMEOUT_MS,
    );

    it(
      "sets breakpoint inside a loop and stops multiple times",
      async () => {
        const debugListener = new Client(PG_CONFIG);
        await debugListener.connect();
        const debugExecutor = new PostgresDebugger(debugListener);

        try {
          await debugExecutor.createListener();
          const args = await debugExecutor.getCallArgs("public", "test_loop");
          const oid = args[0].oid;
          await debugExecutor.setGlobalBreakpoint(oid);

          // Execute in background
          targetClient = new Client(PG_CONFIG);
          await targetClient.connect();
          const queryPromise = targetClient.query("SELECT test_loop(3);").catch(() => {});

          await debugExecutor.waitForTarget();

          // Set breakpoint inside the loop body (must be after attach)
          // pldbgapi body lines for test_loop (prosrc):
          //   body line 6: FOR i IN 1..n LOOP
          //   body line 7:   total := total + i;
          //   body line 9: RETURN total;
          //
          // pldbgapi breakpoint triggers after the line executes, so setting on
          // line 7 means stepContinue stops at line 8 (END LOOP / loop back).
          const bpLine = 7; // total := total + i
          const bpOk = await debugExecutor.setBreakpoint(oid, bpLine);
          expect(bpOk).toBe(true);

          // Continue — should stop after loop body line executes, iteration 1
          let step = await stepContinue(debugExecutor);
          expect(step).not.toBeNull();
          const stopLine = step!.line; // capture the actual stop line

          // Continue — should stop again, iteration 2
          step = await stepContinue(debugExecutor);
          expect(step).not.toBeNull();
          expect(step!.line).toBe(stopLine);

          // pldbgapi stops before executing the breakpoint line, so after
          // 2 stops the assignment has only executed once (iteration 1).
          // total = 0 + 1 = 1
          const vars = await debugExecutor.getVariables();
          const totalVar = vars.find((v: { value: { name: string } }) => v.value.name === "total");
          expect(totalVar).toBeDefined();
          expect(totalVar!.value.value).toBe("1");

          // Continue — iteration 3
          step = await stepContinue(debugExecutor);
          expect(step).not.toBeNull();
          expect(step!.line).toBe(stopLine);

          // Continue — should finish (no more iterations)
          await stepContinue(debugExecutor);

          await queryPromise;
          await targetClient.end().catch(() => {});
        } finally {
          await debugExecutor.abort().catch(() => {});
          await debugExecutor.close().catch(() => {});
        }
      },
      DEBUG_INTEGRATION_TEST_TIMEOUT_MS,
    );
  });

  describe("variable types", () => {
    it(
      "displays record type with JSON structure",
      async () => {
        const debugListener = new Client(PG_CONFIG);
        await debugListener.connect();
        const debugExecutor = new PostgresDebugger(debugListener);

        try {
          await debugExecutor.createListener();
          const args = await debugExecutor.getCallArgs("public", "test_record_var");
          const oid = args[0].oid;
          await debugExecutor.setGlobalBreakpoint(oid);

          targetClient = new Client(PG_CONFIG);
          await targetClient.connect();
          const queryPromise = targetClient.query("SELECT test_record_var();").catch(() => {});

          await debugExecutor.waitForTarget();

          // Step through all assignments
          await stepOver(debugExecutor); // rec.id := 42
          await stepOver(debugExecutor); // rec.name := 'test'
          await stepOver(debugExecutor); // rec.active := true

          const vars = await debugExecutor.getVariables();
          const recVar = vars.find((v) => v.value.name === "rec");
          expect(recVar).toBeDefined();
          // Record should be displayed as JSON via to_json
          const parsed = JSON.parse(recVar!.value.value);
          expect(parsed.id).toBe(42);
          expect(parsed.name).toBe("test");
          expect(parsed.active).toBe(true);

          // Pretty-printed version should also be valid JSON
          const prettyParsed = JSON.parse(recVar!.value.pretty);
          expect(prettyParsed.id).toBe(42);

          await stepContinue(debugExecutor);
          await queryPromise;
          await targetClient.end().catch(() => {});
        } finally {
          await debugExecutor.abort().catch(() => {});
          await debugExecutor.close().catch(() => {});
        }
      },
      DEBUG_INTEGRATION_TEST_TIMEOUT_MS,
    );

    it(
      "receives SELECT INTO anonymous records as JSON",
      async () => {
        const debugListener = new Client(PG_CONFIG);
        await debugListener.connect();
        const debugExecutor = new PostgresDebugger(debugListener);

        try {
          await debugExecutor.createListener();
          const args = await debugExecutor.getCallArgs("public", "test_anonymous_record");
          await debugExecutor.setGlobalBreakpoint(args[0].oid);

          targetClient = new Client(PG_CONFIG);
          await targetClient.connect();
          const queryPromise = targetClient
            .query("SELECT test_anonymous_record();")
            .catch(() => {});

          await debugExecutor.waitForTarget();
          await stepOver(debugExecutor);

          const vars = await debugExecutor.getVariables();
          const rec = vars.find((v) => v.value.name === "rec");
          expect(rec?.value.type).toBe("record");
          expect(JSON.parse(rec!.value.value)).toEqual({
            id: 42,
            amount: 15.0,
            created_at: "2026-01-02",
            note: null,
            tags: [1, 2],
            meta: { active: true },
          });

          await stepContinue(debugExecutor);
          await queryPromise;
          await targetClient.end().catch(() => {});
        } finally {
          await debugExecutor.abort().catch(() => {});
          await debugExecutor.close().catch(() => {});
        }
      },
      DEBUG_INTEGRATION_TEST_TIMEOUT_MS,
    );

    it(
      "receives the current anonymous FOR record as JSON",
      async () => {
        const debugListener = new Client(PG_CONFIG);
        await debugListener.connect();
        const debugExecutor = new PostgresDebugger(debugListener);

        try {
          await debugExecutor.createListener();
          const args = await debugExecutor.getCallArgs("public", "test_anonymous_loop_record");
          await debugExecutor.setGlobalBreakpoint(args[0].oid);

          targetClient = new Client(PG_CONFIG);
          await targetClient.connect();
          const queryPromise = targetClient
            .query("SELECT test_anonymous_loop_record();")
            .catch(() => {});

          await debugExecutor.waitForTarget();
          await stepOver(debugExecutor);

          const vars = await debugExecutor.getVariables();
          const rec = vars.find((v) => v.value.name === "rec");
          expect(rec?.value.type).toBe("record");
          expect(JSON.parse(rec!.value.value)).toEqual({ id: 1, amount: 1.5 });

          await stepContinue(debugExecutor);
          await queryPromise;
          await targetClient.end().catch(() => {});
        } finally {
          await debugExecutor.abort().catch(() => {});
          await debugExecutor.close().catch(() => {});
        }
      },
      DEBUG_INTEGRATION_TEST_TIMEOUT_MS,
    );

    it(
      "displays integer array as JSON array",
      async () => {
        const debugListener = new Client(PG_CONFIG);
        await debugListener.connect();
        const debugExecutor = new PostgresDebugger(debugListener);

        try {
          await debugExecutor.createListener();
          const args = await debugExecutor.getCallArgs("public", "test_array_var");
          const oid = args[0].oid;
          await debugExecutor.setGlobalBreakpoint(oid);

          targetClient = new Client(PG_CONFIG);
          await targetClient.connect();
          const queryPromise = targetClient.query("SELECT test_array_var();").catch(() => {});

          await debugExecutor.waitForTarget();

          // Step past arr := array_append(arr, 4)
          await stepOver(debugExecutor); // array_append

          const vars = await debugExecutor.getVariables();
          const arrVar = vars.find((v) => v.value.name === "arr");
          expect(arrVar).toBeDefined();
          // Array should be displayed as JSON array via to_json
          const parsed = JSON.parse(arrVar!.value.value);
          expect(parsed).toEqual([1, 2, 3, 4]);

          await stepContinue(debugExecutor);
          await queryPromise;
          await targetClient.end().catch(() => {});
        } finally {
          await debugExecutor.abort().catch(() => {});
          await debugExecutor.close().catch(() => {});
        }
      },
      DEBUG_INTEGRATION_TEST_TIMEOUT_MS,
    );

    it(
      "displays JSONB variable",
      async () => {
        const debugListener = new Client(PG_CONFIG);
        await debugListener.connect();
        const debugExecutor = new PostgresDebugger(debugListener);

        try {
          await debugExecutor.createListener();
          const args = await debugExecutor.getCallArgs("public", "test_json_var");
          const oid = args[0].oid;
          await debugExecutor.setGlobalBreakpoint(oid);

          targetClient = new Client(PG_CONFIG);
          await targetClient.connect();
          const queryPromise = targetClient.query("SELECT test_json_var();").catch(() => {});

          await debugExecutor.waitForTarget();

          // Step past both assignments
          await stepOver(debugExecutor); // j := '{"name": "alice", "age": 30}'
          await stepOver(debugExecutor); // j := j || '{"active": true}'

          const vars = await debugExecutor.getVariables();
          const jVar = vars.find((v) => v.value.name === "j");
          expect(jVar).toBeDefined();
          expect(jVar!.value.type).toBe("jsonb");
          const parsed = JSON.parse(jVar!.value.value);
          expect(parsed.name).toBe("alice");
          expect(parsed.age).toBe(30);
          expect(parsed.active).toBe(true);

          await stepContinue(debugExecutor);
          await queryPromise;
          await targetClient.end().catch(() => {});
        } finally {
          await debugExecutor.abort().catch(() => {});
          await debugExecutor.close().catch(() => {});
        }
      },
      DEBUG_INTEGRATION_TEST_TIMEOUT_MS,
    );

    it(
      "displays array of records",
      async () => {
        const debugListener = new Client(PG_CONFIG);
        await debugListener.connect();
        const debugExecutor = new PostgresDebugger(debugListener);

        try {
          await debugExecutor.createListener();
          const args = await debugExecutor.getCallArgs("public", "test_record_array");
          const oid = args[0].oid;
          await debugExecutor.setGlobalBreakpoint(oid);

          targetClient = new Client(PG_CONFIG);
          await targetClient.connect();
          const queryPromise = targetClient.query("SELECT test_record_array();").catch(() => {});

          await debugExecutor.waitForTarget();

          // Step through all assignments until arr has 2 records
          // r.id := 1; r.name := 'first'; r.active := true; arr := ARRAY[r];
          // r.id := 2; r.name := 'second'; r.active := false; arr := array_append(arr, r);
          for (let i = 0; i < 8; i++) {
            await stepOver(debugExecutor);
          }

          const vars = await debugExecutor.getVariables();
          const arrVar = vars.find((v) => v.value.name === "arr");
          expect(arrVar).toBeDefined();
          // Array of records should be JSON array of objects
          const parsed = JSON.parse(arrVar!.value.value);
          expect(parsed).toHaveLength(2);
          expect(parsed[0].id).toBe(1);
          expect(parsed[0].name).toBe("first");
          expect(parsed[0].active).toBe(true);
          expect(parsed[1].id).toBe(2);
          expect(parsed[1].name).toBe("second");
          expect(parsed[1].active).toBe(false);

          // Also verify the single record variable
          const rVar = vars.find((v) => v.value.name === "r");
          expect(rVar).toBeDefined();
          const rParsed = JSON.parse(rVar!.value.value);
          expect(rParsed.id).toBe(2);
          expect(rParsed.name).toBe("second");

          await stepContinue(debugExecutor);
          await queryPromise;
          await targetClient.end().catch(() => {});
        } finally {
          await debugExecutor.abort().catch(() => {});
          await debugExecutor.close().catch(() => {});
        }
      },
      DEBUG_INTEGRATION_TEST_TIMEOUT_MS,
    );
  });
});
