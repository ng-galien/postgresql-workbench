import { DEBUG_PLAYWRIGHT_TEST_TIMEOUT_MS } from "../../../../../e2e/debugTestTiming.js";
import {
  demoConnectionTreeItem as connection,
  demoConnectionQuickPickItem as connectionChoice,
  demoDatabaseTreeItem as database,
} from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";
import { SCHEMAS_TREE_ITEM } from "../../pages/WorkbenchTreeLabels";

test.describe("PL/pgSQL debugger call sites", () => {
  test.describe.configure({ timeout: DEBUG_PLAYWRIGHT_TEST_TIMEOUT_MS });

  test.afterEach(async ({ debuggerPage }) => {
    await debuggerPage.expectNoActiveSession();
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
      await workbench.openRoutineSource(connection, database, /^playground/, /^call_double\(/);
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

    await test.step("inspect and export the captured result like any other rowset", async () => {
      await debuggerPage.useResultActions("11");
    });
  });

  test("navigates to the active routine editor across successive debug sessions", async ({
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
    await test.step("keep the routine available across repeated schema collapse and expansion", async () => {
      for (let cycle = 0; cycle < 3; cycle += 1) {
        const schema = await workbench.tree.expandPath([
          connection,
          database,
          SCHEMAS_TREE_ITEM,
          /^playground$/u,
        ]);
        const routine = await workbench.tree.findChild(schema, /^debug_tree_entry\(\)/u);
        await expect(routine).toBeVisible();
        await workbench.tree.collapseItem(schema, /^playground$/u);
      }
    });
    await workbench.debugRoutineFromTree(
      connection,
      database,
      /^playground/,
      /^debug_tree_entry\(\)/,
    );
    await debuggerPage.expectRoutineEditor(/^debug_tree_entry$/, /playground\.debug_tree_entry/);
    await debuggerPage.continueToCompletion("42");
    await debuggerPage.expectNoErrorNotification();
  });
});
