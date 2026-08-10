import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const separator = process.argv.indexOf("--");
const options = separator === -1 ? process.argv.slice(2) : process.argv.slice(2, separator);
const vscodeTestArgs = separator === -1 ? [] : process.argv.slice(separator + 1);

function option(name, fallback) {
  const index = options.indexOf(name);
  return index === -1 ? fallback : options[index + 1];
}

const timeoutMs = Number(option("--timeout-ms", "90000"));
const runner = option(
  "--runner",
  path.resolve(
    "node_modules",
    ".bin",
    process.platform === "win32" ? "vscode-test.cmd" : "vscode-test",
  ),
);

if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
  throw new Error(`Invalid --timeout-ms value: ${timeoutMs}`);
}
if (vscodeTestArgs.length === 0) {
  throw new Error("Pass vscode-test arguments after --");
}

const child = spawn(runner, vscodeTestArgs, {
  detached: process.platform !== "win32",
  shell: process.platform === "win32",
  stdio: "inherit",
});

let timedOut = false;
let forceKillTimer;

function terminate(signal = "SIGTERM") {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "inherit" });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}

const timeout = setTimeout(() => {
  timedOut = true;
  console.error(`vscode-test exceeded ${timeoutMs} ms; terminating its process group.`);
  terminate();
  forceKillTimer = setTimeout(() => terminate("SIGKILL"), 5_000);
}, timeoutMs);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    terminate(signal);
    process.exitCode = 128 + (signal === "SIGINT" ? 2 : 15);
  });
}

child.once("error", (error) => {
  clearTimeout(timeout);
  console.error(`Unable to start vscode-test: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  clearTimeout(timeout);
  clearTimeout(forceKillTimer);
  if (timedOut) {
    process.exitCode = 124;
  } else if (signal) {
    console.error(`vscode-test exited after signal ${signal}.`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
