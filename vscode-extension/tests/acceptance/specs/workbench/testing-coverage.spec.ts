import {
  demoConnectionTreeItem as connection,
  demoConnectionQuickPickItem as connectionChoice,
  demoDatabaseTreeItem as database,
  demoConnectionId,
} from "../../fixtures/demoDatabase";
import { expect, test } from "../../fixtures/test";
import type { DebugConfigurationSnapshot } from "../../fixtures/vscode";

const demoPgTapTests = [
  "test_fibonacci",
  "test_order_rejection",
  "test_place_order_workflow",
  "test_roman_numerals",
  "test_sequence_algorithms",
  "test_set_returning_functions",
  "test_stock_queries",
] as const;

function expectEveryDemoPgTapTestPassed(
  outcomes: Record<string, string> | undefined,
  options: { allowUnmappedCoverage?: boolean } = {},
): void {
  const entries = Object.entries(outcomes ?? {});
  expect(entries.length).toBeGreaterThanOrEqual(demoPgTapTests.length);
  const unmappedCoverage = entries.filter(
    ([id, outcome]) => id.endsWith(":source:unmapped") && outcome === "skipped",
  );
  const nonPassed = entries.filter(
    ([id, outcome]) =>
      outcome !== "passed" &&
      !(options.allowUnmappedCoverage && id.endsWith(":source:unmapped") && outcome === "skipped"),
  );
  expect(nonPassed, "Every mapped pgTAP outcome must pass").toEqual([]);
  expect(
    unmappedCoverage.map(
      ([id]) => /\/function:([^/(]+)\([^)]*\):source:/u.exec(decodeURIComponent(id))?.[1],
    ),
  ).toEqual(options.allowUnmappedCoverage ? ["test_place_order_workflow"] : []);
  const discovered = [
    ...new Set(
      entries.map(
        ([id]) => /\/function:([^/(]+)\([^)]*\):source:/u.exec(decodeURIComponent(id))?.[1],
      ),
    ),
  ].sort();
  expect(discovered).toEqual([...demoPgTapTests].sort());
}

test.describe("pgTAP tests and coverage", () => {
  test.afterEach(async ({ debuggerPage }) => {
    await debuggerPage.expectNoActiveSession();
  });

  test("runs mapped pgTAP coverage and clears it before every PL/pgSQL debugger startup", async ({
    workbench,
    vscode,
    debuggerPage,
  }) => {
    test.setTimeout(150_000);
    let persistedDebugConfiguration: DebugConfigurationSnapshot | undefined;
    const baseline = await vscode.inspectTestingState();

    await test.step("open VS Code Testing", async () => {
      await vscode.executeCommand("workbench.view.testing.focus");
    });

    await test.step("run all tests through VS Code Testing", async () => {
      await vscode.executeCommand("testing.runAll", 30_000);
      await expect
        .poll(async () => (await vscode.inspectTestingState()).run?.sequence, {
          timeout: 30_000,
        })
        .toBe((baseline.run?.sequence ?? 0) + 1);
      const state = await vscode.inspectTestingState();
      expectEveryDemoPgTapTestPassed(state.run?.outcomes);
    });

    await test.step("run all tests with coverage through VS Code Testing", async () => {
      await vscode.executeCommand("testing.coverageAll", 30_000);
      await expect
        .poll(async () => (await vscode.inspectTestingState()).coverage?.sequence, {
          timeout: 30_000,
        })
        .toBe((baseline.coverage?.sequence ?? 0) + 1);
    });

    await test.step("verify the mapped routine coverage published through VS Code", async () => {
      const coverage = (await vscode.inspectTestingState()).coverage;
      expect(coverage).toBeDefined();
      expectEveryDemoPgTapTestPassed(coverage?.outcomes, { allowUnmappedCoverage: true });
      const source = coverage?.files.find(({ uri }) => uri.includes("restock_report"));
      expect(source).toBeDefined();
      expect(source?.statement.total).toBeGreaterThan(0);
      expect(source?.statement.covered).toBeGreaterThan(0);
      expect(source?.branch?.total ?? 0).toBeGreaterThan(0);
      expect(source?.branch?.covered ?? 0).toBeGreaterThan(0);
    });

    await test.step("highlight every covered line of a multiline CASE expression", async () => {
      await vscode.executeCommand("postgresql-workbench-connections.focus");
      await workbench.openRoutineSource(
        connection,
        database,
        /^playground/,
        /^fizzbuzz\(up_to: int4\)/,
      );
      await vscode.executeCommand("testing.openCoverage");
      await vscode.executeCommand("testing.toggleInlineCoverage");

      const expectedCaseBlock = [
        "word := CASE",
        "WHEN i % 15 = 0 THEN 'FizzBuzz'",
        "WHEN i % 3 = 0 THEN 'Fizz'",
        "WHEN i % 5 = 0 THEN 'Buzz'",
        "ELSE i::text",
        "END;",
      ];
      await expect
        .poll(
          () =>
            workbench.page
              .locator(".editor-group-container.active .monaco-editor:visible")
              .evaluateAll((editors, expectedLines) => {
                const normalize = (value: string | null) =>
                  (value ?? "").replace(/\s+/gu, " ").trim();

                return editors.some((editor) => {
                  const coveredLineOffsets = new Set(
                    [...editor.querySelectorAll(".coverage-deco-inline.coverage-deco-hit")].map(
                      (decoration) => (decoration.parentElement as HTMLElement | null)?.offsetTop,
                    ),
                  );
                  const lines = [...editor.querySelectorAll<HTMLElement>(".view-line")];
                  return lines.some((_, start) =>
                    expectedLines.every((expected, offset) => {
                      const line = lines[start + offset];
                      return (
                        line !== undefined &&
                        normalize(line.textContent).includes(expected) &&
                        coveredLineOffsets.has(line.offsetTop)
                      );
                    }),
                  );
                });
              }, expectedCaseBlock),
          {
            message: "Every CASE, WHEN, ELSE, and END line must be highlighted by VS Code coverage",
          },
        )
        .toBe(true);
    });

    await test.step("keep the existing Workbench index stable", async () => {
      expect((await vscode.inspectTestingState()).index).toEqual(baseline.index);
    });

    await test.step("prove coverage on the exact routine before the debugger transition", async () => {
      const coverage = (await vscode.inspectTestingState()).coverage;
      const coveredRoutine = coverage?.files.find(({ uri }) => uri.includes("restock_report"));
      expect(coveredRoutine, "Coverage must include shop.restock_report").toBeDefined();
      expect(coveredRoutine?.statement.covered ?? 0).toBeGreaterThan(0);
      await vscode.executeCommand("postgresql-workbench-connections.focus");
      await workbench.openRoutineSource(
        connection,
        database,
        /^shop/u,
        /^restock_report\(threshold: int4\)/u,
      );
      await expect(
        workbench.page.locator(
          ".editor-group-container.active .monaco-editor:visible .coverage-deco-inline",
        ),
      ).not.toHaveCount(0, { timeout: 5_000 });
    });

    await test.step("start the covered routine without retaining coverage decorations", async () => {
      const sql = "SELECT shop.restock_report(10);";
      await debuggerPage.openCallSite("debug-restock.sql");
      await debuggerPage.assignConnection(sql, connectionChoice);
      await debuggerPage.start(sql, /^restock_report$/, /shop\.restock_report/);
      await debuggerPage.expectNoCoverageDecorations();
      await debuggerPage.continueToCompletion();
      await debuggerPage.expectNoErrorNotification();
    });

    await test.step("publish coverage again before the persisted native relaunch", async () => {
      const configurations = await vscode.inspectDebugConfigurations();
      persistedDebugConfiguration = configurations.find(
        ({ name, type }) => name === "Debug shop.restock_report" && type === "postgresql-workbench",
      );
      expect(persistedDebugConfiguration).toMatchObject({
        name: "Debug shop.restock_report",
        request: "launch",
        connection: demoConnectionId,
        stopOnEntry: true,
        type: "postgresql-workbench",
      });
      expect(persistedDebugConfiguration?.sql).toMatch(/^SELECT shop\.restock_report\(10\);?$/u);
      const previousSequence = (await vscode.inspectTestingState()).coverage?.sequence ?? 0;
      await vscode.executeCommand("testing.coverageAll", 30_000);
      await expect
        .poll(async () => (await vscode.inspectTestingState()).coverage?.sequence, {
          timeout: 30_000,
        })
        .toBe(previousSequence + 1);
      await debuggerPage.expectActiveRoutineSource(/^restock_report$/, /shop\.restock_report/);
      await vscode.executeCommand("testing.openCoverage");
      await expect(
        workbench.page.locator(
          ".editor-group-container.active .monaco-editor:visible .coverage-deco-inline",
        ),
      ).not.toHaveCount(0, { timeout: 5_000 });
    });

    await test.step("relaunch the persisted configuration through VS Code", async () => {
      expect(persistedDebugConfiguration).toBeDefined();
      await vscode.executeCommand(
        "postgresql-workbench.acceptance.startDebugConfiguration",
        20_000,
        [persistedDebugConfiguration],
      );
      await debuggerPage.expectRoutineEditor(/^restock_report$/, /shop\.restock_report/);
      await debuggerPage.expectNoCoverageDecorations();
      await debuggerPage.continueToCompletion();
      await debuggerPage.expectNoErrorNotification();
    });
  });
});
