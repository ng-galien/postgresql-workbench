import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = mkdtempSync(resolve(tmpdir(), "postgresql-catalog-package-"));
const consumer = resolve(temporary, "consumer");
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run through npm run test:catalog:package");
const runNpm = (args, cwd) =>
  execFileSync(process.execPath, [npm, "--cache", resolve(temporary, "cache"), ...args], {
    cwd,
    encoding: "utf8",
    timeout: 180_000,
  });
const report = JSON.parse(
  runNpm(
    [
      "pack",
      resolve(root, "packages/catalog"),
      "--offline",
      "--json",
      "--pack-destination",
      temporary,
    ],
    root,
  ),
);
const packed = Array.isArray(report) ? report[0] : Object.values(report)[0];
assert(packed.files.some(({ path }) => path === "dist/types/catalog/src/index.d.ts"));
assert(
  packed.files.every(
    ({ path }) =>
      ["README.md", "LICENSE", "package.json", "dist/index.mjs"].includes(path) ||
      /^dist\/types\/(catalog|sql)\/.*\.d\.ts$/.test(path),
  ),
);
mkdirSync(consumer);
writeFileSync(resolve(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
runNpm(
  [
    "install",
    "--engine-strict",
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    resolve(temporary, packed.filename),
  ],
  consumer,
);
runNpm(
  ["ci", "--engine-strict", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
  consumer,
);
const installed = resolve(consumer, "node_modules/@ng-galien/postgresql-catalog");
const manifest = JSON.parse(readFileSync(resolve(installed, "package.json"), "utf8"));
assert.equal(manifest.name, packed.name);
assert.equal(manifest.version, packed.version);
assert.equal(manifest.engines.node, ">=22.0.0");
assert.equal(manifest.license, "MIT");
assert.deepEqual(manifest.dependencies ?? {}, {});
assert.equal(
  readFileSync(resolve(installed, "LICENSE"), "utf8"),
  readFileSync(resolve(root, "LICENSE"), "utf8"),
);
const source = `import {
  readPostgresCatalog, readPostgresCatalogDocuments, assemblePostgresStructureSql,
  comparePostgresStructures, createCodeMonikerSyntaxParser, PostgresCatalogFullRefreshRequired,
} from '@ng-galien/postgresql-catalog';
import type {
  CatalogQueryClient, PostgresCatalogPatch, PostgresStructureComparisonMode,
  CodeMonikerStructureComparisonClient, CodeMonikerSyntaxClient, SyntaxParser,
} from '@ng-galien/postgresql-catalog';
const client: CatalogQueryClient = { query: async () => ({ rows: [{
  schemas: [], types: [], tables: [], columns: [], constraints: [], indexes: [],
  views: [], view_dependencies: [], routines: [], triggers: [],
}] }) };
const snapshot = await readPostgresCatalog(client, { connectionId: 'smoke', database: 'smoke' });
if (snapshot.sourceSet.documents.length !== 0) throw Error('Expected empty catalog');
if (assemblePostgresStructureSql(snapshot.sourceSet.documents) !== '\\n') throw Error('Invalid SQL');
const patch: PostgresCatalogPatch = await readPostgresCatalogDocuments(client,
  { connectionId: 'smoke', database: 'smoke' }, [], new Set());
if (patch.upsertDocuments.length !== 0) throw Error('Invalid patch');
const comparisonClient: CodeMonikerStructureComparisonClient = {
  diffImpact: { compare: async () => ({ diagnostics: [], symbol_changes: [], ref_changes: [] }) },
};
const mode: PostgresStructureComparisonMode = 'semantic';
const comparison = await comparePostgresStructures(comparisonClient, [], [], 'smoke', mode);
if (!comparison.isomorphic) throw Error('Invalid comparison');
const syntaxClient: CodeMonikerSyntaxClient = {
  queryData: async () => { throw Error('The semantic comparison must not parse'); },
};
const parser: SyntaxParser = createCodeMonikerSyntaxParser(syntaxClient);
await comparePostgresStructures(comparisonClient, [], [], 'smoke', mode, parser);
if (!(new PostgresCatalogFullRefreshRequired('smoke') instanceof Error)) throw Error('Invalid error');
`;
writeFileSync(resolve(consumer, "consumer.mts"), source);
execFileSync(
  process.execPath,
  [
    resolve(root, "node_modules/typescript/bin/tsc"),
    "--ignoreConfig",
    "--strict",
    "--target",
    "ES2022",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "consumer.mts",
  ],
  { cwd: consumer, stdio: "inherit" },
);
execFileSync(process.execPath, ["consumer.mjs"], { cwd: consumer, stdio: "inherit" });

// Compile and execute against the real published client, not a look-alike mock.
const compatibility = resolve(temporary, "compatibility");
mkdirSync(compatibility);
for (const file of ["package.json", "package-lock.json"]) {
  copyFileSync(resolve(root, "scripts/catalog/compatibility", file), resolve(compatibility, file));
}
runNpm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], compatibility);
runNpm(
  [
    "install",
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    resolve(temporary, packed.filename),
  ],
  compatibility,
);
copyFileSync(
  resolve(root, "scripts/catalog/compatibility/consumer.mts"),
  resolve(compatibility, "consumer.mts"),
);
execFileSync(
  process.execPath,
  [
    resolve(root, "node_modules/typescript/bin/tsc"),
    "--ignoreConfig",
    "--strict",
    "--target",
    "ES2022",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "consumer.mts",
    "--types",
    "node",
    "--typeRoots",
    resolve(root, "node_modules/@types"),
  ],
  { cwd: compatibility, stdio: "inherit" },
);
const workspace = resolve(temporary, "workspace");
mkdirSync(workspace);
execFileSync(process.execPath, ["consumer.mjs", workspace], {
  cwd: compatibility,
  stdio: "inherit",
  timeout: 60_000,
});
process.stdout.write(
  `Catalog package: isolated ESM, TypeScript and offline npm ci passed on ${process.version}.\n`,
);
process.stdout.write(
  `${packed.name}@${packed.version}\n${resolve(temporary, packed.filename)}\n${packed.integrity}\n`,
);
