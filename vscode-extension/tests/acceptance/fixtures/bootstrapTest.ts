import { test as base, type Page } from "@playwright/test";
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

export async function waitForConnectionsPage(page: Page): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (
        await frame
          .getByLabel("Saved Connections")
          .isVisible()
          .catch(() => false)
      )
        return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    "A first-time user could not reach the Connections page while secondary features were still starting",
  );
}

/**
 * The lane that starts from nothing: a fresh VS Code profile, no configured Connection, no index.
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
  vscode: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture arguments to use object destructuring.
    async ({}, use) => {
      const instance = await launchVSCode({
        windowTimeout: 10_000,
        activationTimeout: 20_000,
        viewTimeout: 10_000,
        beforeFeatureBootstrapReady: waitForConnectionsPage,
      });
      try {
        await use(instance);
      } finally {
        await instance.dispose();
      }
    },
    // Keep host startup outside the 45-second Connection journey budget.
    { timeout: 45_000 },
  ],
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
