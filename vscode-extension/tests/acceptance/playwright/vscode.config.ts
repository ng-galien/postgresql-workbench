import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";

interface VSCodePlaywrightConfigOptions {
  forbidOnly?: boolean;
  junitFile: string;
  lane: "bootstrap" | "core" | "schema-sync";
  outputDir: string;
  testDir: string;
  testMatch: string[];
  timeout: number;
}

export function defineVSCodePlaywrightConfig(
  options: VSCodePlaywrightConfigOptions,
): PlaywrightTestConfig {
  const richDiagnostics =
    process.env.CI !== "true" && process.env.PGWB_PLAYWRIGHT_MINIMAL_DIAGNOSTICS !== "1";

  process.env.PGWB_ACCEPTANCE_LANE = options.lane;

  return defineConfig({
    testDir: options.testDir,
    testMatch: options.testMatch,
    globalSetup: "../globalSetup.ts",
    fullyParallel: false,
    workers: 1,
    maxFailures: 1,
    timeout: options.timeout,
    expect: { timeout: 5_000 },
    forbidOnly: options.forbidOnly ?? Boolean(process.env.CI),
    retries: 0,
    projects: [{ name: options.lane }],
    reporter: process.env.CI ? [["list"], ["junit", { outputFile: options.junitFile }]] : "list",
    use: richDiagnostics
      ? {
          trace: "retain-on-failure",
          screenshot: "only-on-failure",
          video: "retain-on-failure",
        }
      : {
          trace: "off",
          screenshot: "off",
          video: "off",
        },
    outputDir: options.outputDir,
  });
}
