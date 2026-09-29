import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageRoot = resolve(root, "packages/coverage");
const output = resolve(packageRoot, "dist");
rmSync(output, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
mkdirSync(output, { recursive: true });
copyFileSync(resolve(root, "LICENSE"), resolve(packageRoot, "LICENSE"));
for (const [entry, name] of [
  ["standalone", "index"],
  ["cli", "cli"],
]) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [resolve(packageRoot, `src/${entry}.ts`)],
    outfile: resolve(output, `${name}.cjs`),
    bundle: true,
    packages: "external",
    platform: "node",
    format: "cjs",
    target: "node24",
    ...(name === "cli" ? { banner: { js: "#!/usr/bin/env node" } } : {}),
    legalComments: "none",
    metafile: true,
  });
  const forbidden = Object.keys(result.metafile.inputs).filter(
    (file) => !/packages\/(coverage|sql)\//.test(file.replaceAll("\\", "/")),
  );
  if (forbidden.length)
    throw new Error(`Unexpected coverage dependencies: ${forbidden.join(", ")}`);
}
chmodSync(resolve(output, "cli.cjs"), 0o755);
execFileSync(
  process.execPath,
  [
    resolve(root, "node_modules/typescript/bin/tsc"),
    "-p",
    resolve(packageRoot, "tsconfig.build.json"),
  ],
  { cwd: root, stdio: "inherit" },
);
