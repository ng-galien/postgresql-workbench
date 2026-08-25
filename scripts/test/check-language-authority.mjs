#!/usr/bin/env node

/**
 * One language authority, reachable without VS Code.
 *
 * The SQL authoring server is the only thing that says what a name in a statement is or what may
 * follow the caret, and the application is meant to run under a host that is not VS Code at all.
 * Two failures put that out of reach, and neither is visible to any other check here.
 *
 * The first is asking VS Code instead of asking the server. VS Code answers with every provider
 * registered for the language, so a second SQL extension installed beside this one lands its
 * proposals in a Workbench view wearing this one's vocabulary — and under Electron there is no
 * aggregator to ask at all. The Data View did exactly this, for both proposals and colouring.
 *
 * The second is a capability whose only implementation lives inside an adapter. The server asks its
 * host questions it cannot answer alone, and a question only VS Code answers is a capability the
 * application loses the moment it leaves VS Code. Colouring a PL/pgSQL body was one: the extension
 * answered, the shell did not, and the server catches that failing and returns no tokens — so the
 * colour simply disappeared, without a word.
 *
 * check-extension-adapts asks whether a file adapts anything to VS Code, and is blind to both: the
 * files at fault imported `vscode` and passed. This asks the other question.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SERVER = "packages/sql/src/languageServer/server.ts";

/** Every host that must be able to answer the server on its own. */
const HOSTS = [
  { name: "The Extension Host", path: "vscode-extension/src/sqlAuthoring.ts" },
  { name: "The composition shell", path: "packages/shell/src/languageServer.ts" },
];

/**
 * Asking VS Code for what the server answers. These are the aggregator commands: each returns what
 * every registered provider says, which is neither only ours nor available outside VS Code.
 */
const AGGREGATORS = [
  "vscode.executeCompletionItemProvider",
  "vscode.provideDocumentSemanticTokens",
  "vscode.provideDocumentSemanticTokensLegend",
  "vscode.executeHoverProvider",
  "vscode.executeSignatureHelpProvider",
  "vscode.executeFormatDocumentProvider",
];

/** Files allowed to reach an aggregator, and why each one is. */
const AGGREGATOR_EXCUSES = new Map();

const root = resolve(".");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const failures = [];

/*
 * The questions the server sends back to whoever hosts it, read from the server itself rather than
 * from the protocol: the protocol also declares what a host sends inward, and a host owes no answer
 * to a question it is the one asking.
 */
const questions = [
  ...new Set(
    [...read(SERVER).matchAll(/connection\.sendRequest(?:<[^>]*>)?\(\s*(SQL_AUTHORING_\w+)/gu)].map(
      (match) => match[1],
    ),
  ),
];

if (questions.length === 0) {
  failures.push(
    `${SERVER} sends no request to its host. If that changed, this check now guards nothing: point it at where the server asks.`,
  );
}

for (const host of HOSTS) {
  const answered = new Set(
    [...read(host.path).matchAll(/onRequest(?:<[^>]*>)?\(\s*(SQL_AUTHORING_\w+)/gu)].map(
      (match) => match[1],
    ),
  );
  for (const question of questions) {
    if (answered.has(question)) continue;
    failures.push(
      `${host.name} does not answer ${question}. The server asks its host this, and catches the failure, so the capability disappears without a word. Answer it in ${host.path}.`,
    );
  }
}

for (const file of sources("vscode-extension/src")) {
  if (AGGREGATOR_EXCUSES.has(file.name)) continue;
  for (const aggregator of AGGREGATORS) {
    if (!file.text.includes(aggregator)) continue;
    failures.push(
      `${file.name} asks VS Code for ${aggregator}. That is every provider registered for the language, not this server, and nothing answers it outside VS Code. Ask the SQL authoring client instead.`,
    );
  }
}

for (const [name, reason] of AGGREGATOR_EXCUSES) {
  const excused = sources("vscode-extension/src").find((file) => file.name === name);
  if (!excused) {
    failures.push(`${name} is excused (${reason}) but no longer exists. Drop the excuse.`);
    continue;
  }
  if (!AGGREGATORS.some((aggregator) => excused.text.includes(aggregator))) {
    failures.push(
      `${name} is excused (${reason}) but no longer asks VS Code for anything the server answers. Drop the excuse.`,
    );
  }
}

/** Every TypeScript source under a directory, with its text and its path from the repository root. */
function sources(directory) {
  const base = resolve(root, directory);
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.tsx?$/u.test(entry.name)) continue;
      found.push({ name: relative(root, path), text: readFileSync(path, "utf8") });
    }
  };
  walk(base);
  return found;
}

if (failures.length > 0) {
  process.stderr.write(
    `One language authority:\n${failures.map((line) => `  ${line}`).join("\n")}\n`,
  );
  process.exit(1);
}
