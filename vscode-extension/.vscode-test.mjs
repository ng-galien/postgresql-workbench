import { defineConfig } from "@vscode/test-cli";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testUserDataDir =
  process.platform === "darwin"
    ? `/tmp/pgwb-vscode-test-${process.pid}`
    : join(tmpdir(), `pgwb-vscode-test-${process.pid}`);

export default defineConfig({
  files: [
    "dist/vscode-extension/src/test/extension.test.js",
  ],
  workspaceFolder: "./test-workspace",
  launchArgs: [`--user-data-dir=${testUserDataDir}`],
  mocha: {
    ui: "tdd",
    slow: 0,
    timeout: 60_000,
  },
});
