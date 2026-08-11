import { test as base } from "@playwright/test";
import { CockpitPage } from "../pages/CockpitPage";
import { WorkbenchPage } from "../pages/WorkbenchPage";
import { startDemoDatabase } from "./demoDatabase";
import { launchVSCode, type VSCodeInstance } from "./vscode";

interface AcceptanceFixtures {
  workbench: WorkbenchPage;
  cockpit: CockpitPage;
  evidence: undefined;
}

interface AcceptanceWorkerFixtures {
  demoDatabase: undefined;
  vscode: VSCodeInstance;
}

export const test = base.extend<AcceptanceFixtures, AcceptanceWorkerFixtures>({
  demoDatabase: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture arguments to use object destructuring.
    async ({}, use) => {
      const demo = startDemoDatabase();
      await use(undefined);
      demo.stop();
    },
    { scope: "worker", auto: true },
  ],
  vscode: [
    async ({ demoDatabase: _demoDatabase }, use) => {
      const instance = await launchVSCode();
      await use(instance);
      await instance.dispose();
    },
    { scope: "worker" },
  ],
  workbench: async ({ vscode }, use) => {
    await use(new WorkbenchPage(vscode.page));
  },
  cockpit: async ({ vscode }, use) => {
    await use(new CockpitPage(vscode.page));
  },
  evidence: [
    async ({ vscode }, use, testInfo) => {
      await use(undefined);
      if (testInfo.status !== testInfo.expectedStatus) {
        await vscode.page
          .screenshot({ path: testInfo.outputPath("failure.png"), fullPage: true })
          .catch(() => {});
      }
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
