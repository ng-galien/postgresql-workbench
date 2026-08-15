import { defineVSCodePlaywrightConfig } from "./playwright.vscode.config";

export default defineVSCodePlaywrightConfig({
  lane: "schema-sync",
  testDir: "./acceptance/specs",
  testMatch: ["**/schema-sync.acceptance.spec.ts"],
  timeout: 60_000,
  junitFile: "test-results/schema-sync-junit.xml",
  outputDir: "test-results/schema-sync",
});
