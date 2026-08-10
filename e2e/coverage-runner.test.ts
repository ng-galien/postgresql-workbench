import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CoverageCancelledError,
  type CoverageClientFactory,
  CoverageRoutineUnavailableError,
  CoverageRunIdBusyError,
  CoverageRunner,
  type CoverageStatusListener,
  type CoverageSyntaxService,
  CoverageTargetBusyError,
  type CoverageTestClient,
  type CoverageTestReport,
  CoverageTimeoutError,
  CoverageTransactionControlError,
  createCoverageSyntaxService,
  PgTapUnavailableError,
} from "../src/coverage/index.js";
import { type CodeMonikerTestRuntime, startCodeMonikerTestRuntime } from "./codeMonikerRuntime.js";

const PG_CONFIG = {
  host: "127.0.0.1",
  port: 5433,
  database: "testdb",
  user: "postgres",
  password: "postgres",
};

const CONNECTION_ID = "e2e-postgres-17";
let codeMoniker: CodeMonikerTestRuntime | undefined;

beforeAll(async () => {
  codeMoniker = await startCodeMonikerTestRuntime();
}, 30_000);

afterAll(async () => {
  await codeMoniker?.dispose();
});

function coverageRunner(
  openClient: CoverageClientFactory = openTestClient,
  onStatus?: CoverageStatusListener,
  syntax: CoverageSyntaxService = coverageSyntax(),
): CoverageRunner {
  return new CoverageRunner(openClient, syntax, onStatus);
}

function coverageSyntax(): CoverageSyntaxService {
  const runtime = codeMoniker;
  if (!runtime) throw new Error("Code Moniker test runtime is not initialized");
  return createCoverageSyntaxService(async () => runtime.parser);
}

describe("e2e: transactional coverage runner", () => {
  it("collects pgTAP coverage and restores the exact routine definition", async () => {
    const oid = await routineOid("public.coverage_subject(integer)");
    const before = await routineDdl(oid);
    const statuses: Array<{
      state: string;
      testSchema?: string;
      routine?: { schema: string; name: string; identityArguments: string };
    }> = [];
    const runner = coverageRunner(openTestClient, (status) => statuses.push(status));

    const result = await runner.run({
      connectionId: CONNECTION_ID,
      routineOid: oid,
      testSchema: "public_ut",
      executeTests: runCoverageTapFunction,
    });

    expect(result.tests).toMatchObject({ passed: 4, failed: 0, total: 4 });
    expect(result.state).toBe("completed");
    expect(result.routine.identityArguments).toBe("value integer");
    expect(result.coverage.statement.covered).toBe(result.coverage.statement.total);
    expect(result.coverage.branch.covered).toBe(result.coverage.branch.total);
    expect(result.coverage.points.some(({ executed }) => executed > 1)).toBe(true);
    expect(result.coverage.points).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          point: expect.objectContaining({ kind: "statement", label: "for" }),
          executed: expect.any(Number),
        }),
        expect.objectContaining({
          point: expect.objectContaining({
            kind: "branch",
            label: expect.stringMatching(/^loop enter @/),
          }),
          executed: expect.any(Number),
        }),
        expect.objectContaining({
          point: expect.objectContaining({
            kind: "branch",
            label: expect.stringMatching(/^loop exit @/),
          }),
          executed: expect.any(Number),
        }),
      ]),
    );
    const forStatement = result.coverage.points.find(
      ({ point }) => point.kind === "statement" && point.label === "for",
    );
    expect(forStatement?.executed).toBeGreaterThan(0);
    expect(await routineDdl(oid)).toBe(before);
    expect(runner.activeStatuses).toEqual([]);
    expect(statuses.map(({ state }) => state)).toEqual([
      "preparing",
      "transaction-open",
      "instrumenting",
      "running-tests",
      "collecting",
      "rolling-back",
      "completed",
    ]);
    expect(statuses.find(({ state }) => state === "running-tests")).toMatchObject({
      testSchema: "public_ut",
      routine: {
        schema: "public",
        name: "coverage_subject",
        identityArguments: "value integer",
      },
    });
  });

  it("instruments a routine set once and executes the selected suite once", async () => {
    const subjectOid = await routineOid("public.coverage_subject(integer)");
    const wrapperOid = await routineOid("public.coverage_wrapper(integer)");
    const before = new Map([
      [subjectOid, await routineDdl(subjectOid)],
      [wrapperOid, await routineDdl(wrapperOid)],
    ]);
    let suiteExecutions = 0;
    const runner = coverageRunner(openTestClient);

    const result = await runner.runSuite({
      connectionId: CONNECTION_ID,
      routineOids: [wrapperOid, subjectOid, wrapperOid],
      testSchema: "public_it",
      executeTests: async (client) => {
        suiteExecutions++;
        const tap = await client.query<Record<string, string>>(
          "SELECT * FROM public_it.test_coverage_integration()",
        );
        return tapReport(tap.rows.flatMap((row) => Object.values(row)));
      },
    });

    expect(suiteExecutions).toBe(1);
    expect(result.routines.map(({ routine }) => routine.oid)).toEqual([subjectOid, wrapperOid]);
    expect(result.routines).toHaveLength(2);
    expect(result.routines.every(({ coverage }) => coverage.statement.covered > 0)).toBe(true);
    expect(result.tests).toMatchObject({ passed: 1, failed: 0, total: 1 });
    expect(await routineDdl(subjectOid)).toBe(before.get(subjectOid));
    expect(await routineDdl(wrapperOid)).toBe(before.get(wrapperOid));
  });

  it("returns coverage alongside failed pgTAP assertions", async () => {
    const oid = await routineOid("public.coverage_subject(integer)");
    const runner = coverageRunner(openTestClient);

    const result = await runner.run({
      connectionId: CONNECTION_ID,
      routineOid: oid,
      executeTests: async (client) => {
        await client.query("SELECT plan(1)");
        const assertion = await client.query<{ tap: string }>(
          "SELECT is(public.coverage_subject(3), 999, 'intentional failure') AS tap",
        );
        await client.query("SELECT * FROM finish()");
        return tapReport(assertion.rows.map(({ tap }) => tap));
      },
    });

    expect(result.tests).toMatchObject({ passed: 0, failed: 1, total: 1 });
    expect(result.coverage.statement.covered).toBeGreaterThan(0);
    expect(result.coverage.branch.covered).toBeGreaterThan(0);
  });

  it("rolls back instrumentation when test SQL fails", async () => {
    const oid = await routineOid("public.coverage_subject(integer)");
    const before = await routineDdl(oid);
    const runner = coverageRunner(openTestClient);

    await expect(
      runner.run({
        connectionId: CONNECTION_ID,
        routineOid: oid,
        executeTests: async (client) => {
          await client.query("SELECT coverage_function_that_does_not_exist()");
          return emptyReport();
        },
      }),
    ).rejects.toThrow(/does not exist/);

    expect(await routineDdl(oid)).toBe(before);
  });

  it("refuses transaction control from test callbacks and rolls back instrumentation", async () => {
    const oid = await routineOid("public.coverage_subject(integer)");
    const before = await routineDdl(oid);
    const runner = coverageRunner(openTestClient);

    await expect(
      runner.run({
        connectionId: CONNECTION_ID,
        routineOid: oid,
        executeTests: async (client) => {
          await client.query("SELECT public.coverage_subject(3); COMMIT");
          return emptyReport();
        },
      }),
    ).rejects.toBeInstanceOf(CoverageTransactionControlError);

    expect(await routineDdl(oid)).toBe(before);
    expect(before).not.toContain("postgresql-workbench-cov:");
  });

  it("does not let a failing status observer interrupt rollback or cleanup", async () => {
    const oid = await routineOid("public.coverage_subject(integer)");
    const before = await routineDdl(oid);
    const runner = coverageRunner(openTestClient, () => {
      throw new Error("UI observer failed");
    });

    const result = await runner.run({
      connectionId: CONNECTION_ID,
      routineOid: oid,
      executeTests: async (client) => {
        await client.query("SELECT public.coverage_subject(3)");
        return emptyReport();
      },
    });

    expect(result.coverage.statement.covered).toBeGreaterThan(0);
    expect(await routineDdl(oid)).toBe(before);
    expect(runner.activeStatuses).toEqual([]);
  });

  it("cancels a running test backend and rolls back instrumentation", async () => {
    const oid = await routineOid("public.coverage_subject(integer)");
    const before = await routineDdl(oid);
    const controller = new AbortController();
    const states: string[] = [];
    const runner = coverageRunner(openTestClient, ({ state }) => states.push(state));

    const run = runner.run({
      connectionId: CONNECTION_ID,
      routineOid: oid,
      signal: controller.signal,
      executeTests: async (client) => {
        setTimeout(() => controller.abort(), 50);
        await client.query("SELECT pg_sleep(30)");
        return emptyReport();
      },
    });

    await expect(run).rejects.toBeInstanceOf(CoverageCancelledError);
    expect(await routineDdl(oid)).toBe(before);
    expect(runner.activeStatuses).toEqual([]);
    expect(states.at(-1)).toBe("cancelled");
  });

  it("disconnects the dedicated backend when graceful cancellation is unavailable", async () => {
    const oid = await routineOid("public.coverage_subject(integer)");
    const before = await routineDdl(oid);
    const controller = new AbortController();
    let opened = 0;
    const runner = coverageRunner(async () => {
      opened++;
      if (opened === 2) throw new Error("control connection unavailable");
      return openTestClient();
    });

    const run = runner.run({
      connectionId: CONNECTION_ID,
      routineOid: oid,
      signal: controller.signal,
      executeTests: async (client) => {
        setTimeout(() => controller.abort(), 50);
        await client.query("SELECT pg_sleep(30)");
        return emptyReport();
      },
    });

    await expect(run).rejects.toMatchObject({
      name: "CoverageCancelledError",
      message: expect.stringContaining("dedicated backend was disconnected"),
    });
    expect(await routineDdl(oid)).toBe(before);
  });

  it("rejects a concurrent runner for the same routine across runner instances", async () => {
    const oid = await routineOid("public.coverage_subject(integer)");
    const controller = new AbortController();
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const first = coverageRunner(openTestClient);
    const second = coverageRunner(openTestClient);
    const firstRun = first.run({
      connectionId: CONNECTION_ID,
      routineOid: oid,
      signal: controller.signal,
      executeTests: async (client) => {
        notifyStarted?.();
        await client.query("SELECT pg_sleep(30)");
        return emptyReport();
      },
    });
    const firstOutcome = settle(firstRun);
    await started;
    const safetyAbort = setTimeout(() => controller.abort(), 1_000);
    try {
      const secondOutcome = await settle(
        second.run({
          connectionId: CONNECTION_ID,
          routineOid: oid,
          executeTests: async () => emptyReport(),
        }),
      );
      expect(secondOutcome.error).toBeInstanceOf(CoverageTargetBusyError);
    } finally {
      clearTimeout(safetyAbort);
      controller.abort();
      expect((await firstOutcome).error).toBeInstanceOf(CoverageCancelledError);
    }
  });

  it("admits caller-defined run IDs only once across different targets", async () => {
    const integerOid = await routineOid("public.coverage_subject(integer)");
    const textOid = await routineOid("public.coverage_subject(text)");
    const controller = new AbortController();
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const runner = coverageRunner(openTestClient);
    const firstRun = runner.run({
      connectionId: CONNECTION_ID,
      routineOid: integerOid,
      runId: "shared-run-id",
      signal: controller.signal,
      executeTests: async () => {
        notifyStarted?.();
        await new Promise<never>(() => {});
      },
    });
    const firstOutcome = settle(firstRun);
    await started;

    const secondOutcome = await settle(
      runner.run({
        connectionId: CONNECTION_ID,
        routineOid: textOid,
        runId: "shared-run-id",
        executeTests: async () => emptyReport(),
      }),
    );
    expect(secondOutcome.error).toBeInstanceOf(CoverageRunIdBusyError);

    controller.abort();
    expect((await firstOutcome).error).toBeInstanceOf(CoverageCancelledError);
  });

  it("times out callbacks that ignore abort and cleans up the target", async () => {
    const oid = await routineOid("public.coverage_subject(integer)");
    const before = await routineDdl(oid);
    const states: string[] = [];
    const runner = coverageRunner(openTestClient, ({ state }) => states.push(state));

    await expect(
      runner.run({
        connectionId: CONNECTION_ID,
        routineOid: oid,
        timeoutMs: 75,
        executeTests: async () => new Promise<never>(() => {}),
      }),
    ).rejects.toBeInstanceOf(CoverageTimeoutError);

    expect(await routineDdl(oid)).toBe(before);
    expect(states.at(-1)).toBe("timed-out");
    expect(runner.activeStatuses).toEqual([]);
  });

  it("applies the run timeout while syntax analysis is pending", async () => {
    const oid = await routineOid("public.coverage_subject(integer)");
    const runner = coverageRunner(openTestClient, undefined, {
      ...coverageSyntax(),
      async analyze() {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return {
          analysis: { points: [], diagnostics: [] },
          procedureTransactionControl: false,
        };
      },
    });
    const startedAt = Date.now();

    await expect(
      runner.run({
        connectionId: CONNECTION_ID,
        routineOid: oid,
        timeoutMs: 30,
        executeTests: async () => emptyReport(),
      }),
    ).rejects.toBeInstanceOf(CoverageTimeoutError);

    expect(Date.now() - startedAt).toBeLessThan(180);
    expect(runner.activeStatuses).toEqual([]);
  });

  it("terminates a backend whose PL/pgSQL command catches query cancellation", async () => {
    const oid = await routineOid("public.coverage_subject(integer)");
    const before = await routineDdl(oid);
    const runner = coverageRunner(openTestClient);
    const startedAt = Date.now();

    await expect(
      runner.run({
        connectionId: CONNECTION_ID,
        routineOid: oid,
        timeoutMs: 100,
        executeTests: async (client) => {
          await client.query(`
            DO $$
            BEGIN
              BEGIN
                PERFORM pg_sleep(30);
              EXCEPTION WHEN query_canceled THEN
                PERFORM pg_sleep(30);
              END;
            END
            $$`);
          return emptyReport();
        },
      }),
    ).rejects.toBeInstanceOf(CoverageTimeoutError);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(await routineDdl(oid)).toBe(before);
  });

  it("refuses callback queries issued after cancellation", async () => {
    const oid = await routineOid("public.coverage_subject(integer)");
    const controller = new AbortController();
    const runner = coverageRunner(openTestClient);
    let followupError: unknown;

    const run = runner.run({
      connectionId: CONNECTION_ID,
      routineOid: oid,
      signal: controller.signal,
      executeTests: async (client) => {
        setTimeout(() => controller.abort(), 50);
        try {
          await client.query("SELECT pg_sleep(30)");
        } catch {}
        try {
          await client.query("SELECT 1");
        } catch (error) {
          followupError = error;
        }
        return emptyReport();
      },
    });

    await expect(run).rejects.toBeInstanceOf(CoverageCancelledError);
    expect(followupError).toBeInstanceOf(CoverageCancelledError);
  });

  it("selects overloaded routines by OID", async () => {
    const integerOid = await routineOid("public.coverage_subject(integer)");
    const textOid = await routineOid("public.coverage_subject(text)");
    const integerBefore = await routineDdl(integerOid);
    const textBefore = await routineDdl(textOid);
    const runner = coverageRunner(openTestClient);

    const result = await runner.run({
      connectionId: CONNECTION_ID,
      routineOid: textOid,
      executeTests: async (client) => {
        const value = await client.query<{ value: string }>(
          "SELECT public.coverage_subject('selected'::text) AS value",
        );
        expect(value.rows[0]?.value).toBe("SELECTED");
        return emptyReport();
      },
    });

    expect(result.routine.oid).toBe(textOid);
    expect(result.routine.identityArguments).toBe("value text");
    expect(await routineDdl(integerOid)).toBe(integerBefore);
    expect(await routineDdl(textOid)).toBe(textBefore);
  });

  it("ignores warnings that do not belong to the active run", async () => {
    const oid = await routineOid("public.coverage_subject(text)");
    const runner = coverageRunner(openTestClient);

    const result = await runner.run({
      connectionId: CONNECTION_ID,
      routineOid: oid,
      runId: "active-run",
      executeTests: async (client) => {
        await client.query(
          "DO $$ BEGIN RAISE WARNING 'postgresql-workbench-cov:another-run:p0'; END $$",
        );
        return emptyReport();
      },
    });

    expect(result.coverage.statement.covered).toBe(0);
    expect(result.coverage.branch.covered).toBe(0);
  });

  it("instruments only the selected routine when it calls another PL/pgSQL routine", async () => {
    const wrapperOid = await routineOid("public.coverage_wrapper(integer)");
    const subjectOid = await routineOid("public.coverage_subject(integer)");
    const subjectBefore = await routineDdl(subjectOid);
    const runner = coverageRunner(openTestClient);

    const result = await runner.run({
      connectionId: CONNECTION_ID,
      routineOid: wrapperOid,
      executeTests: async (client) => {
        await client.query("SELECT public.coverage_wrapper(3)");
        return emptyReport();
      },
    });

    expect(result.routine.name).toBe("coverage_wrapper");
    expect(result.coverage.points.every(({ executed }) => executed === 1)).toBe(true);
    expect(await routineDdl(subjectOid)).toBe(subjectBefore);
  });

  it("uses a dedicated backend rather than the extension query client", async () => {
    const oid = await routineOid("public.coverage_subject(text)");
    const extensionClient = await openTestClient();
    const extensionPid = await backendPid(extensionClient);
    try {
      const runner = coverageRunner(openTestClient);
      let coveragePid = 0;
      await runner.run({
        connectionId: CONNECTION_ID,
        routineOid: oid,
        executeTests: async (client) => {
          coveragePid = await backendPid(client);
          return emptyReport();
        },
      });

      expect(coveragePid).toBeGreaterThan(0);
      expect(coveragePid).not.toBe(extensionPid);
    } finally {
      await extensionClient.end();
    }
  });

  it("fails clearly when pgTAP is absent from the selected database", async () => {
    const runner = coverageRunner(() => openClient({ ...PG_CONFIG, database: "postgres" }));

    await expect(
      runner.run({
        connectionId: "postgres-without-pgtap",
        routineOid: 1,
        executeTests: async () => emptyReport(),
      }),
    ).rejects.toBeInstanceOf(PgTapUnavailableError);
  });

  it("rejects routines not owned by the connected role", async () => {
    const oid = await routineOid("public.coverage_subject(integer)");
    const runner = coverageRunner(openCoverageReaderClient);

    await expect(
      runner.run({
        connectionId: "coverage-reader",
        routineOid: oid,
        executeTests: async () => emptyReport(),
      }),
    ).rejects.toThrow(/does not own the routine/);
  });

  it("rejects procedures containing transaction control", async () => {
    const oid = await routineOid("public.coverage_transaction_procedure()");
    const runner = coverageRunner(openTestClient);

    await expect(
      runner.run({
        connectionId: CONNECTION_ID,
        routineOid: oid,
        executeTests: async () => emptyReport(),
      }),
    ).rejects.toBeInstanceOf(CoverageRoutineUnavailableError);
  });

  it("bounds DDL lock waits and leaves the routine unchanged", async () => {
    const oid = await routineOid("public.coverage_subject(integer)");
    const before = await routineDdl(oid);
    const blocker = await openTestClient();
    await blocker.query("BEGIN");
    await blocker.query(before);
    try {
      const runner = coverageRunner(openTestClient);
      await expect(
        runner.run({
          connectionId: CONNECTION_ID,
          routineOid: oid,
          lockTimeoutMs: 100,
          executeTests: async () => emptyReport(),
        }),
      ).rejects.toThrow(/lock timeout|canceling statement/i);
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.end();
    }
    expect(await routineDdl(oid)).toBe(before);
  });

  it("relies on PostgreSQL to roll back after an abrupt coverage connection loss", async () => {
    const oid = await routineOid("public.coverage_subject(integer)");
    const before = await routineDdl(oid);
    const runner = coverageRunner(openTestClient);

    await expect(
      runner.run({
        connectionId: CONNECTION_ID,
        routineOid: oid,
        executeTests: async (client) => {
          await client.query("SELECT pg_terminate_backend(pg_backend_pid())");
          return emptyReport();
        },
      }),
    ).rejects.toThrow();

    expect(await routineDdl(oid)).toBe(before);
  });
});

async function openTestClient(): Promise<Client> {
  return openClient(PG_CONFIG);
}

async function openCoverageReaderClient(): Promise<Client> {
  const client = await openTestClient();
  await client.query("SET ROLE coverage_reader");
  return client;
}

async function openClient(config: typeof PG_CONFIG): Promise<Client> {
  const client = new Client(config);
  await client.connect();
  return client;
}

async function routineOid(signature: string): Promise<number> {
  const client = await openTestClient();
  try {
    const result = await client.query<{ oid: number }>("SELECT $1::regprocedure::oid::int AS oid", [
      signature,
    ]);
    return result.rows[0]?.oid ?? 0;
  } finally {
    await client.end();
  }
}

async function routineDdl(oid: number): Promise<string> {
  const client = await openTestClient();
  try {
    const result = await client.query<{ ddl: string }>(
      "SELECT pg_get_functiondef($1::oid) AS ddl",
      [oid],
    );
    return result.rows[0]?.ddl ?? "";
  } finally {
    await client.end();
  }
}

async function backendPid(client: CoverageTestClient): Promise<number> {
  const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return result.rows[0]?.pid ?? 0;
}

async function runCoverageTapFunction(client: CoverageTestClient): Promise<CoverageTestReport> {
  const result = await client.query<Record<string, string>>(
    "SELECT * FROM public_ut.test_coverage_subject()",
  );
  return tapReport(result.rows.flatMap((row) => Object.values(row)));
}

function tapReport(lines: readonly string[]): CoverageTestReport {
  const tests = lines.flatMap((line) => {
    const match = /^(not )?ok\s+\d+\s*-\s*([^\n]+)/i.exec(line);
    if (!match) return [];
    return [
      {
        name: match[2],
        passed: match[1] === undefined,
        message: match[1] === undefined ? undefined : line,
      },
    ];
  });
  const passed = tests.filter((test) => test.passed).length;
  return {
    passed,
    failed: tests.length - passed,
    total: tests.length,
    tests,
  };
}

function emptyReport(): CoverageTestReport {
  return { passed: 0, failed: 0, total: 0, tests: [] };
}

async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}
