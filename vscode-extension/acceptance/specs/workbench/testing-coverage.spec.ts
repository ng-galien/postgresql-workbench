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

    await test.step("keep the existing Workbench index stable", async () => {
      expect((await vscode.inspectTestingState()).index).toEqual(baseline.index);
    });
  });
});
