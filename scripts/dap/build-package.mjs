import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..", "..");
const packageRoot = resolve(repositoryRoot, "packages", "dap");
const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
const outputDirectory = resolve(packageRoot, "dist");
const outputFile = resolve(outputDirectory, "postgresql-dap.js");

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });

const result = await build({
  entryPoints: [resolve(repositoryRoot, "packages", "dap", "src", "main.ts")],
  outfile: outputFile,
  bundle: true,
  packages: "external",
  platform: "node",
  format: "cjs",
  target: "node22",
  banner: { js: "#!/usr/bin/env node" },
  define: {
    __POSTGRESQL_DAP_VERSION__: JSON.stringify(manifest.version),
  },
  sourcemap: false,
  minify: false,
  legalComments: "none",
  metafile: true,
});

const forbiddenInputs = Object.keys(result.metafile.inputs).filter((input) =>
  input.replaceAll("\\", "/").includes("packages/catalog/src/"),
);
if (forbiddenInputs.length > 0) {
  throw new Error(
    `The standalone DAP crossed the Workbench/index boundary:\n${forbiddenInputs.join("\n")}`,
  );
}

const output = Object.values(result.metafile.outputs).find((candidate) => candidate.entryPoint);
const forbiddenImports = output?.imports.filter(({ path }) => path === "@code-moniker/client/node");
if (forbiddenImports && forbiddenImports.length > 0) {
  throw new Error("The standalone DAP must not import the Code Moniker daemon runtime");
}

chmodSync(outputFile, 0o755);
process.stderr.write(`Built ${manifest.name}@${manifest.version} at ${outputFile}\n`);
