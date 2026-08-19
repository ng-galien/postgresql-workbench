import { startStdioDapServer, statelessSyntaxRuntimeFromEnvironment } from "./stdioDapServer.js";

declare const __POSTGRESQL_DAP_VERSION__: string;

void main().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`PostgreSQL DAP failed to start: ${message}\n`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  if (process.argv.includes("--version")) {
    process.stdout.write(`${dapVersion()}\n`);
    return;
  }

  const runtime = statelessSyntaxRuntimeFromEnvironment();
  if (process.argv.includes("--check-code-moniker")) {
    try {
      const parser = await runtime.parser();
      await parser.parse({ language: "sql", source: "SELECT 1" });
      await parser.parse({
        language: "plpgsql",
        source: "BEGIN\n  RAISE NOTICE 'runtime ready';\nEND",
      });
      process.stdout.write("Code Moniker runtime ready\n");
    } finally {
      await runtime.dispose();
    }
    return;
  }

  startStdioDapServer(runtime);
}

function dapVersion(): string {
  return typeof __POSTGRESQL_DAP_VERSION__ === "string"
    ? __POSTGRESQL_DAP_VERSION__
    : "development";
}
