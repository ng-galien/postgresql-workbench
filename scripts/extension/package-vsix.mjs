import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodeMonikerTarget } from "./code-moniker-target.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(scriptDirectory, "..", "..", "vscode-extension");
const manifest = JSON.parse(readFileSync(resolve(extensionRoot, "package.json"), "utf8"));
const requested = process.argv.slice(2);
const explicitTarget = optionValue(requested, "--target");
const target = resolveCodeMonikerTarget(explicitTarget);
const runtimeManifest = JSON.parse(
  readFileSync(resolve(extensionRoot, "runtime", "code-moniker", "manifest.json"), "utf8"),
);
if (runtimeManifest.target !== target) {
  throw new Error(
    `Staged Code Moniker runtime targets ${runtimeManifest.target}, requested VSIX targets ${target}`,
  );
}
const args = ["package", "--no-dependencies", ...requested];
if (!explicitTarget) args.push("--target", target);
if (!optionValue(requested, "--out")) {
  args.push("--out", `postgresql-workbench-${manifest.version}-${target}.vsix`);
}

const vsce = resolve(extensionRoot, "node_modules", "@vscode", "vsce", "vsce");
execFileSync(process.execPath, [vsce, ...args], {
  cwd: extensionRoot,
  stdio: "inherit",
});

function optionValue(args, name) {
  const direct = args.find((argument) => argument.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}
