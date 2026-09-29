import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  coverageAsLcov,
  executePgTapTest,
  mapCoverageToSource,
  StandaloneCoverage,
} from "@ng-galien/postgresql-coverage";
import { Client } from "pg";

const schema = `coverage_package_${randomUUID().replaceAll("-", "")}`;
const failureSchema = `${schema}_fail`;
const client = new Client({ connectionTimeoutMillis: 5_000 });
await client.connect();
const coverage = new StandaloneCoverage(async () => {
  const dedicated = new Client({ connectionTimeoutMillis: 5_000 });
  await dedicated.connect();
  return dedicated;
});
try {
  const extension = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'pgtap'");
  assert.equal(extension.rowCount, 1, "The test database must have pgTAP installed");
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`CREATE SCHEMA ${failureSchema}`);
  await client.query(`CREATE FUNCTION ${schema}.subject(value integer) RETURNS integer LANGUAGE plpgsql AS $$
BEGIN
  IF value > 0 THEN
    RETURN value;
  ELSE
    RETURN -value;
  END IF;
END;
$$`);
  await client.query(
    `CREATE FUNCTION ${schema}.uncalled() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN 42; END; $$`,
  );
  for (const [name, expected] of [
    ["passing", 2],
    ["failing", 999],
  ]) {
    await client.query(`CREATE FUNCTION ${name === "passing" ? schema : failureSchema}.${name}() RETURNS SETOF text LANGUAGE plpgsql AS $$
BEGIN
  RETURN NEXT plan(2);
  RETURN NEXT is(${schema}.subject(2), ${expected}, 'positive');
  RETURN NEXT is(${schema}.subject(-2), 2, 'negative');
  RETURN QUERY SELECT * FROM finish();
END;
$$`);
  }
  const definition = async () =>
    (
      await client.query("SELECT pg_get_functiondef($1::regprocedure) AS ddl", [
        `${schema}.subject(integer)`,
      ])
    ).rows[0].ddl;
  const before = await definition();
  const result = await coverage.runSchema({ schema });
  assert.equal(result.tests.failed, 0);
  assert.deepEqual(result.summary.routines, { covered: 1, total: 2 });
  const subject = result.routines.find(({ routine }) => routine.name === "subject");
  assert(subject.coverage.branch.total > 0);
  assert.equal(subject.coverage.branch.covered, subject.coverage.branch.total);
  const uncalled = result.routines.find(({ routine }) => routine.name === "uncalled");
  assert.equal(uncalled.coverage.statement.covered, 0);
  assert(uncalled.coverage.statement.total > 0);
  assert.match(
    coverageAsLcov([
      {
        uri: "subject.sql",
        statements: mapCoverageToSource(subject.bodyStartLine, subject.coverage).statements,
      },
    ]),
    /BRH:[1-9]/,
  );
  assert.equal(await definition(), before);
  await coverage.dispose();
  const runCli = (args) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [process.env.npm_execpath, "exec", "--offline", "--", "postgresql-coverage", ...args],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  const base = ["--schema", schema];
  const passed = await runCli([...base, "--output", "coverage.lcov"]);
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.stdout, "");
  assert.match(await readFile("coverage.lcov", "utf8"), /BRH:[1-9]/);
  assert.equal(await definition(), before);
  await client.query(`ALTER FUNCTION ${schema}.passing() SET SCHEMA ${failureSchema}`);
  await client.query(
    `CREATE FUNCTION ${schema}.labels() RETURNS SETOF text LANGUAGE plpgsql AS $$ BEGIN RETURN NEXT 'business value'; END; $$`,
  );
  const failed = await runCli([...base, "--test-schema", failureSchema, "--format", "json"]);
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(JSON.parse(failed.stdout).files.length, 3);
  assert.deepEqual(JSON.parse(failed.stdout).summary.routines, { covered: 1, total: 3 });
  assert.equal(
    JSON.parse(failed.stdout).tests.total,
    4,
    JSON.stringify(JSON.parse(failed.stdout).tests),
  );
  assert(
    JSON.parse(failed.stdout).files.some(
      (file) =>
        file.uri.includes("labels") &&
        file.statements.every((statement) => statement.executed === 0),
    ),
  );
  const patterned = await runCli([
    "--pattern",
    `${schema}.sub*`,
    "--test-pattern",
    `${failureSchema}.pass*`,
    "--format",
    "json",
  ]);
  assert.equal(patterned.status, 0, patterned.stderr);
  assert.equal(JSON.parse(patterned.stdout).files.length, 1);
  assert.deepEqual(JSON.parse(patterned.stdout).summary.routines, { covered: 1, total: 1 });
  const noMatch = await runCli(["--pattern", `${schema}.missing*`, "--test-schema", failureSchema]);
  assert.equal(noMatch.status, 2, noMatch.stderr);
  assert.equal(await definition(), before);
  const missing = await runCli([...base, "--test-schema", `${schema}_missing`]);
  assert.equal(missing.status, 2, missing.stderr);
  await client.query("BEGIN");
  try {
    const bounded = await executePgTapTest(
      client,
      { schema: failureSchema, name: "failing", runnable: true },
      5000,
      16,
    );
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.valid, false);
    assert(Buffer.byteLength(bounded.output.join(""), "utf8") <= 16);
  } finally {
    await client.query("ROLLBACK");
  }
  process.stdout.write(
    "Coverage package: real PostgreSQL library/CLI, pgTAP pass/fail, reports and rollback passed.\n",
  );
} finally {
  await coverage.dispose();
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`DROP SCHEMA IF EXISTS ${failureSchema} CASCADE`);
  await client.end();
}
