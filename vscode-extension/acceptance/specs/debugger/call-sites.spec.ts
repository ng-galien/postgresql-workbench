import { demoConnectionUrl } from "../../fixtures/demoDatabase";
import { test } from "../../fixtures/test";

const server = /postgres@localhost:5434/;

test.describe("PL/pgSQL debugger call sites", () => {
  test.afterEach(async ({ debuggerPage }) => {
    await debuggerPage.expectNoActiveSession();
  });

  test("stops on every recursive Fibonacci result", async ({ workbench, debuggerPage }) => {
    const sql = "SELECT playground.fib(5);";
    const breakpoint = "RETURN result;";
    const recursiveReturns = [
      { n: "2", result: "1" },
      { n: "3", result: "2" },
      { n: "2", result: "1" },
      { n: "4", result: "3" },
      { n: "2", result: "1" },
      { n: "3", result: "2" },
      { n: "5", result: "5" },
    ];

    await test.step("set the recursive return breakpoint and launch from the call site", async () => {
      await workbench.ensureServer(demoConnectionUrl, server);
      await workbench.reindexActiveDatabase(server, /^demo/);
      await workbench.openRoutineSource(server, /^demo/, /^playground/, /^fib\(/);
      await debuggerPage.setBreakpoint(breakpoint);
      await debuggerPage.openCallSite("debug-fib.sql");
      await debuggerPage.assignConnection(sql, server);
      await debuggerPage.start(sql, /^fib\(n:int4\)/, /playground\.fib/, breakpoint);
      await debuggerPage.expectArgument("n", recursiveReturns[0].n);
      await debuggerPage.expectVariable("result", recursiveReturns[0].result);
    });

    await test.step("observe every theoretical post-order recursive return", async () => {
      for (const current of recursiveReturns.slice(1)) {
        await debuggerPage.continueToRecursiveReturn(breakpoint, current.n, current.result);
      }
    });

    await test.step("continue after the seventh return and complete the query", async () => {
      await debuggerPage.continueToCompletion("5");
      await debuggerPage.expectNoErrorNotification();
    });
  });

  for (const scenario of [
    {
      sql: "SELECT shop.restock_report(10);",
      tab: /^restock_report\(threshold:int4\)/,
      routineSource: /shop\.restock_report/,
      file: "debug-restock.sql",
    },
  ]) {
    test(`debugs ${scenario.sql}`, async ({ workbench, debuggerPage }) => {
      await test.step("connect and open the SQL call site", async () => {
        await workbench.ensureServer(demoConnectionUrl, server);
        await debuggerPage.openCallSite(scenario.file);
      });

      await test.step("assign the database through the visible CodeLens", async () => {
        await debuggerPage.assignConnection(scenario.sql, server);
      });

      await test.step("start from the visible Debug CodeLens and stop in the routine", async () => {
        await debuggerPage.start(scenario.sql, scenario.tab, scenario.routineSource);
      });

      await test.step("continue to termination and reveal the query result", async () => {
        await debuggerPage.continueToCompletion();
        await debuggerPage.expectNoErrorNotification();
      });
    });
  }

  test("continues from a called function back to its caller", async ({
    workbench,
    debuggerPage,
  }) => {
    const sql = "SELECT playground.call_double(5);";
    const beforeCall = "result := n;";
    const callerCall = "result := playground.double_value(result);";
    const calleeStop = "RETURN n * 2;";
    const callerResume = "result := result + 1;";

    await test.step("open the caller and its call site", async () => {
      await workbench.ensureServer(demoConnectionUrl, server);
      await workbench.reindexActiveDatabase(server, /^demo/);
      await workbench.openRoutineSource(server, /^demo/, /^playground/, /^call_double\(/);
      await debuggerPage.openCallSite("debug-call-chain.sql");
      await debuggerPage.assignConnection(sql, server);
    });

    await test.step("stop on entry and prepare the return-to-caller breakpoint", async () => {
      await debuggerPage.start(sql, /call_double/, /playground\.call_double/, beforeCall);
      await debuggerPage.setBreakpoint(callerResume);
      await debuggerPage.stepOver(callerCall);
    });

    await test.step("step into the called function", async () => {
      await debuggerPage.stepInto(/double_value/, /playground\.double_value/, calleeStop);
    });

    await test.step("continue back to the user breakpoint in the caller", async () => {
      await debuggerPage.continueToStop(/call_double/, /playground\.call_double/, callerResume);
    });

    await test.step("continue to the SQL result", async () => {
      await debuggerPage.continueToCompletion("11");
      await debuggerPage.expectNoErrorNotification();
    });
  });

  test("navigates to the active routine editor across successive debug sessions", async ({
    workbench,
    debuggerPage,
  }) => {
    const sessions = [
      {
        sql: "SELECT playground.double_value(4);",
        sourceTab: /^double_value\(n:int4\)/,
        routineSource: /playground\.double_value/,
        result: "8",
      },
      {
        sql: "SELECT playground.fib(3);",
        sourceTab: /^fib\(n:int4\)/,
        routineSource: /playground\.fib/,
        result: "2",
      },
      {
        sql: "SELECT playground.call_double(5);",
        sourceTab: /^call_double\(n:int4\)/,
        routineSource: /playground\.call_double/,
        result: "11",
      },
    ];

    await workbench.ensureServer(demoConnectionUrl, server);
    await debuggerPage.openCallSite("debug-successive.sql");
    for (const session of sessions) {
      await debuggerPage.assignConnection(session.sql, server);
    }

    for (const session of sessions) {
      await test.step(`activate the real source editor for ${session.sql}`, async () => {
        await debuggerPage.openCallSite("debug-successive.sql");
        await debuggerPage.start(session.sql, session.sourceTab, session.routineSource);
        await debuggerPage.continueToCompletion(session.result);
      });
    }
    await debuggerPage.expectNoErrorNotification();
  });

  test("starts a zero-argument function from the Workbench TreeView", async ({
    workbench,
    debuggerPage,
  }) => {
    await workbench.ensureServer(demoConnectionUrl, server);
    await workbench.reindexActiveDatabase(server, /^demo/);
    await workbench.debugRoutineFromTree(server, /^demo/, /^playground/, /^debug_tree_entry\(\)/);
    await debuggerPage.expectRoutineEditor(/^debug_tree_entry$/, /playground\.debug_tree_entry/);
    await debuggerPage.continueToCompletion("42");
    await debuggerPage.expectNoErrorNotification();
  });
});
