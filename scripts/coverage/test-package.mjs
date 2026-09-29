import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = mkdtempSync(resolve(tmpdir(), "postgresql-coverage-package-"));
const consumer = resolve(temporary, "consumer");
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run through npm run test:coverage:package");
const runNpm = (args, cwd) =>
  execFileSync(process.execPath, [npm, ...args], { cwd, encoding: "utf8", timeout: 180_000 });

try {
  const report = JSON.parse(
    runNpm(
      ["pack", resolve(root, "packages/coverage"), "--json", "--pack-destination", temporary],
      root,
    ),
  );
  const packed = Array.isArray(report) ? report[0] : Object.values(report)[0];
  assert(packed.files.some(({ path }) => path === "dist/types/coverage/src/standalone.d.ts"));
  assert(
    packed.files.every(
      ({ path }) =>
        ["README.md", "LICENSE", "package.json", "dist/index.cjs", "dist/cli.cjs"].includes(path) ||
        /^dist\/types\/(coverage|sql)\/.*\.d\.ts$/.test(path),
    ),
  );
  mkdirSync(consumer);
  writeFileSync(
    resolve(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  runNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", resolve(temporary, packed.filename)],
    consumer,
  );
  const source = `import { Client } from 'pg';
import { StandaloneCoverage, coverageAsLcov } from '@ng-galien/postgresql-coverage';
const coverage = new StandaloneCoverage(async () => { const client = new Client(); await client.connect(); return client; });
void coverage.dispose();
coverageAsLcov([]);
`;
  for (const extension of ["mts", "cts"]) {
    const file = resolve(consumer, `consumer.${extension}`);
    writeFileSync(file, source);
    execFileSync(
      process.execPath,
      [
        resolve(root, "node_modules/typescript/bin/tsc"),
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--target",
        "ES2022",
        "--module",
        "Node16",
        "--moduleResolution",
        "Node16",
        file,
      ],
      { cwd: consumer, stdio: "inherit" },
    );
  }
  execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: consumer,
    stdio: "inherit",
  });
  execFileSync(
    process.execPath,
    [
      "-e",
      "const { StandaloneCoverage } = require('@ng-galien/postgresql-coverage'); new StandaloneCoverage(() => { throw Error('unused'); }).dispose();",
    ],
    { cwd: consumer, stdio: "inherit" },
  );
  const command = [npm, "exec", "--offline", "--", "postgresql-coverage"];
  assert.match(
    execFileSync(process.execPath, [...command, "--help"], { cwd: consumer, encoding: "utf8" }),
    /PGDATABASE/,
  );
  const invalid = spawnSync(process.execPath, [...command, "--format", "bad"], {
    cwd: consumer,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(invalid.status, 2, invalid.stderr);
  if (process.argv.includes("--e2e")) {
    copyFileSync(
      resolve(root, "scripts/coverage/package-smoke.mjs"),
      resolve(consumer, "smoke.mjs"),
    );
    execFileSync(process.execPath, ["smoke.mjs"], {
      cwd: consumer,
      stdio: "inherit",
      timeout: 180_000,
    });
  }
  process.stdout.write("Coverage package: isolated CJS/ESM, TypeScript and CLI checks passed.\n");
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
