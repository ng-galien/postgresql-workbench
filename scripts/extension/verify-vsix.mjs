import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import { shownMarketplaceCards } from "../marketplace/mediaContract.mjs";
import { CODE_MONIKER_TARGETS, resolveCodeMonikerTarget } from "./code-moniker-target.mjs";

const target = resolveCodeMonikerTarget();
const targetPackage = CODE_MONIKER_TARGETS[target];
const extensionVersion = JSON.parse(
  readFileSync(new URL("../../vscode-extension/package.json", import.meta.url), "utf8"),
).version;
const [
  argument = `postgresql-workbench-${process.env.npm_package_version ?? extensionVersion}-${target}.vsix`,
] = process.argv.slice(2);
const vsix = resolve(argument);
const zip = await JSZip.loadAsync(readFileSync(vsix));
const entries = new Set(Object.keys(zip.files).filter((entry) => !zip.files[entry].dir));

/*
 * Which cards the Marketplace page shows, asked once of the page itself. Asked twice — as it was,
 * by two expressions that could disagree — a renamed card can satisfy one check and be skipped by
 * the other, which is the failure this list was derived to prevent.
 */
const marketplaceCards = shownMarketplaceCards(
  readFileSync(new URL("../../vscode-extension/README.md", import.meta.url), "utf8"),
);
if (marketplaceCards.length === 0) {
  throw new Error("The extension README shows no Marketplace card; the page would be bare");
}

const required = [
  "extension/dist/extension.js",
  "extension/dist/dap-server.js",
  "extension/dist/sql-authoring-server.js",
  "extension/dist/sql-notebook-renderer.js",
  "extension/dist/data-view.js",
  "extension/SECURITY.md",
  "extension/SUPPORT.md",
  "extension/THIRD_PARTY_NOTICES.md",
  /* A scene written but not yet filmed shows nothing, so it ships nothing. */
  ...marketplaceCards.flatMap((gif) => [
    `extension/media/marketplace/${gif}`,
    `extension/media/marketplace/${gif.replace(/\.gif$/u, ".png")}`,
  ]),
  "extension/runtime/code-moniker/manifest.json",
  "extension/runtime/code-moniker/client/index.cjs",
  "extension/runtime/code-moniker/client/node.cjs",
  "extension/runtime/code-moniker/CODE_MONIKER_CLIENT_LICENSE.txt",
  "extension/runtime/code-moniker/CODE_MONIKER_NATIVE_LICENSE.txt",
  `extension/runtime/code-moniker/bin/${targetPackage.executable}`,
];
const missing = required.filter((entry) => !entries.has(entry));
if (missing.length > 0) {
  throw new Error(`VSIX is missing required files: ${missing.join(", ")}`);
}

const forbidden = [...entries].filter(
  (entry) =>
    /(^|\/)node_modules\//.test(entry) ||
    /(^|\/)media\/marketplace\/raw\//.test(entry) ||
    /(^|\/)tests\//.test(entry) ||
    /\.wasm$/i.test(entry) ||
    /\.sha256$/i.test(entry) ||
    /\.ts$/i.test(entry) ||
    /\.map$/i.test(entry) ||
    /\.d\.ts$/i.test(entry),
);
if (forbidden.length > 0) {
  throw new Error(`VSIX contains forbidden files: ${forbidden.join(", ")}`);
}
const notices = await requiredText(zip, "extension/THIRD_PARTY_NOTICES.md");
if (!notices.includes("Permission is hereby granted")) {
  throw new Error("VSIX third-party notices contain no complete license text");
}
const readme = await requiredText(zip, "extension/readme.md");
const marketplaceMediaBase =
  "https://raw.githubusercontent.com/ng-galien/postgresql-workbench/main/vscode-extension/media/marketplace/";
/*
 * The packaged README must point at the images through their published URL, or the Marketplace
 * page shows nothing: it cannot resolve a relative path. Which images those are is the page's own
 * business, read from it rather than repeated here.
 */
for (const image of marketplaceCards) {
  if (!readme.includes(`${marketplaceMediaBase}${image}`)) {
    throw new Error(`VSIX README does not contain the publishable Marketplace image URL: ${image}`);
  }
}

const extracted = mkdtempSync(join(tmpdir(), "postgresql-workbench-code-moniker-vsix-"));
let runtime;
let ownedDaemon;
let client;
try {
  const runtimeDirectory = resolve(extracted, "runtime");
  const manifest = JSON.parse(
    await requiredText(zip, "extension/runtime/code-moniker/manifest.json"),
  );
  for (const relative of [manifest.clientEntry, manifest.nodeEntry, manifest.binary]) {
    const archivePath = `extension/runtime/code-moniker/${relative}`;
    const output = resolve(runtimeDirectory, relative);
    mkdirSync(resolve(output, ".."), { recursive: true });
    writeFileSync(output, await requiredBuffer(zip, archivePath));
  }

  if (manifest.format !== 2 || manifest.target !== target) {
    throw new Error(`VSIX runtime targets ${manifest.target}, expected ${target}`);
  }
  if (
    manifest.platform !== targetPackage.platform ||
    manifest.arch !== targetPackage.architecture
  ) {
    throw new Error(
      `VSIX runtime platform ${manifest.platform}-${manifest.arch} does not match ${target}`,
    );
  }
  if (!/^npm:/.test(manifest.source)) {
    throw new Error(`VSIX runtime has invalid npm provenance: ${manifest.source}`);
  }

  const requireFromRuntime = createRequire(resolve(runtimeDirectory, manifest.nodeEntry));
  const portableClient = requireFromRuntime(resolve(runtimeDirectory, manifest.clientEntry));
  const nodeClient = requireFromRuntime(resolve(runtimeDirectory, manifest.nodeEntry));
  if (!Number.isInteger(portableClient.PROTOCOL_VERSION)) {
    throw new Error("VSIX Code Moniker client does not expose PROTOCOL_VERSION");
  }
  if (portableClient.PROTOCOL_VERSION !== manifest.protocolVersion) {
    throw new Error(
      `VSIX Code Moniker protocol ${portableClient.PROTOCOL_VERSION} does not match manifest ${manifest.protocolVersion}`,
    );
  }
  if (typeof nodeClient.NodeDaemonRuntime !== "function") {
    throw new Error("VSIX Code Moniker Node client does not expose NodeDaemonRuntime");
  }

  const binary = resolve(runtimeDirectory, manifest.binary);
  if (targetPackage.platform !== "win32") chmodSync(binary, 0o755);
  const binarySha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
  if (binarySha256 !== manifest.binarySha256) {
    throw new Error(
      `VSIX Code Moniker binary checksum ${binarySha256} does not match manifest ${manifest.binarySha256}`,
    );
  }
  const binaryVersion = execFileSync(binary, ["--version"], { encoding: "utf8" })
    .trim()
    .replace(/^code-moniker\s+/, "");
  if (binaryVersion !== manifest.binaryVersion) {
    throw new Error(
      `VSIX Code Moniker binary ${binaryVersion} does not match manifest ${manifest.binaryVersion}`,
    );
  }
  const workspaceDirectory = resolve(extracted, "workspace");
  const registry = resolve(extracted, "registry");
  mkdirSync(workspaceDirectory, { recursive: true });
  const workspace = realpathSync(workspaceDirectory);
  runtime = new nodeClient.NodeDaemonRuntime({
    registryDirectory: registry,
    binaryCandidates: [binary],
    timeoutMs: 30_000,
  });
  ownedDaemon = await runtime.launch({
    workspaceRoots: [workspace],
    binaryCandidates: [binary],
    registrationTimeoutMs: 30_000,
  });
  client = await runtime.connect(ownedDaemon.entry, {
    clientName: "postgresql-workbench-vsix-smoke",
    expectedWorkspaceRoots: ownedDaemon.entry.workspaceRoots,
    timeoutMs: 30_000,
  });
  await waitForWorkspaceReady(client, 30_000);
  const wideSql = `SELECT\n${Array.from(
    { length: 256 },
    (_, index) => `  ${index + 1} AS projected_column_${index + 1}`,
  ).join(",\n")};`;
  const syntax = await client.syntax.parse("sql", wideSql, {
    maxDepth: 1_024,
    maxNodes: 100_000,
    namedOnly: true,
  });
  if (syntax.has_error || syntax.truncated) {
    throw new Error(
      `VSIX Code Moniker runtime could not analyze the wide SQL smoke query: error=${syntax.has_error} truncated=${syntax.truncated} nodes=${syntax.emitted_nodes}/${syntax.total_nodes} depth=${syntax.max_depth}`,
    );
  }
} finally {
  client?.close();
  try {
    if (runtime && ownedDaemon) {
      await runtime.stopOwned(ownedDaemon, { timeoutMs: 15_000 });
    }
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }
}

process.stdout.write(
  `Verified launchable ${target} Code Moniker parser and PostgreSQL Workbench predictor in ${vsix}\n`,
);

async function waitForWorkspaceReady(workspaceClient, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await workspaceClient.workspace.status();
    if (status.phase === "ready") return;
    if (status.phase === "failed") {
      throw new Error(`VSIX Code Moniker workspace failed: ${status.message ?? "unknown error"}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("VSIX Code Moniker workspace did not become ready within 30000ms");
}

async function requiredText(archive, path) {
  return (await requiredFile(archive, path)).async("string");
}

async function requiredBuffer(archive, path) {
  return (await requiredFile(archive, path)).async("nodebuffer");
}

function requiredFile(archive, path) {
  const file = archive.file(path);
  if (!file) throw new Error(`VSIX is missing required file: ${path}`);
  return file;
}
