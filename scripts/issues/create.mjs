#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityLabels, renderIssue, technicalLabels } from "./workflow.mjs";

function usage(message) {
  if (message) process.stderr.write(`Error: ${message}\n`);
  process.stderr.write(`Usage:
  node scripts/create-issue.mjs --type <${technicalLabels.join("|")}> --title <title> \\
    --problem-file <path> --expected-file <path> --acceptance-file <path> \\
    [--actual-file <path> --steps-file <path> --environment-file <path>] \\
    [--context-file <path>] [--capability <label> ...] [--repo <owner/repo>] [--create]

Without --create, prints the generated issue body and labels without writing to GitHub.
Use --actual-file, --steps-file, and --environment-file for bug reports.`);
  process.exit(2);
}

function parseArguments(argv) {
  const values = { capabilities: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--create") {
      values.create = true;
      continue;
    }
    if (!argument.startsWith("--")) return usage(`Unexpected argument ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) return usage(`Missing value for ${argument}`);
    index += 1;
    if (argument === "--capability") values.capabilities.push(value);
    else values[argument.slice(2).replaceAll("-", "_")] = value;
  }
  return values;
}

function readRequired(path, option) {
  if (!path) {
    usage(`Missing --${option}`);
    return "";
  }
  const value = readFileSync(path, "utf8").trim();
  if (!value) {
    usage(`--${option} must not be empty`);
    return "";
  }
  return value;
}

const values = parseArguments(process.argv.slice(2));
if (!values) process.exit(2);
if (!technicalLabels.includes(values.type)) {
  usage(`--type must be one of ${technicalLabels.join(", ")}`);
  process.exit(2);
}
if (!values.title?.trim()) {
  usage("Missing --title");
  process.exit(2);
}
if (values.capabilities.length === 0) {
  usage("Provide at least one --capability");
  process.exit(2);
}
for (const label of values.capabilities) {
  if (!capabilityLabels.includes(label)) {
    usage(`Unsupported capability label ${label}`);
    process.exit(2);
  }
}

const fields = {
  problem: readRequired(values.problem_file, "problem-file"),
  expected: readRequired(values.expected_file, "expected-file"),
  acceptance: readRequired(values.acceptance_file, "acceptance-file"),
  context: values.context_file ? readFileSync(values.context_file, "utf8").trim() : "",
};
if (values.type === "bug") {
  fields.actual = readRequired(values.actual_file, "actual-file");
  fields.steps = readRequired(values.steps_file, "steps-file");
  fields.environment = readRequired(values.environment_file, "environment-file");
}
const body = renderIssue({ type: values.type, fields });
const labels = [values.type, ...values.capabilities];

if (!values.create) {
  process.stdout.write(`# ${values.title}\n\n${body}`);
  process.stderr.write(`Dry run. Labels: ${labels.join(", ")}\n`);
  process.exit(0);
}

const directory = mkdtempSync(join(tmpdir(), "postgresql-workbench-issue-"));
const bodyFile = join(directory, "issue.md");
try {
  writeFileSync(bodyFile, body, "utf8");
  const arguments_ = ["issue", "create", "--title", values.title, "--body-file", bodyFile];
  for (const label of labels) arguments_.push("--label", label);
  if (values.repo) arguments_.push("--repo", values.repo);
  execFileSync("gh", arguments_, { stdio: "inherit" });
} finally {
  rmSync(directory, { recursive: true, force: true });
}
