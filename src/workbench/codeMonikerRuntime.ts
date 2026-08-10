import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

export interface CodeMonikerRuntimeManifest {
  format: 2;
  platform: NodeJS.Platform;
  arch: string;
  target: string;
  clientVersion: string;
  protocolVersion: number;
  binaryVersion: string;
  source: string;
  clientEntry: string;
  nodeEntry: string;
  binary: string;
  binarySha256: string;
}

export interface CodeMonikerRuntime {
  rootPath: string;
  manifest: CodeMonikerRuntimeManifest;
  clientEntry: string;
  nodeEntry: string;
  binaryPath: string;
}

export function inspectCodeMonikerRuntime(
  runtimePath: string,
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
): CodeMonikerRuntime {
  const rootPath = resolve(runtimePath);
  const manifestPath = resolveInside(rootPath, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `The installed extension is missing its Code Moniker runtime manifest: ${manifestPath}`,
    );
  }
  const manifest = parseManifest(manifestPath);
  if (manifest.target !== `${manifest.platform}-${manifest.arch}`) {
    throw new Error(
      `Code Moniker runtime target ${manifest.target} does not match ` +
        `${manifest.platform}-${manifest.arch}`,
    );
  }
  if (manifest.platform !== platform || manifest.arch !== arch) {
    throw new Error(
      `Code Moniker runtime targets ${manifest.platform}-${manifest.arch}, ` +
        `but VS Code is running on ${platform}-${arch}`,
    );
  }
  const clientEntry = requiredFile(rootPath, manifest.clientEntry, "client entry");
  const nodeEntry = requiredFile(rootPath, manifest.nodeEntry, "Node client entry");
  const binaryPath = requiredFile(rootPath, manifest.binary, "daemon binary");
  if (platform !== "win32" && (statSync(binaryPath).mode & 0o111) === 0) {
    throw new Error(`Code Moniker daemon is not executable: ${binaryPath}`);
  }
  const actualSha256 = createHash("sha256").update(readFileSync(binaryPath)).digest("hex");
  if (actualSha256 !== manifest.binarySha256) {
    throw new Error(
      `Code Moniker daemon checksum mismatch: expected ${manifest.binarySha256}, got ${actualSha256}`,
    );
  }
  return { rootPath, manifest, clientEntry, nodeEntry, binaryPath };
}

function parseManifest(path: string): CodeMonikerRuntimeManifest {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid Code Moniker runtime manifest ${path}: ${errorMessage(error)}`);
  }
  if (!isRuntimeManifest(value)) {
    throw new Error(`Invalid Code Moniker runtime manifest contract: ${path}`);
  }
  return value;
}

function isRuntimeManifest(value: unknown): value is CodeMonikerRuntimeManifest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CodeMonikerRuntimeManifest>;
  return (
    candidate.format === 2 &&
    typeof candidate.platform === "string" &&
    typeof candidate.arch === "string" &&
    typeof candidate.target === "string" &&
    typeof candidate.clientVersion === "string" &&
    Number.isInteger(candidate.protocolVersion) &&
    typeof candidate.binaryVersion === "string" &&
    typeof candidate.source === "string" &&
    typeof candidate.clientEntry === "string" &&
    typeof candidate.nodeEntry === "string" &&
    typeof candidate.binary === "string" &&
    /^[0-9a-f]{64}$/.test(candidate.binarySha256 ?? "")
  );
}

function requiredFile(rootPath: string, relativePath: string, label: string): string {
  const path = resolveInside(rootPath, relativePath);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`The installed Code Moniker runtime is missing its ${label}: ${path}`);
  }
  return path;
}

function resolveInside(rootPath: string, relativePath: string): string {
  const path = resolve(rootPath, relativePath);
  if (path !== rootPath && !path.startsWith(`${rootPath}${sep}`)) {
    throw new Error(`Code Moniker runtime path escapes its installation root: ${relativePath}`);
  }
  return path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
