import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  label: "cross-platform-activation-smoke",
  files: "dist/**/smoke/**/*.smoke.js",
  workspaceFolder: "./test-workspace",
  launchArgs:
    process.platform === "darwin"
      ? [`--user-data-dir=/tmp/pgwb-vscode-smoke-${process.pid}`]
      : [],
  mocha: {
    ui: "tdd",
    timeout: 60_000,
  },
});
