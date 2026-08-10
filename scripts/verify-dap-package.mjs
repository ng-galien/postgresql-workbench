import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDirectory, "..", "packages", "postgresql-dap");
const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
const binary = resolve(packageRoot, manifest.bin["postgresql-dap"]);

if (!statSync(binary).isFile()) throw new Error(`Missing DAP executable: ${binary}`);
if (process.platform !== "win32") accessSync(binary, constants.X_OK);

const source = readFileSync(binary, "utf8");
if (!source.startsWith("#!/usr/bin/env node\n")) {
  throw new Error("The packaged DAP executable is missing its Node.js shebang");
}
for (const required of [
  "@code-moniker/client",
  "code_moniker_read",
  "--check-code-moniker",
]) {
  if (!source.includes(required)) {
    throw new Error(`The packaged DAP executable is missing ${required}`);
  }
}
for (const forbidden of [
  "NodeDaemonRuntime",
  "ensureLocalCodeMonikerWorkspace",
  "connectLocalCodeMoniker",
  "PLPGSQL_CODE_MONIKER_DAEMON",
  "PLPGSQL_CODE_MONIKER_WORKSPACE_ROOTS",
]) {
  if (source.includes(forbidden)) {
    throw new Error(`The standalone DAP contains forbidden workspace coupling: ${forbidden}`);
  }
}
const codeMonikerTools = new Set(source.match(/\bcode_moniker_[a-z_]+\b/g) ?? []);
for (const tool of codeMonikerTools) {
  if (tool !== "code_moniker_read") {
    throw new Error(`The standalone DAP calls a forbidden Code Moniker tool: ${tool}`);
  }
}
if (source.includes("must point to the packaged runtime directory")) {
  throw new Error("The standalone DAP still requires a VSIX Code Moniker runtime path");
}

process.stderr.write(`Verified ${manifest.name}@${manifest.version} package payload\n`);
