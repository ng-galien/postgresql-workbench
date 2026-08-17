import { defineVSCodePlaywrightConfig } from "./playwright.vscode.config";

export default defineVSCodePlaywrightConfig({
  lane: "core",
  testDir: "./acceptance/specs",
  testMatch: ["**/acceptance.spec.ts"],
  timeout: 60_000,
  junitFile: "test-results/core-junit.xml",
  outputDir: "test-results/core",
});
