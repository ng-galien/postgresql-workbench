#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { issueFormContents } from "./issue-workflow.mjs";

let valid = true;
const write = process.argv.includes("--write");
const forms = issueFormContents();
const directory = resolve(".github/ISSUE_TEMPLATE");
for (const name of readdirSync(directory)) {
  if (name === "config.yml") continue;
  if (/\.ya?ml$/i.test(name) && !(name in forms)) {
    process.stderr.write(`${name} is not declared by scripts/issue-workflow.mjs\n`);
    valid = false;
  }
}
for (const [name, expected] of Object.entries(forms)) {
  const path = resolve(directory, name);
  if (write) {
    writeFileSync(path, expected, "utf8");
    continue;
  }
  const actual = readFileSync(path, "utf8");
  if (actual !== expected) {
    process.stderr.write(`${name} is not the exact projection of scripts/issue-workflow.mjs\n`);
    valid = false;
  }
}
if (!valid) process.exitCode = 1;
