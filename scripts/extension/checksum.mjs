import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodeMonikerTarget } from "./code-moniker-target.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(scriptDirectory, "..", "..", "vscode-extension");
const manifest = JSON.parse(readFileSync(resolve(extensionRoot, "package.json"), "utf8"));
const target = resolveCodeMonikerTarget();
const [argument = `postgresql-workbench-${manifest.version}-${target}.vsix`] =
  process.argv.slice(2);

const path = resolve(extensionRoot, argument);
const checksum = createHash("sha256").update(readFileSync(path)).digest("hex");
writeFileSync(`${path}.sha256`, `${checksum}  ${basename(path)}\n`);
process.stdout.write(`${path}.sha256\n`);
