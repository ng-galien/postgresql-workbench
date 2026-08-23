#!/usr/bin/env node

/**
 * The extension adapts the engine to VS Code and holds nothing else, because the same engine is
 * meant to run under a host that is not VS Code at all.
 *
 * A file that never imports `vscode` adapts nothing. Some of those are fine — a module's index
 * re-exports what its neighbours already adapt, and the standalone DAP entry deliberately runs
 * without VS Code — and the rest are debt: engine code that has not found its package yet.
 *
 * Code Moniker cannot hold this: whether a module imports an ambient external module is not a fact
 * about the reference graph. So the guard is here, in the same `npm run check` the commit hook
 * runs, and it keeps the debt named rather than growing. A file that stops importing `vscode` fails
 * until someone says why, and an entry that has started importing it fails until someone drops it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve("vscode-extension/src");

/** Files that adapt nothing to VS Code, and why each one is here. */
const DECLARED = new Map([
  ["dapServer.ts", "the standalone DAP entry: it runs without VS Code, which is the point"],
  ["errorMessage.ts", "one line shared by every module; no package is reachable from all of them"],
  // Debt: engine code still living in the extension. Each needs a package that can hold it.
  ["cockpit/navigation.ts", "debt: where the graph has been and can go back to"],
  ["codeLens/policy.ts", "debt: what makes a call or a definition debuggable, read from the SQL"],
  ["connection/associations.ts", "debt: which Connexion each call site runs on"],
  ["connection/registry.ts", "debt: the open PostgreSQL clients of a Connexion"],
  ["coverage/client.ts", "debt: the connection pgTAP coverage is measured through"],
  ["coverage/coverageReport.ts", "debt: the shape a coverage report takes on its way to a file"],
  ["coverage/delta.ts", "debt: what changed between two coverage runs"],
  ["coverage/mapToSource.ts", "debt: executed lines mapped back to the routine source"],
  ["coverage/selection.ts", "debt: which tests a run was asked for"],
  [
    "debug/launchConfiguration.ts",
    "debt with no home: it needs the saved connections and the SQL call parser, and no package may depend on both catalog and sql",
  ],
  [
    "scratchpad/notebookFile.ts",
    "debt with no home: it needs catalog, dap, rows and views at once",
  ],
]);

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    const name = entry.name;
    if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name.endsWith(".d.ts")) return [];
    // A module's index re-exports what its neighbours adapt; it needs no import of its own.
    return name === "index.ts" ? [] : [path];
  });
}

const adaptsNothing = (path) => !/from "vscode"/u.test(readFileSync(path, "utf8"));

const undeclared = [];
for (const path of sourceFiles(root)) {
  const name = relative(root, path);
  if (adaptsNothing(path) && !DECLARED.has(name)) undeclared.push(name);
}

/** An entry that now adapts something is an entry nobody removed. */
const stale = [...DECLARED.keys()].filter((name) => {
  try {
    return !adaptsNothing(join(root, name));
  } catch {
    return true;
  }
});

if (undeclared.length > 0) {
  process.stderr.write(
    `These adapt nothing to VS Code, so they belong in a package — or say here why they do not:\n${undeclared
      .map((name) => `  ${name}\n`)
      .join("")}`,
  );
}
if (stale.length > 0) {
  process.stderr.write(
    `These now import vscode, or are gone; drop them from the list:\n${stale
      .map((name) => `  ${name}\n`)
      .join("")}`,
  );
}
process.exit(undeclared.length + stale.length > 0 ? 1 : 0);
