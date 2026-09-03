#!/usr/bin/env node

/**
 * The Connections page and the host manifest describe the same application settings. The page's
 * catalog (packages/views/src/connections/appSettings.json) is the authority — it is host-neutral
 * and every shell reads it — so the VS Code contributes block must agree with it on keys,
 * defaults, kinds, choices and bounds. Descriptions may differ: the manifest documents, the page
 * labels. A key on either side the other does not know is a failure, not a warning.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const catalog = JSON.parse(
  readFileSync(resolve("packages/views/src/connections/appSettings.json"), "utf8"),
);
const manifest = JSON.parse(readFileSync(resolve("vscode-extension/package.json"), "utf8"))
  .contributes.configuration.properties;

const PREFIX = "postgresql-workbench.";
const KINDS = new Map([
  ["number", new Set(["number", "integer"])],
  ["boolean", new Set(["boolean"])],
  ["string", new Set(["string"])],
  ["select", new Set(["string"])],
  ["list", new Set(["array"])],
]);

const failures = [];
const catalogKeys = new Set(catalog.map((entry) => entry.key));

for (const entry of catalog) {
  const declared = manifest[`${PREFIX}${entry.key}`];
  if (!declared) {
    failures.push(`${entry.key}: in the page catalog but not contributed by the manifest`);
    continue;
  }
  if (!KINDS.get(entry.kind)?.has(declared.type)) {
    failures.push(`${entry.key}: kind ${entry.kind} does not match manifest type ${declared.type}`);
  }
  if (JSON.stringify(declared.default) !== JSON.stringify(entry.default)) {
    failures.push(
      `${entry.key}: default ${JSON.stringify(entry.default)} != manifest ${JSON.stringify(declared.default)}`,
    );
  }
  for (const [bound, manifestBound] of [
    ["minimum", declared.minimum],
    ["maximum", declared.maximum],
  ]) {
    if (entry[bound] !== manifestBound) {
      failures.push(
        `${entry.key}: ${bound} ${entry[bound] ?? "none"} != manifest ${manifestBound ?? "none"}`,
      );
    }
  }
  if (entry.kind === "select" || declared.enum) {
    if (JSON.stringify(declared.enum) !== JSON.stringify(entry.options)) {
      failures.push(
        `${entry.key}: options ${JSON.stringify(entry.options)} != manifest enum ${JSON.stringify(declared.enum)}`,
      );
    }
  }
}

for (const key of Object.keys(manifest)) {
  if (!catalogKeys.has(key.slice(PREFIX.length))) {
    failures.push(`${key}: contributed by the manifest but missing from the page catalog`);
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `The settings catalog and the manifest disagree:\n${failures.map((failure) => `  ${failure}\n`).join("")}`,
  );
  process.exit(1);
}
