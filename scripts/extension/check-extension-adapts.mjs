#!/usr/bin/env node

/**
 * The extension adapts the engine to VS Code and holds nothing else, because the same engine is
 * meant to run under a host that is not VS Code at all.
 *
 * A file that never imports `vscode` adapts nothing and belongs in a package. The exceptions are
 * few and each one is declared below with its reason — a module's index re-exports what its
 * neighbours already adapt, and the standalone DAP entry deliberately runs without VS Code.
 *
 * Code Moniker cannot hold this: whether a module imports an ambient external module is not a fact
 * about the reference graph. So the guard is here, in the same `npm run check` the commit hook
 * runs. A file that stops importing `vscode` fails until someone says why, and an entry that has
 * started importing it fails until someone drops it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve("vscode-extension/src");
const packagesRoot = resolve("packages");

/** Files that adapt nothing to VS Code, and why each one is here. */
const DECLARED = new Map([
  ["dapServer.ts", "the standalone DAP entry: it runs without VS Code, which is the point"],
  ["errorMessage.ts", "one line shared by every module; no package is reachable from all of them"],
  [
    "presentation/vscodeTheme.ts",
    "the explicit projection from product visual roles to VS Code theme token names",
  ],
  [
    "scratchpad/notebookRenderer.ts",
    "the VS Code notebook entrypoint that composes the host-neutral renderer with its theme adapter",
  ],
  ["webviews/vscodeApi.ts", "the browser adapter that acquires the ambient VS Code webview API"],
  ["webviews/webviewPage.ts", "the VS Code webview transport and DOM composition adapter"],
]);

/** A module's index re-exports what its neighbours adapt; it needs no import of its own. */
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    const name = entry.name;
    if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name.endsWith(".d.ts")) return [];
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

/** Package code is reusable by Electron, the shell, or a server and cannot acquire a VS Code host. */
function packageSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return packageSourceFiles(path);
    return /\.(?:[cm]?js|tsx?)$/u.test(entry.name) ? [path] : [];
  });
}

const packageHostAcquisitions = packageSourceFiles(packagesRoot)
  .filter((path) => /\bacquireVsCodeApi\s*\(/u.test(readFileSync(path, "utf8")))
  .map((path) => relative(packagesRoot, path));

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
if (packageHostAcquisitions.length > 0) {
  process.stderr.write(
    `Package code must receive a typed host port and never acquire the VS Code API:\n${packageHostAcquisitions
      .map((name) => `  ${name}\n`)
      .join("")}`,
  );
}
process.exit(undeclared.length + stale.length + packageHostAcquisitions.length > 0 ? 1 : 0);
