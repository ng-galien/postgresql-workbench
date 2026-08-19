import { defineConfig } from "@vscode/test-cli";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testUserDataDir =
  process.platform === "darwin"
    ? `/tmp/pgwb-vscode-test-${process.pid}`
    : join(tmpdir(), `pgwb-vscode-test-${process.pid}`);

export default defineConfig({
  // The suites live under tests/, so the extension root has to be named.
  extensionDevelopmentPath: "../..",
  files: [
    "../../dist/vscode-extension/tests/vscode/integration/extension.test.js",
  ],
  workspaceFolder: "../workspace",
  launchArgs: [`--user-data-dir=${testUserDataDir}`],
  mocha: {
    ui: "tdd",
    slow: 0,
    timeout: 60_000,
  },
});
