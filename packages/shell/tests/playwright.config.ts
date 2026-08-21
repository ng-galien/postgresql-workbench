import { defineConfig } from "@playwright/test";

/**
 * The Data View driven in a real browser against the real host: PostgreSQL answers the rows, Code
 * Moniker parses the SQL, the composition engine plans the joins. No VS Code and no Electron, so a
 * journey costs seconds. What the VS Code lanes still prove is that the message crosses the wire.
 */
const PORT = Number(process.env.PGWB_SHELL_PORT ?? 5176);

export default defineConfig({
  testDir: ".",
  testMatch: ["**/*.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI
    ? [["list"], ["junit", { outputFile: "../../../test-results/shell-junit.xml" }]]
    : "list",
  outputDir: "../../../test-results/shell",
  use: {
    baseURL: `http://localhost:${PORT}`,
    actionTimeout: 10_000,
    // Copy and paste are driven with the keyboard here, so the browser has to let the page reach
    // the clipboard the way it would for a reader who has said yes.
    permissions: ["clipboard-read", "clipboard-write"],
    trace: process.env.CI ? "off" : "retain-on-failure",
    screenshot: process.env.CI ? "off" : "only-on-failure",
  },
  webServer: {
    command: "node packages/shell/server.mjs",
    url: `http://localhost:${PORT}`,
    cwd: "../../..",
    reuseExistingServer: false,
    timeout: 120_000,
    env: { PGWB_DEV_PORT: String(PORT) },
  },
});
