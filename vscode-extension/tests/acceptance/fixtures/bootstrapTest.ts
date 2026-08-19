import { test as base } from "@playwright/test";
import { WorkbenchPage } from "../pages/WorkbenchPage";
import { type DemoDatabase, startDemoDatabase } from "./demoDatabase";
import { launchVSCode, type VSCodeInstance } from "./vscode";

interface BootstrapFixtures {
  vscode: VSCodeInstance;
  workbench: WorkbenchPage;
}

interface BootstrapWorkerFixtures {
  demoDatabase: DemoDatabase;
}

/**
 * The lane that starts from nothing: a fresh VS Code profile, no configured Connexion, no index.
 * Nothing here is prepared for the scenarios, because what they verify is the preparation itself.
 */
export const test = base.extend<BootstrapFixtures, BootstrapWorkerFixtures>({
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
    { scope: "worker" },
  ],
  // VS Code is launched behind the database, so the first Connexion this lane adds has something
  // to connect to. Playwright only builds a fixture a test reaches, and no bootstrap scenario
  // names the database directly — what it verifies is the Workbench arriving at it.
  vscode: async ({ demoDatabase: _demoDatabase }, use) => {
    const instance = await launchVSCode({
      windowTimeout: 10_000,
      activationTimeout: 20_000,
      viewTimeout: 10_000,
    });
    try {
      await use(instance);
    } finally {
      await instance.dispose();
    }
  },
  workbench: async ({ vscode }, use) => {
    await use(
      new WorkbenchPage(
        () => vscode.page,
        vscode.resizeWindow,
        vscode.resetWorkbenchUI,
        vscode.inspectWorkbenchState,
      ),
    );
  },
});

export { expect } from "@playwright/test";
