import { defineVSCodePlaywrightConfig } from "./vscode.config";

export default defineVSCodePlaywrightConfig({
  lane: "bootstrap",
  testDir: "../specs/bootstrap",
  testMatch: ["**/bootstrap.spec.ts"],
  timeout: 45_000,
  forbidOnly: true,
  junitFile: "../../../test-results/bootstrap-junit.xml",
  outputDir: "../../../test-results/bootstrap",
});
