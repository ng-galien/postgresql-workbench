import {
  startStdioDapServer,
  statelessSyntaxRuntimeFromEnvironment,
} from "../../src/stdioDapServer.js";

try {
  startStdioDapServer(statelessSyntaxRuntimeFromEnvironment());
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`PostgreSQL Workbench DAP failed to start: ${message}\n`);
  process.exitCode = 1;
}
