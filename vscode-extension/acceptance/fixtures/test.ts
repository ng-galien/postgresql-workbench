import { test as base } from "@playwright/test";
import { CockpitPage } from "../pages/CockpitPage";
import { DebuggerPage } from "../pages/DebuggerPage";
import { NotebookPage } from "../pages/NotebookPage";
import { WorkbenchPage } from "../pages/WorkbenchPage";
import { type DemoDatabase, demoConnectionUrl, startDemoDatabase } from "./demoDatabase";
import { launchVSCode, type VSCodeInstance } from "./vscode";

const demoServer = /postgres@localhost:5434/;
const demoDatabase = /^demo/;

interface AcceptanceFixtures {
  workbench: WorkbenchPage;
  cockpit: CockpitPage;
  debuggerPage: DebuggerPage;
  notebook: NotebookPage;
}

interface AcceptanceWorkerFixtures {
  demoDatabase: DemoDatabase;
  vscode: VSCodeInstance;
  indexedWorkbench: undefined;
}

export const test = base.extend<AcceptanceFixtures, AcceptanceWorkerFixtures>({
  demoDatabase: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture arguments to use object destructuring.
    async ({}, use) => {
      const demo = startDemoDatabase();
      try {
        await use(demo);
      } finally {
        demo.stop();
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
        vscode.page,
        vscode.resizeWindow,
        vscode.resetWorkbenchUI,
      );
      await workbench.reset();
      await workbench.ensureServer(demoConnectionUrl, demoServer);
      await workbench.ensureActiveDatabaseIndexed(demoServer, demoDatabase);
      await use(undefined);
    },
    { scope: "worker", auto: true, timeout: 60_000 },
  ],
  workbench: async ({ indexedWorkbench: _indexedWorkbench, vscode }, use, testInfo) => {
    const workbench = new WorkbenchPage(vscode.page, vscode.resizeWindow, vscode.resetWorkbenchUI);
    await workbench.reset();
    try {
      await use(workbench);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        await vscode.page
          .screenshot({ path: testInfo.outputPath("failure.png"), fullPage: true })
          .catch(() => {});
      }
      await workbench.reset();
    }
  },
  cockpit: async ({ vscode }, use) => {
    await use(new CockpitPage(vscode.page));
  },
  debuggerPage: async ({ vscode }, use) => {
    await use(
      new DebuggerPage(
        vscode.page,
        vscode.openWorkspaceFile,
        vscode.inspectDebugState,
        vscode.executeCommand,
      ),
    );
  },
  notebook: async ({ vscode }, use) => {
    await use(new NotebookPage(vscode.page, vscode.inspectActiveNotebook));
  },
});

export { expect } from "@playwright/test";
