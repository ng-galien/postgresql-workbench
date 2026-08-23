import { configDefaults, defineConfig } from "vitest/config";

/**
 * What vitest never collects, whichever suite is running: build output, other worktrees, and the
 * downloaded VS Code. A `.spec.ts` is Playwright's in this repository — a real VS Code or a real
 * browser drives it — and a `.test.ts` is vitest's. Which directory a run targets is the script's
 * business, not this file's.
 */
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      "**/dist/**",
      ".worktrees/**",
      "**/.vscode-test/**",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "vscode-extension/tests/vscode/**",
    ],
  },
});
