import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PlpgsqlDebugSession, TIMEOUTS } from "./debugger/index.js";
import { StatelessCodeMonikerSyntaxRuntime } from "./localCodeMonikerSyntax.js";

declare const __POSTGRESQL_DAP_VERSION__: string;

const logFile = path.join(os.tmpdir(), "postgresql-workbench.log");
const log = (msg: string) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);

let syntaxRuntime: StatelessCodeMonikerSyntaxRuntime | undefined;
let session: PlpgsqlDebugSession | undefined;
let shuttingDown = false;
async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutdown: ${reason}`);
  await Promise.race([
    Promise.all([session?.shutdown(), syntaxRuntime?.dispose()]),
    new Promise((r) => setTimeout(r, TIMEOUTS.SHUTDOWN_BUDGET_MS)),
  ]);
  process.exit(exitCode);
}

process.on("uncaughtException", (err) => {
  log(`UNCAUGHT: ${err.stack ?? err.message}`);
  void shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (err) => log(`UNHANDLED: ${err}`));

void main().catch(async (error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  log(`STARTUP FAILED: ${message}`);
  process.stderr.write(`PostgreSQL DAP failed to start: ${message}\n`);
  await syntaxRuntime?.dispose().catch(() => undefined);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  if (process.argv.includes("--version")) {
    process.stdout.write(`${dapVersion()}\n`);
    return;
  }

  log("DAP server starting");
  const runtimePath = codeMonikerRuntimePath();
  syntaxRuntime = new StatelessCodeMonikerSyntaxRuntime({
    runtimePath,
    timeoutMs: codeMonikerTimeoutMs(),
  });

  if (process.argv.includes("--check-code-moniker")) {
    const parser = await syntaxRuntime.parser();
    await parser.parse({ language: "sql", source: "SELECT 1" });
    await parser.parse({
      language: "plpgsql",
      source: "BEGIN\n  RAISE NOTICE 'runtime ready';\nEND",
    });
    await syntaxRuntime.dispose();
    process.stdout.write("Code Moniker runtime ready\n");
    return;
  }

  session = new PlpgsqlDebugSession(() => syntaxRuntime?.parser() ?? missingSyntaxRuntime());
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.on("SIGINT", () => void shutdown("SIGINT", 0));
  // Closing the stdio pipe means that the DAP client is gone.
  process.stdin.on("close", () => void shutdown("stdin closed", 0));
  session.setRunAsServer(false);
  session.start(process.stdin, process.stdout);
  log("DAP server started on stdio");
}

function missingSyntaxRuntime(): never {
  throw new Error("Code Moniker syntax runtime is not initialized");
}

function dapVersion(): string {
  return typeof __POSTGRESQL_DAP_VERSION__ === "string"
    ? __POSTGRESQL_DAP_VERSION__
    : "development";
}

function codeMonikerRuntimePath(): string | undefined {
  const configured = process.env.PLPGSQL_CODE_MONIKER_RUNTIME;
  return configured ? path.resolve(configured) : undefined;
}

function codeMonikerTimeoutMs(): number | undefined {
  const configured = process.env.PLPGSQL_CODE_MONIKER_TIMEOUT_MS;
  if (!configured) return undefined;
  const timeoutMs = Number(configured);
  if (Number.isInteger(timeoutMs) && timeoutMs >= 1_000 && timeoutMs <= 300_000) {
    return timeoutMs;
  }
  throw new Error("PLPGSQL_CODE_MONIKER_TIMEOUT_MS must be an integer between 1000 and 300000");
}
