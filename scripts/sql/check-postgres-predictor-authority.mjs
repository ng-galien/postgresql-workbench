#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const SOURCE_ROOT = resolve(ROOT, "scripts/sql/upstream/postgresql/REL_18_4");
const GENERATED = resolve(ROOT, "packages/sql/src/authoring/generated/postgresPredictorTables.ts");
const SCANNER_SOURCES = [
  "packages/sql/src/authoring/postgresPredictorScanner.ts",
  "packages/sql/src/authoring/postgresSqlPredictorLanguage.ts",
  "packages/sql/src/authoring/plpgsqlPredictorLanguage.ts",
].map((path) => resolve(ROOT, path));

const source = readFileSync(GENERATED, "utf8");
const authority = generatedAuthority(source);
const sqlTable = generatedTable(source, "SQL_PREDICTOR_TABLES");
const plpgsqlTable = generatedTable(source, "PLPGSQL_PREDICTOR_TABLES");
const expected = {
  postgresRef: "REL_18_4",
  postgresVersion: "18.4",
  sqlGrammarDigest: sha256(readFileSync(resolve(SOURCE_ROOT, "gram.y"))),
  plpgsqlGrammarDigest: sha256(readFileSync(resolve(SOURCE_ROOT, "pl_gram.y"))),
  sqlKeywordDigest: sha256(readFileSync(resolve(SOURCE_ROOT, "kwlist.h"))),
  plpgsqlKeywordDigest: sha256(
    Buffer.concat([
      readFileSync(resolve(SOURCE_ROOT, "pl_reserved_kwlist.h")),
      readFileSync(resolve(SOURCE_ROOT, "pl_unreserved_kwlist.h")),
    ]),
  ),
  scannerDigest: sha256(Buffer.concat(SCANNER_SOURCES.map((path) => readFileSync(path)))),
  predictorDigest: sha256(Buffer.from(`${sqlTable}\n${plpgsqlTable}`)),
  projectionDigest: sha256(
    readFileSync(resolve(ROOT, "scripts/sql/postgres-predictor-projection.json")),
  ),
};

const failures = [];
for (const [name, value] of Object.entries(expected)) {
  if (authority[name] !== value)
    failures.push(`${name}: generated=${authority[name]} source=${value}`);
}
if (authority.generatorName !== "gnu-bison" || !authority.generatorVersion) {
  failures.push("generator identity is missing from the generated authority");
}

if (failures.length > 0) {
  process.stderr.write(
    `PostgreSQL predictor authority is stale:\n${failures.map((failure) => `  ${failure}`).join("\n")}\n` +
      `Run node scripts/sql/generate-postgres-predictor.mjs with GNU Bison.\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `PostgreSQL predictor authority verified (${authority.postgresRef}, GNU Bison ${authority.generatorVersion}).\n`,
);

function generatedAuthority(generated) {
  const match = /export const POSTGRES_PREDICTOR_AUTHORITY = (\{[\s\S]*?\}) as const;/u.exec(
    generated,
  );
  if (!match) throw new Error(`${GENERATED} does not expose POSTGRES_PREDICTOR_AUTHORITY`);
  return JSON.parse(match[1]);
}

function generatedTable(generated, name) {
  const declaration = `export const ${name}: GeneratedPostgresParserTables = `;
  const start = generated.indexOf(declaration);
  const end = generated.indexOf(";\n", start);
  if (start < 0 || end < 0) throw new Error(`${GENERATED} does not expose ${name}`);
  return generated.slice(start + declaration.length, end);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
