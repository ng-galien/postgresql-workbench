import { execFileSync, spawnSync } from "node:child_process";

execFileSync(process.execPath, ["scripts/mcp/build.mjs"], { stdio: "inherit" });
const fixture = JSON.parse(
  execFileSync(
    "docker",
    ["compose", "-f", "docker/e2e/compose.yml", "config", "--format", "json"],
    { encoding: "utf8" },
  ),
);
const postgres = fixture.services.postgres;
const run = spawnSync(
  process.execPath,
  [
    "node_modules/@playwright/test/cli.js",
    "test",
    "--config",
    "packages/mcp/tests/playwright.config.ts",
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      PGWB_MCP_PROFILES: "",
      PGHOST: "127.0.0.1",
      PGPORT: String(postgres.ports[0].published),
      PGDATABASE: postgres.environment.POSTGRES_DB,
      PGUSER: postgres.environment.POSTGRES_USER,
      PGPASSWORD: postgres.environment.POSTGRES_PASSWORD,
    },
  },
);
process.exitCode = run.status ?? 1;
