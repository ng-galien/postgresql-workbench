#!/usr/bin/env node

/**
 * A VS Code command is registered in the registerCommands of the module that owns it.
 *
 * Code Moniker cannot hold this one: `vscode` is an ambient module, so `registerCommand` has no
 * indexed symbol and a reference rule sees none of the sixty-odd registrations — a rule written
 * against it reports zero violations while twenty-five are in front of it. So the guard is here,
 * in the same `npm run check` the commit hook runs.
 *
 * The exceptions are named, not tolerated silently. Each one says why it is not a registrar's, and
 * a registration appearing anywhere else fails.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve("vscode-extension/src");

/** Where a command may be registered although the file is not a registerCommands. */
const ALLOWED = new Map([
  [
    "extension.ts",
    "filterSqlNotebooks closes over the Scratchpad tree view and the filter activation creates",
  ],
  ["sqlAuthoring.ts", "the module is one file and registers its own two commands"],
  ["dataView/queryLens.ts", "the lens registers the single action it offers"],
]);

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

const stray = [];
for (const path of sourceFiles(root)) {
  const name = relative(root, path);
  if (name.endsWith("registerCommands.ts")) continue;
  const registrations = (
    readFileSync(path, "utf8").match(/commands\.register(?:TextEditor)?Command\b/gu) ?? []
  ).length;
  if (registrations === 0) continue;
  if (ALLOWED.has(name)) continue;
  stray.push(`${name}: ${registrations}`);
}

/** An exception that no longer registers anything is an exception nobody removed. */
const stale = [...ALLOWED.keys()].filter((name) => {
  const path = join(root, name);
  try {
    return !/commands\.register(?:TextEditor)?Command\b/u.test(readFileSync(path, "utf8"));
  } catch {
    return true;
  }
});

if (stray.length > 0) {
  process.stderr.write(
    `A VS Code command is registered in its module's registerCommands.ts, not here:\n${stray
      .map((line) => `  ${line}\n`)
      .join("")}`,
  );
}
if (stale.length > 0) {
  process.stderr.write(
    `These files are excused from that but register nothing; drop them from the list:\n${stale
      .map((name) => `  ${name}\n`)
      .join("")}`,
  );
}
process.exit(stray.length + stale.length > 0 ? 1 : 0);
