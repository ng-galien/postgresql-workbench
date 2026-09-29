import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageRoot = resolve(root, "packages/catalog");
const output = resolve(packageRoot, "dist");
rmSync(output, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
mkdirSync(output, { recursive: true });
copyFileSync(resolve(root, "LICENSE"), resolve(packageRoot, "LICENSE"));
await build({
  absWorkingDir: root,
  entryPoints: [resolve(packageRoot, "src/index.ts")],
  outfile: resolve(output, "index.mjs"),
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  legalComments: "none",
});
execFileSync(
  process.execPath,
  [
    resolve(root, "node_modules/typescript/bin/tsc"),
    "-p",
    resolve(packageRoot, "tsconfig.build.json"),
  ],
  { cwd: root, stdio: "inherit" },
);
