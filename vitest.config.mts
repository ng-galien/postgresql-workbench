import { configDefaults, defineConfig } from "vitest/config";

/**
 * What vitest never collects, whichever suite is running: build output, other worktrees, the
 * downloaded VS Code, and the suites that need a real VS Code or a real browser to run at all.
 * Which directory a run targets is the script's business, not this file's.
 */
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      "**/dist/**",
      ".worktrees/**",
      "**/.vscode-test/**",
      "vscode-extension/tests/acceptance/specs/**",
      "vscode-extension/tests/vscode/**",
    ],
  },
});
