#!/usr/bin/env node
/*
 * The architecture profile: the boundaries the packages are supposed to keep, checked by
 * code-moniker against the real reference graph.
 *
 * It ran only on the machines of whoever remembered it, and it stopped running without anyone
 * noticing — a rule referenced by a name five packages shared made it exit before it scanned a
 * file, and a gate that says nothing looks exactly like a gate that passed. So it runs where every
 * other gate runs.
 *
 * The binary is the one the extension already stages for its own runtime; a checkout that has not
 * built yet falls back to whatever is on PATH, and says how to get one if there is neither.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const staged = path.join(
  repoRoot,
  "vscode-extension",
  "runtime",
  "code-moniker",
  "bin",
  process.platform === "win32" ? "code-moniker.exe" : "code-moniker",
);

const binary = existsSync(staged) ? staged : "code-moniker";
const result = spawnSync(binary, ["check", "--profile", "architecture", "."], {
  cwd: repoRoot,
  stdio: "inherit",
});

if (result.error) {
  process.stderr.write(
    `Architecture check: no code-moniker to run it with (${binary}).\n` +
      "Stage the one the extension uses:\n" +
      "  npm --prefix vscode-extension ci\n" +
      "  npm --prefix vscode-extension run stage:code-moniker\n",
  );
  process.exit(1);
}

/*
 * Anything but zero fails, and that includes the configuration errors that are not violations:
 * an ambiguous rule, a duplicate fragment id, an unreadable profile. Those are the ones that
 * silently disarm the check.
 */
process.exit(result.status ?? 1);
