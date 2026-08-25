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
 *
 * The same walk answers a second question the manifest cannot answer alone: every command the
 * manifest declares must actually be registered. VS Code accepts a declaration with no
 * registration without a word — the entry appears in the palette, and running it throws
 * "command 'X' not found" at the reader. So the declared set is checked against the registered
 * one here, where both are already in hand.
 *
 * That second question is answered by reading the source, which is a reader that can be defeated:
 * an id written in a form this file does not know becomes a registration it cannot see, and the
 * check would keep exiting 0 while guarding less. So every registration must be legible — an
 * argument shape that escapes the reader, and a constant name two modules disagree about, are
 * failures here rather than silent omissions.
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

/** A registration, and the same call with the argument this file knows how to read. */
const REGISTRATION = /commands\.register(?:TextEditor)?Command\b/gu;
const REGISTRATION_ARGUMENT =
  /commands\.register(?:TextEditor)?Command\(\s*("[^"]+"|[A-Z][A-Z0-9_]*)/gu;
const ID_CONSTANT = /const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]*)?=\s*"(postgresql-workbench\.[^"]+)"/gu;

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

/** One walk, one read per file: every question below is asked of this. */
const sources = sourceFiles(root).map((path) => [relative(root, path), readFileSync(path, "utf8")]);
const countIn = (text, pattern) => (text.match(pattern) ?? []).length;

const stray = [];
for (const [name, text] of sources) {
  if (name.endsWith("registerCommands.ts")) continue;
  const registrations = countIn(text, REGISTRATION);
  if (registrations === 0) continue;
  if (ALLOWED.has(name)) continue;
  stray.push(`${name}: ${registrations}`);
}

/** An exception that no longer registers anything is an exception nobody removed. */
const textOf = new Map(sources);
const stale = [...ALLOWED.keys()].filter(
  (name) => countIn(textOf.get(name) ?? "", REGISTRATION) === 0,
);

/**
 * Every command id the source registers, whether written inline or through a constant. A constant
 * is declared in one module and registered in another, so the ids are collected across all files
 * before the registrations are resolved against them — and a name two modules give different ids
 * to would resolve to whichever was read last.
 */
const idOf = new Map();
const collidingIds = [];
for (const [name, text] of sources) {
  for (const [, constant, id] of text.matchAll(ID_CONSTANT)) {
    const known = idOf.get(constant);
    if (known !== undefined && known !== id) {
      collidingIds.push(`${constant} is ${known} elsewhere and ${id} in ${name}`);
    }
    idOf.set(constant, id);
  }
}

const registered = new Set();
const unreadable = [];
for (const [name, text] of sources) {
  const calls = countIn(text, REGISTRATION);
  let read = 0;
  for (const [, argument] of text.matchAll(REGISTRATION_ARGUMENT)) {
    read += 1;
    if (argument.startsWith('"')) {
      registered.add(argument.slice(1, -1));
      continue;
    }
    const id = idOf.get(argument);
    if (id === undefined) unreadable.push(`${name}: ${argument} names no command id`);
    else registered.add(id);
  }
  if (read < calls)
    unreadable.push(`${name}: ${calls - read} registration(s) in a form unread here`);
}

const manifest = JSON.parse(readFileSync("vscode-extension/package.json", "utf8"));
const undeclared = (manifest.contributes?.commands ?? [])
  .map((command) => command.command)
  .filter((id) => !registered.has(id));

const report = (problems, headline) => {
  if (problems.length === 0) return;
  process.stderr.write(`${headline}\n${problems.map((line) => `  ${line}\n`).join("")}`);
};

report(
  undeclared,
  "The manifest declares commands nothing registers. The palette offers them, and running one throws:",
);
report(stray, "A VS Code command is registered in its module's registerCommands.ts, not here:");
report(stale, "These files are excused from that but register nothing; drop them from the list:");
report(
  unreadable,
  "A registration this check cannot read is a registration it cannot guard. Teach it the form, or write the id:",
);
report(collidingIds, "Two modules give one constant name two different command ids:");

const failures = [undeclared, stray, stale, unreadable, collidingIds];
process.exit(failures.some((problems) => problems.length > 0) ? 1 : 0);
