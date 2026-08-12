import { test as base } from "@playwright/test";
import { launchVSCode, type VSCodeInstance } from "./vscode";

interface BootstrapFixtures {
  vscode: VSCodeInstance;
}

export const test = base.extend<BootstrapFixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture arguments to use object destructuring.
  vscode: async ({}, use) => {
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
});

export { expect } from "@playwright/test";
