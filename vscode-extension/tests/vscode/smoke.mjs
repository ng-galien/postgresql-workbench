import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  // The suites live under tests/, so the extension root has to be named.
  extensionDevelopmentPath: "../..",
  label: "cross-platform-activation-smoke",
  files: "../../dist/smoke/**/*.smoke.cjs",
  workspaceFolder: "../workspace",
  launchArgs:
    process.platform === "darwin"
      ? [`--user-data-dir=/tmp/pgwb-vscode-smoke-${process.pid}`]
      : [],
  mocha: {
    ui: "tdd",
    timeout: 60_000,
  },
});
