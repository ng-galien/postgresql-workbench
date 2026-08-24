import { writeFile } from "node:fs/promises";
import { test as base, type TestInfo } from "@playwright/test";
import { startWorkbench } from "../journeys/startup";
import { CockpitPage } from "../pages/CockpitPage";
import { DebuggerPage } from "../pages/DebuggerPage";
import { NotebookPage } from "../pages/NotebookPage";
import { SqlEditorPage } from "../pages/SqlEditorPage";
import { WorkbenchPage } from "../pages/WorkbenchPage";
import {
  type DemoDatabase,
  demoConnectionTreeItem as demoConnection,
  demoConnectionId,
  demoConnectionUrl,
  demoDatabaseTreeItem as demoDatabase,
  startDemoDatabase,
} from "./demoDatabase";
import { launchVSCode, type VSCodeInstance } from "./vscode";

interface AcceptanceFixtures {
  workbench: WorkbenchPage;
  cockpit: CockpitPage;
  debuggerPage: DebuggerPage;
  notebook: NotebookPage;
  sqlEditor: SqlEditorPage;
}

interface AcceptanceWorkerFixtures {
  demoDatabase: DemoDatabase;
  vscode: VSCodeInstance;
  indexedWorkbench: undefined;
}

async function attachTextArtifact(
  testInfo: TestInfo,
  name: string,
  body: string,
  contentType: string,
): Promise<void> {
  const artifactPath = testInfo.outputPath(name);
  await writeFile(artifactPath, body, "utf8");
  await testInfo.attach(name, { path: artifactPath, contentType });
}

export const test = base.extend<AcceptanceFixtures, AcceptanceWorkerFixtures>({
  demoDatabase: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture arguments to use object destructuring.
    async ({}, use) => {
      const demo = startDemoDatabase();
      try {
        if (process.env.PGWB_ACCEPTANCE_LANE === "schema-sync") {
          await demo.resetSchemaSyncFixture();
        }
        await use(demo);
      } finally {
        try {
          if (process.env.PGWB_ACCEPTANCE_LANE === "schema-sync") {
            await demo.resetSchemaSyncFixture();
          }
        } finally {
          demo.stop();
        }
      }
    },
    { scope: "worker", auto: true },
  ],
  vscode: [
    async ({ demoDatabase: _demoDatabase }, use) => {
      const instance = await launchVSCode();
      try {
        await use(instance);
      } finally {
        await instance.dispose();
      }
    },
    { scope: "worker", timeout: 90_000 },
  ],
  indexedWorkbench: [
    async ({ vscode }, use) => {
      const workbench = new WorkbenchPage(
        () => vscode.page,
        vscode.resizeWindow,
        vscode.resetWorkbenchUI,
        vscode.inspectWorkbenchState,
      );
      await workbench.reset();
      await workbench.scratchpads.collapseAll();
      await workbench.ensureConnection(demoConnectionUrl, demoConnection);
      await workbench.ensureDatabaseIndexed(demoConnection, demoDatabase);
      await use(undefined);
    },
    { scope: "worker", auto: true, timeout: 60_000 },
  ],
  workbench: async ({ indexedWorkbench: _indexedWorkbench, vscode }, use, testInfo) => {
    const workbench = new WorkbenchPage(
      () => vscode.page,
      vscode.resizeWindow,
      vscode.resetWorkbenchUI,
      vscode.inspectWorkbenchState,
    );
    await workbench.reset();
    await workbench.scratchpads.collapseAll();
    // Every scenario begins where the bootstrap scenario leaves a first-time workbench.
    await startWorkbench(workbench, vscode.inspectWorkbenchState, {
      connectionUrl: demoConnectionUrl,
      connectionId: demoConnectionId,
      connection: demoConnection,
      database: demoDatabase,
    });
    let cleanupError: Error | undefined;
    try {
      await use(workbench);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        const snapshot = await vscode.inspectWorkbenchState().catch((error) => ({
          diagnosticError: error instanceof Error ? error.message : String(error),
        }));
        await attachTextArtifact(
          testInfo,
          "workbench-state.json",
          JSON.stringify(snapshot, null, 2),
          "application/json",
        ).catch(() => {});
        await vscode.page
          .screenshot({ path: testInfo.outputPath("failure.png"), fullPage: true })
          .catch(() => {});
      }
      try {
        await workbench.reset();
        await workbench.scratchpads.collapseAll();
      } catch (error) {
        cleanupError = error instanceof Error ? error : new Error(String(error));
        await attachTextArtifact(
          testInfo,
          "cleanup-error.txt",
          cleanupError.stack ?? cleanupError.message,
          "text/plain",
        ).catch(() => {});
      }
    }
    if (cleanupError) throw cleanupError;
  },
  cockpit: async ({ vscode }, use) => {
    await use(new CockpitPage(() => vscode.page));
  },
  debuggerPage: async ({ vscode }, use) => {
    await use(
      new DebuggerPage(
        () => vscode.page,
        vscode.openWorkspaceFile,
        vscode.inspectDebugState,
        vscode.executeCommand,
      ),
    );
  },
  notebook: async ({ vscode }, use) => {
    await use(
      new NotebookPage(
        () => vscode.page,
        vscode.inspectActiveNotebook,
        () => vscode.executeCommand("postgresql-workbench.acceptance.closeActiveEditor"),
      ),
    );
  },
  sqlEditor: async ({ vscode }, use) => {
    await use(
      new SqlEditorPage(() => vscode.page, vscode.inspectActiveTextEditor, vscode.executeCommand),
    );
  },
});

export { expect } from "@playwright/test";
