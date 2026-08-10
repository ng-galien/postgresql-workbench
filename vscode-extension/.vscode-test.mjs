import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "dist/**/test/**/*.test.js",
  workspaceFolder: "./test-workspace",
  mocha: {
    ui: "tdd",
    timeout: 60_000,
  },
});
