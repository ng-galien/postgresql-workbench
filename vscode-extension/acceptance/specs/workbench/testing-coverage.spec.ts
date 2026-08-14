import { expect, test } from "../../fixtures/test";

const server = /postgres@localhost:5434/;
const database = /^demo/;

test.describe("pgTAP tests and coverage", () => {
  test("runs mapped pgTAP tests and publishes native PL/pgSQL coverage", async ({
    workbench,
    vscode,
  }) => {
    await workbench.expectActiveDatabaseIndexed(server, database);
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
      expect(Object.keys(state.run?.outcomes ?? {})).not.toHaveLength(0);
      expect(Object.values(state.run?.outcomes ?? {})).toEqual(expect.arrayContaining(["passed"]));
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
        server,
        database,
        /^playground/,
        /^fizzbuzz\(up_to: int4\)/,
      );
      await vscode.executeCommand("testing.openCoverage");
      await vscode.executeCommand("testing.toggleInlineCoverage");

      for (const sourceLine of [
        "word := CASE",
        "WHEN i % 15 = 0 THEN 'FizzBuzz'",
        "WHEN i % 3 = 0 THEN 'Fizz'",
        "WHEN i % 5 = 0 THEN 'Buzz'",
        "ELSE i::text",
        "END;",
      ]) {
        const line = workbench.page
          .locator(".monaco-editor:visible .view-line")
          .filter({ hasText: sourceLine })
          .first();
        await expect(line, `The covered ${sourceLine} line must be visible`).toBeVisible();
        const lineBox = await line.boundingBox();
        expect(
          lineBox,
          `The covered ${sourceLine} line must have screen coordinates`,
        ).not.toBeNull();
        await expect
          .poll(
            () =>
              workbench.page
                .locator(".monaco-editor:visible .coverage-deco-inline.coverage-deco-hit")
                .evaluateAll(
                  (decorations, y) =>
                    decorations.some((decoration) => {
                      const box = decoration.getBoundingClientRect();
                      return box.top <= y && box.bottom >= y;
                    }),
                  lineBox!.y + lineBox!.height / 2,
                ),
            { message: `The covered ${sourceLine} line must be highlighted by VS Code` },
          )
          .toBe(true);
      }
    });

    await test.step("keep the existing Workbench index stable", async () => {
      expect((await vscode.inspectTestingState()).index).toEqual(baseline.index);
    });
  });
});
