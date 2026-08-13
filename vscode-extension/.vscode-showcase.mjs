import { defineConfig } from "@vscode/test-cli";

const profileRoot =
  process.env.POSTGRESQL_WORKBENCH_SHOWCASE_PROFILE_DIR ??
  "/private/tmp/postgresql-workbench-showcase";
const extensionDevelopmentPath =
  process.env.POSTGRESQL_WORKBENCH_SHOWCASE_EXTENSION_PATH;

if (!extensionDevelopmentPath) {
  throw new Error("POSTGRESQL_WORKBENCH_SHOWCASE_EXTENSION_PATH is required");
}

export default defineConfig({
  label: "marketplace-showcase",
  files: "dist/**/showcase/**/*.showcase.js",
  extensionDevelopmentPath,
  workspaceFolder: "../demo/PostgreSQL Workbench Showcase.code-workspace",
  launchArgs: [
    "--new-window",
    `--user-data-dir=${profileRoot}/user-data`,
    `--extensions-dir=${profileRoot}/extensions`,
  ],
  mocha: {
    ui: "tdd",
    timeout: 120_000,
  },
});
