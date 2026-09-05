import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAcceptanceWorkspace } from "./workspace";

it("isolates worker writes and Git exclusions from fixture inputs and local workspace state", () => {
  const root = mkdtempSync(join(tmpdir(), "pgwb-workspace-proof-"));
  try {
    const source = join(root, "source");
    mkdirSync(source);
    for (const name of [
      "debug-call-chain.sql",
      "debug-fib.sql",
      "debug-restock.sql",
      "debug-successive.sql",
    ]) {
      writeFileSync(join(source, name), `-- ${name}\n`);
    }
    writeFileSync(join(source, ".mcp.json"), "existing local configuration");
    mkdirSync(join(source, ".postgresql-workbench-acceptance"));
    writeFileSync(join(source, ".postgresql-workbench-acceptance", "retained.sql"), "local WIP");
    const workers = [join(root, "first"), join(root, "second")];
    for (const worker of workers) mkdirSync(worker);
    const first = createAcceptanceWorkspace(source, workers[0]!);
    writeFileSync(join(first, "debug-fib.sql"), "first worker mutation");
    writeFileSync(join(first, ".git", "info", "exclude"), "/.mcp.json\n");
    const second = createAcceptanceWorkspace(source, workers[1]!);
    expect(readFileSync(join(second, "debug-fib.sql"), "utf8")).toBe("-- debug-fib.sql\n");
    expect(readFileSync(join(source, "debug-fib.sql"), "utf8")).toBe("-- debug-fib.sql\n");
    expect(readdirSync(second).sort()).toEqual([
      ".git",
      "debug-call-chain.sql",
      "debug-fib.sql",
      "debug-restock.sql",
      "debug-successive.sql",
    ]);
    expect(readFileSync(join(source, ".mcp.json"), "utf8")).toBe("existing local configuration");
    expect(
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: second,
        encoding: "utf8",
      }).trim(),
    ).toBe(realpathSync(second));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
