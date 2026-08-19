import { defineVSCodePlaywrightConfig } from "./vscode.config";

export default defineVSCodePlaywrightConfig({
  lane: "index-lifecycle",
  testDir: "../specs",
  testMatch: ["**/index-lifecycle.acceptance.spec.ts"],
  timeout: 60_000,
  junitFile: "../../../test-results/index-lifecycle-junit.xml",
  outputDir: "../../../test-results/index-lifecycle",
});
