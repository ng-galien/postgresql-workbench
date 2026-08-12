import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./acceptance/specs/bootstrap",
  testMatch: ["**/bootstrap.spec.ts"],
  globalSetup: "./acceptance/globalSetup.ts",
  fullyParallel: false,
  workers: 1,
  maxFailures: 1,
  timeout: 45_000,
  expect: { timeout: 5_000 },
  forbidOnly: true,
  retries: 0,
  reporter: [["list"], ["junit", { outputFile: "test-results/bootstrap-junit.xml" }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  outputDir: "test-results/bootstrap",
});
