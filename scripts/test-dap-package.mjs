import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const packageRoot = resolve(repositoryRoot, "packages", "dap");
const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
const temporaryRoot = mkdtempSync(resolve(tmpdir(), "postgresql-dap-package-"));
const npmExecPath = process.env.npm_execpath;

if (!npmExecPath) {
  throw new Error("npm_execpath is required; run this smoke test through npm");
}

function runNpm(args, options) {
  return execFileSync(process.execPath, [npmExecPath, ...args], options);
}

try {
  const packOutput = runNpm(
    ["pack", packageRoot, "--json", "--pack-destination", temporaryRoot],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  const packed = JSON.parse(packOutput)[0];
  const expectedFiles = new Set([
    "LICENSE",
    "README.md",
    "dist/postgresql-dap.js",
    "package.json",
  ]);
  const actualFiles = new Set(packed.files.map((file) => file.path));
  if (
    actualFiles.size !== expectedFiles.size ||
    [...expectedFiles].some((file) => !actualFiles.has(file))
  ) {
    throw new Error(`Unexpected npm payload: ${JSON.stringify([...actualFiles].sort())}`);
  }

  const tarball = resolve(temporaryRoot, packed.filename);
  const consumer = resolve(temporaryRoot, "consumer");
  mkdirSync(consumer);
  writeFileSync(
    resolve(consumer, "package.json"),
    `${JSON.stringify({ name: "postgresql-dap-package-smoke", private: true }, null, 2)}\n`,
  );
  writeFileSync(resolve(consumer, "smoke.sql"), "SELECT 1;\n");
  runNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: consumer, stdio: "inherit" },
  );

  const binary = resolve(
    consumer,
    "node_modules",
    "@ng-galien",
    "postgresql-dap",
    "dist",
    "postgresql-dap.js",
  );
  const installedCommand = ["exec", "--offline", "--", "postgresql-dap"];
  const version = runNpm([...installedCommand, "--version"], {
    cwd: consumer,
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  if (version !== manifest.version) {
    throw new Error(`Packaged DAP reported version ${version}, expected ${manifest.version}`);
  }

  const runtimeCheck = runNpm([...installedCommand, "--check-code-moniker"], {
    cwd: consumer,
    encoding: "utf8",
    timeout: 60_000,
  }).trim();
  if (runtimeCheck !== "Code Moniker runtime ready") {
    throw new Error(`Unexpected Code Moniker smoke output: ${runtimeCheck}`);
  }
  await smokeDapProtocol(binary, consumer);

  if (process.argv.includes("--e2e")) {
    execFileSync(
      resolve(repositoryRoot, "node_modules", ".bin", "vitest"),
      ["run", "e2e/dap-client.test.ts", "--fileParallelism=false"],
      {
        cwd: repositoryRoot,
        stdio: "inherit",
        timeout: 180_000,
        env: {
          ...process.env,
          POSTGRESQL_DAP_SERVER: binary,
          CODE_MONIKER_RUNTIME: undefined,
          PLPGSQL_CODE_MONIKER_RUNTIME: undefined,
        },
      },
    );
  }

  process.stdout.write(
    `Package smoke passed for ${manifest.name}@${manifest.version} with its npm Code Moniker runtime\n`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

async function smokeDapProtocol(binary, cwd) {
  const child = spawn(process.execPath, [binary], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const messages = dapMessages(child.stdout);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    writeDapRequest(child, {
      seq: 1,
      type: "request",
      command: "initialize",
      arguments: {
        adapterID: "postgresql-dap",
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: "path",
      },
    });
    const initialize = await messages.waitFor(
      (message) => message.type === "response" && message.request_seq === 1,
    );
    if (initialize.success !== true) {
      throw new Error(`DAP initialize request failed: ${JSON.stringify(initialize)}`);
    }
    await messages.waitFor(
      (message) => message.type === "event" && message.event === "initialized",
    );

    writeDapRequest(child, {
      seq: 2,
      type: "request",
      command: "disconnect",
      arguments: { terminateDebuggee: true },
    });
    const disconnect = await messages.waitFor(
      (message) => message.type === "response" && message.request_seq === 2,
    );
    if (disconnect.success !== true) {
      throw new Error(`DAP disconnect request failed: ${JSON.stringify(disconnect)}`);
    }
    child.stdin.end();
    const exitCode = await waitForProcessExit(child, 10_000);
    if (exitCode !== 0) {
      throw new Error(`DAP protocol smoke exited with ${exitCode}: ${stderr.trim()}`);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

function writeDapRequest(child, message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
  child.stdin.write(body);
}

function dapMessages(stream) {
  let buffer = Buffer.alloc(0);
  const queued = [];
  const waiters = [];
  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length: (\d+)/i.exec(header);
      if (!match) throw new Error(`Invalid DAP header: ${header}`);
      const length = Number(match[1]);
      const messageEnd = headerEnd + 4 + length;
      if (buffer.length < messageEnd) return;
      const message = JSON.parse(buffer.subarray(headerEnd + 4, messageEnd).toString("utf8"));
      buffer = buffer.subarray(messageEnd);
      queued.push(message);
      settleWaiters();
    }
  });

  function settleWaiters() {
    for (let waiterIndex = waiters.length - 1; waiterIndex >= 0; waiterIndex--) {
      const waiter = waiters[waiterIndex];
      const messageIndex = queued.findIndex(waiter.predicate);
      if (messageIndex < 0) continue;
      clearTimeout(waiter.timer);
      waiters.splice(waiterIndex, 1);
      waiter.resolve(queued.splice(messageIndex, 1)[0]);
    }
  }

  return {
    waitFor(predicate, timeoutMs = 10_000) {
      const existing = queued.findIndex(predicate);
      if (existing >= 0) return Promise.resolve(queued.splice(existing, 1)[0]);
      return new Promise((resolveMessage, rejectMessage) => {
        const waiter = { predicate, resolve: resolveMessage, timer: undefined };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          rejectMessage(new Error("Timed out waiting for DAP protocol message"));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error("Timed out waiting for DAP process exit")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}
