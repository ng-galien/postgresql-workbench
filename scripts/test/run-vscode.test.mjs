import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const runnerScript = fileURLToPath(new URL("./run-vscode.mjs", import.meta.url));

function runWrapper(timeoutMs, childSource) {
  return spawnSync(
    process.execPath,
    [
      runnerScript,
      "--timeout-ms",
      String(timeoutMs),
      "--runner",
      process.execPath,
      "--",
      "--eval",
      childSource,
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
}

test("passes through a successful runner exit", () => {
  const result = runWrapper(1_000, "process.exit(0)");

  assert.equal(result.status, 0, result.stderr);
});

test("terminates the runner process group at the hard timeout", () => {
  const result = runWrapper(100, "setInterval(() => {}, 1000)");

  assert.equal(result.status, 124, result.stderr);
  assert.match(result.stderr, /exceeded 100 ms/);
});
