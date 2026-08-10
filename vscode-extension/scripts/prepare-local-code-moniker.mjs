import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(scriptDirectory, "..");
const repositoryRoot = resolve(extensionRoot, "..");
const checkout = resolve(
  process.env.CODE_MONIKER_CHECKOUT ?? resolve(repositoryRoot, "..", "code-moniker"),
);
const clientRoot = resolve(checkout, "packages", "client");
if (!existsSync(resolve(clientRoot, "package-lock.json"))) {
  throw new Error(`Code Moniker client checkout is missing: ${clientRoot}`);
}

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("Local Code Moniker preparation must run through npm");
}
run(process.execPath, [npmCli, "ci", "--omit=optional"], clientRoot);
run(process.execPath, [npmCli, "run", "build"], clientRoot);
run("cargo", ["build", "--release", "-p", "code-moniker", "--bin", "code-moniker"], checkout);

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}
