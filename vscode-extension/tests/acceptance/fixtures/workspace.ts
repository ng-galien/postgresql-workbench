import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Only committed SQL fixture inputs enter a worker; local configs and generated Scratchpads do not. */
export function createAcceptanceWorkspace(source: string, workerRoot: string): string {
  const workspace = join(workerRoot, "workspace");
  mkdirSync(workspace);
  for (const name of [
    "debug-call-chain.sql",
    "debug-fib.sql",
    "debug-restock.sql",
    "debug-successive.sql",
  ]) {
    copyFileSync(join(source, name), join(workspace, name));
  }
  execFileSync("git", ["init", "--quiet", workspace], { stdio: "pipe" });
  return workspace;
}
