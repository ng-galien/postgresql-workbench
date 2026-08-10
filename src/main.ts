import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PlpgsqlDebugSession, TIMEOUTS } from "./debugger/index.js";
import { LocalCodeMonikerSyntaxRuntime } from "./localCodeMonikerSyntax.js";
import type { LocalCodeMonikerDaemon } from "./workbench/localCodeMoniker.js";

const logFile = path.join(os.tmpdir(), "postgresql-workbench.log");
const log = (msg: string) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);

log("DAP server starting");

const syntaxRuntime = new LocalCodeMonikerSyntaxRuntime({
  runtimePath: codeMonikerRuntimePath(),
  workspaceRoots: codeMonikerWorkspaceRoots(),
  clientName: "postgresql-workbench",
  daemon: codeMonikerDaemon(),
  timeoutMs: codeMonikerTimeoutMs(),
});
const session = new PlpgsqlDebugSession(() => syntaxRuntime.parser());

let shuttingDown = false;
async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutdown: ${reason}`);
  await Promise.race([
    Promise.all([session.shutdown(), syntaxRuntime.dispose()]),
    new Promise((r) => setTimeout(r, TIMEOUTS.SHUTDOWN_BUDGET_MS)),
  ]);
  process.exit(exitCode);
}

process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
process.on("SIGINT", () => void shutdown("SIGINT", 0));
// VS Code closing the stdio pipe means the client is gone — clean up instead of lingering.
process.stdin.on("close", () => void shutdown("stdin closed", 0));
process.on("uncaughtException", (err) => {
  log(`UNCAUGHT: ${err.stack ?? err.message}`);
  void shutdown("uncaughtException", 1);
});
process.on("unhandledRejection", (err) => log(`UNHANDLED: ${err}`));

session.setRunAsServer(false);
session.start(process.stdin, process.stdout);
log("DAP server started on stdio");

function codeMonikerRuntimePath(): string {
  const configured = process.env.PLPGSQL_CODE_MONIKER_RUNTIME;
  if (!configured) {
    throw new Error("PLPGSQL_CODE_MONIKER_RUNTIME must point to the packaged runtime directory");
  }
  return path.resolve(configured);
}

function codeMonikerWorkspaceRoots(): string[] {
  const configured = process.env.PLPGSQL_CODE_MONIKER_WORKSPACE_ROOTS;
  if (!configured) return [process.cwd()];
  try {
    const roots = JSON.parse(configured);
    if (
      Array.isArray(roots) &&
      roots.length > 0 &&
      roots.every((root) => typeof root === "string" && root.length > 0)
    ) {
      return roots;
    }
  } catch {}
  throw new Error("PLPGSQL_CODE_MONIKER_WORKSPACE_ROOTS must be a non-empty JSON string array");
}

function codeMonikerDaemon(): LocalCodeMonikerDaemon | undefined {
  const configured = process.env.PLPGSQL_CODE_MONIKER_DAEMON;
  if (!configured) return undefined;
  try {
    const daemon = JSON.parse(configured) as Partial<LocalCodeMonikerDaemon>;
    if (
      typeof daemon.endpoint === "string" &&
      typeof daemon.pid === "number" &&
      typeof daemon.token === "string" &&
      Array.isArray(daemon.workspaceRoots) &&
      daemon.workspaceRoots.every((root) => typeof root === "string")
    ) {
      return daemon as LocalCodeMonikerDaemon;
    }
  } catch {}
  throw new Error("PLPGSQL_CODE_MONIKER_DAEMON must describe an existing daemon connection");
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
