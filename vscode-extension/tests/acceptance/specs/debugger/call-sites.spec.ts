import { DEBUG_PLAYWRIGHT_TEST_TIMEOUT_MS } from "../../../../../e2e/debugTestTiming.js";
import {
  demoConnexionQuickPickItem as connectionChoice,
  demoDatabaseTreeItem as database,
  demoConnectionUrl,
  demoConnexionTreeItem as server,
} from "../../fixtures/demoDatabase";
import { test } from "../../fixtures/test";

test.describe("PL/pgSQL debugger call sites", () => {
  test.describe.configure({ timeout: DEBUG_PLAYWRIGHT_TEST_TIMEOUT_MS });

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
      await workbench.openRoutineSource(server, database, /^playground/, /^fib\(/);
      await debuggerPage.setBreakpoint(breakpoint);
      await debuggerPage.openCallSite("debug-fib.sql");
      await debuggerPage.assignConnection(sql, connectionChoice);
      await debuggerPage.start(sql, /^fib$/, /playground\.fib/, breakpoint);
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
      await workbench.openRoutineSource(server, database, /^playground/, /^call_double\(/);
      await debuggerPage.openCallSite("debug-call-chain.sql");
      await debuggerPage.assignConnection(sql, connectionChoice);
    });

    await test.step("stop on entry and prepare the return-to-caller breakpoint", async () => {
      await debuggerPage.start(sql, /call_double/, /playground\.call_double/, beforeCall);
      await debuggerPage.setBreakpoint(callerResume);
      await debuggerPage.stepOver(callerCall);
    });

    await test.step("step into the called function", async () => {
      await debuggerPage.stepInto(/^double_value$/, /playground\.double_value/, calleeStop);
    });

    await test.step("continue back to the user breakpoint in the caller", async () => {
      await debuggerPage.continueToStop(/^call_double$/, /playground\.call_double/, callerResume);
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
        sourceTab: /^double_value$/,
        routineSource: /playground\.double_value/,
        result: "8",
      },
      {
        sql: "SELECT playground.call_double(5);",
        sourceTab: /^call_double$/,
        routineSource: /playground\.call_double/,
        result: "11",
      },
    ];

    await workbench.ensureServer(demoConnectionUrl, server);
    await workbench.expectDatabaseIndexed(server, database);
    await debuggerPage.openCallSite("debug-successive.sql");
    for (const session of sessions) {
      await debuggerPage.assignConnection(session.sql, connectionChoice);
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
    await workbench.debugRoutineFromTree(server, database, /^playground/, /^debug_tree_entry\(\)/);
    await debuggerPage.expectRoutineEditor(/^debug_tree_entry$/, /playground\.debug_tree_entry/);
    await debuggerPage.continueToCompletion("42");
    await debuggerPage.expectNoErrorNotification();
  });
});
