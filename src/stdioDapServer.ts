import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PlpgsqlDebugSession, TIMEOUTS } from "./debugger/index.js";
import { StatelessCodeMonikerSyntaxRuntime } from "./localCodeMonikerSyntax.js";

export function statelessSyntaxRuntimeFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): StatelessCodeMonikerSyntaxRuntime {
  return new StatelessCodeMonikerSyntaxRuntime({
    runtimePath: codeMonikerRuntimePath(environment),
    timeoutMs: codeMonikerTimeoutMs(environment),
  });
}

export function startStdioDapServer(runtime: StatelessCodeMonikerSyntaxRuntime): void {
  const logFile = path.join(os.tmpdir(), "postgresql-workbench.log");
  const log = (message: string) =>
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
  let session: PlpgsqlDebugSession | undefined;
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutdown: ${reason}`);
    await Promise.race([
      Promise.all([session?.shutdown(), runtime.dispose()]),
      new Promise((resolve) => setTimeout(resolve, TIMEOUTS.SHUTDOWN_BUDGET_MS)),
    ]);
    process.exit(exitCode);
  };

  process.on("uncaughtException", (error) => {
    log(`UNCAUGHT: ${error.stack ?? error.message}`);
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (error) => log(`UNHANDLED: ${error}`));
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.on("SIGINT", () => void shutdown("SIGINT", 0));
  process.stdin.on("close", () => void shutdown("stdin closed", 0));

  log("DAP server starting");
  session = new PlpgsqlDebugSession(() => runtime.parser());
  session.setRunAsServer(false);
  session.start(process.stdin, process.stdout);
  log("DAP server started on stdio");
}

function codeMonikerRuntimePath(environment: NodeJS.ProcessEnv): string | undefined {
  const configured = environment.PLPGSQL_CODE_MONIKER_RUNTIME;
  return configured ? path.resolve(configured) : undefined;
}

function codeMonikerTimeoutMs(environment: NodeJS.ProcessEnv): number | undefined {
  const configured = environment.PLPGSQL_CODE_MONIKER_TIMEOUT_MS;
  if (!configured) return undefined;
  const timeoutMs = Number(configured);
  if (Number.isInteger(timeoutMs) && timeoutMs >= 1_000 && timeoutMs <= 300_000) {
    return timeoutMs;
  }
  throw new Error("PLPGSQL_CODE_MONIKER_TIMEOUT_MS must be an integer between 1000 and 300000");
}
