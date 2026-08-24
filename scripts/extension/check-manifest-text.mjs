#!/usr/bin/env node

/**
 * The extension manifest is read by people, not only by VS Code.
 *
 * Three things about it drift silently. Its text is published as-is on the Marketplace, and any
 * tool that rewrites the file through `JSON.stringify` with ASCII-safe output turns an em dash
 * into a six-character escape: still valid JSON, still rendered right on the Marketplace, and
 * unreadable in the diff and in the editor ever after. And `engines.node` claims a Node the
 * extension never gets to choose: it runs in the extension host, on the Node shipped by the
 * oldest VS Code it declares support for. A claim above that host is a promise made to nobody.
 *
 * So all three are checked here, in the same `npm run check` the commit hook runs. The Node a VS Code
 * ships cannot be derived from the manifest, so it is declared below, measured once per supported
 * minimum. And a command title is read twice, in two places that render it differently: the palette
 * prints `category: title`, every menu prints `title` alone. A command that carries its prefix in
 * the title therefore reads "PostgreSQL Workbench: Execute SQL Selection" in a right-click menu,
 * and a command with no category at all reads like a built-in. So the prefix belongs in the
 * category, under one root, and the title says the action and nothing else.
 *
 * Measuring the Node:
 *
 *   ELECTRON_RUN_AS_NODE=1 "<VS Code>.app/Contents/MacOS/Electron" -e "console.log(process.versions.node)"
 */

import { readFileSync } from "node:fs";

const path = "vscode-extension/package.json";
const text = readFileSync(path, "utf8");
const manifest = JSON.parse(text);
const problems = [];

/** The Node each supported VS Code minimum ships in its extension host, measured. */
const HOST_NODE = new Map([["1.109", 22]]);

const escapes = [...new Set(text.match(/\\u[0-9a-fA-F]{4}/gu) ?? [])];
if (escapes.length > 0) {
  problems.push(
    `${path} escapes characters that belong in it as themselves: ${escapes.join(", ")}\n` +
      "  Write the character. A formatter that cannot is the wrong formatter for this file.",
  );
}

const minimumVSCode = /^\^?(\d+\.\d+)\./u.exec(manifest.engines?.vscode ?? "")?.[1];
const hostNode = minimumVSCode === undefined ? undefined : HOST_NODE.get(minimumVSCode);
if (hostNode === undefined) {
  problems.push(
    `${path} supports VS Code ${manifest.engines?.vscode} down to ${minimumVSCode ?? "?"}, and nobody here says which Node that host runs.\n` +
      "  Measure it (see the comment at the top of this file) and declare it in HOST_NODE.",
  );
} else {
  const expected = `>=${hostNode}.0.0`;
  if (manifest.engines?.node !== expected) {
    problems.push(
      `${path} claims Node ${manifest.engines?.node}, but VS Code ${minimumVSCode} runs extensions on Node ${hostNode}.\n` +
        `  Write ${expected}, or stop supporting a VS Code that old.`,
    );
  }
}

/** The one root every command's category begins with: the extension has one name on the Marketplace. */
const CATEGORY_ROOT = "PostgreSQL Workbench";

const commands = manifest.contributes?.commands ?? [];
const uncategorized = commands.filter((command) => !command.category);
if (uncategorized.length > 0) {
  problems.push(
    `${path} leaves ${uncategorized.length} command(s) without a category: ${uncategorized
      .map((command) => command.command)
      .join(", ")}\n` +
      `  The command palette prints "category: title". Without one the entry reads like a built-in.`,
  );
}

const foreignRoot = commands.filter(
  (command) =>
    command.category &&
    command.category !== CATEGORY_ROOT &&
    !command.category.startsWith(`${CATEGORY_ROOT}: `),
);
if (foreignRoot.length > 0) {
  problems.push(
    `${path} files commands under a second root: ${[
      ...new Set(foreignRoot.map((command) => command.category)),
    ].join(", ")}\n` +
      `  Every category is "${CATEGORY_ROOT}", or "${CATEGORY_ROOT}: <surface>". One extension, one name.`,
  );
}

const prefixedTitles = commands.filter((command) => command.title?.includes(": "));
if (prefixedTitles.length > 0) {
  problems.push(
    `${path} repeats a prefix inside a title: ${prefixedTitles
      .map((command) => `${command.command} (${command.title})`)
      .join(", ")}\n` +
      "  A menu prints the title alone. Put the prefix in the category and leave the action here.",
  );
}

if (problems.length > 0) process.stderr.write(`${problems.join("\n")}\n`);
process.exit(problems.length > 0 ? 1 : 0);
