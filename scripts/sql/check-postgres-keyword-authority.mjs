#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(".");
const failures = [];
const generatedCheck = spawnSync(
  process.execPath,
  [resolve(root, "scripts/sql/generate-postgres-keywords.mjs"), "--check"],
  { cwd: root, encoding: "utf8" },
);
if (generatedCheck.status !== 0) {
  failures.push(generatedCheck.stderr.trim() || generatedCheck.stdout.trim());
}

const generatedPath = resolve(root, "packages/sql/src/analysis/generated/postgresKeywords.ts");
const grammarKindsPath = resolve(root, "packages/sql/src/analysis/grammarKinds.ts");
const generated = readFileSync(generatedPath, "utf8");
const grammarKinds = readFileSync(grammarKindsPath, "utf8");
const sqlCatalogWords = keywordWords(
  generatedArrayBody(generated, "GENERATED_POSTGRES_SQL_KEYWORDS"),
);
const plpgsqlCatalogWords = keywordWords(
  generatedArrayBody(generated, "GENERATED_PLPGSQL_KEYWORDS"),
);
const sqlGrammarKinds = generatedArrayBody(grammarKinds, "SQL_GRAMMAR_KINDS");
const plpgsqlGrammarKinds = generatedArrayBody(grammarKinds, "PLPGSQL_GRAMMAR_KINDS");
const sqlGrammarWords = new Set(
  [...sqlGrammarKinds.matchAll(/^ {2}"kw_([a-z][a-z0-9_]*)",$/gmu)].map((match) => match[1]),
);
const plpgsqlGrammarWords = new Set(
  [...plpgsqlGrammarKinds.matchAll(/^ {2}"kw_([a-z][a-z0-9_]*)",$/gmu)].map((match) => match[1]),
);
const unknownSqlGrammarWords = [...sqlGrammarWords]
  .filter((word) => !sqlCatalogWords.has(word))
  .sort();
if (unknownSqlGrammarWords.length > 0) {
  failures.push(
    `The SQL grammar exposes keyword kinds absent from PostgreSQL's locked SQL catalog: ${unknownSqlGrammarWords.join(", ")}`,
  );
}
const unknownPlpgsqlGrammarWords = [...plpgsqlGrammarWords]
  .filter((word) => !plpgsqlCatalogWords.has(word))
  .sort();
if (unknownPlpgsqlGrammarWords.length > 0) {
  failures.push(
    `The PL/pgSQL grammar exposes keyword kinds absent from PostgreSQL's locked PL/pgSQL catalog: ${unknownPlpgsqlGrammarWords.join(", ")}`,
  );
}

const prunedSqlCatalogWords = [...sqlCatalogWords]
  .filter((word) => !sqlGrammarWords.has(word))
  .sort();
const prunedPlpgsqlCatalogWords = [...plpgsqlCatalogWords]
  .filter((word) => !plpgsqlGrammarWords.has(word))
  .sort();
if (prunedSqlCatalogWords.length > 0) {
  failures.push(
    `The SQL catalog/grammar drifted; expected no catalog-only words, got: ${prunedSqlCatalogWords.join(", ")}`,
  );
}
if (prunedPlpgsqlCatalogWords.join(",") !== "elseif,to") {
  failures.push(
    `The PL/pgSQL catalog/grammar drifted; expected catalog-only words elseif,to, got: ${prunedPlpgsqlCatalogWords.join(",") || "none"}`,
  );
}

for (const file of sourceFiles(["packages", "vscode-extension/src"])) {
  if (file.name.endsWith("analysis/generated/postgresKeywords.ts")) continue;
  if (/const\s+[A-Z0-9_]*KEYWORDS[A-Z0-9_]*[^=]*=\s*\[/u.test(file.text)) {
    failures.push(
      `${file.name} declares a keyword array. Derive atomic PostgreSQL vocabulary from postgresKeywordCatalog instead.`,
    );
  }
  if (file.text.includes("POSTGRES_STATEMENT_PHRASES")) {
    failures.push(
      `${file.name} uses the former hand-written statement list. Contextual proposals require the explicit completion design.`,
    );
  }
  if (file.text.includes("POSTGRES_AUTHORING_SNIPPET")) {
    failures.push(
      `${file.name} restores a hand-selected multi-keyword completion table. Sequences must be calculated from grammar expectations.`,
    );
  }
  if (
    /(?:semanticTokens|lexicalTokens|highlight)\.[cm]?[jt]sx?$/u.test(file.name) &&
    file.text.includes("postgresSqlKeywordCompletions")
  ) {
    failures.push(
      `${file.name} imports completion vocabulary into colouring. Keyword occurrences must come from parse facts.`,
    );
  }
  if (
    !file.name.endsWith("analysis/postgresKeywordCatalog.ts") &&
    !file.name.endsWith(".test.ts") &&
    file.text.includes("POSTGRES_SQL_KEYWORDS") &&
    file.text.includes("PLPGSQL_KEYWORDS")
  ) {
    failures.push(
      `${file.name} consumes both SQL and PL/pgSQL keyword catalogs. Split the consumers by explicit language context.`,
    );
  }
  if (/\b(?:POSTGRES_KEYWORDS|POSTGRES_KEYWORD_SOURCE|PostgresKeyword)\b/u.test(file.text)) {
    failures.push(
      `${file.name} uses an ambiguous SQL/PL/pgSQL keyword authority name. Name the language explicitly.`,
    );
  }
  if (
    /\[\s*\.\.\.POSTGRES_SQL_KEYWORDS\s*,\s*\.\.\.PLPGSQL_KEYWORDS|\[\s*\.\.\.PLPGSQL_KEYWORDS\s*,\s*\.\.\.POSTGRES_SQL_KEYWORDS/su.test(
      file.text,
    )
  ) {
    failures.push(
      `${file.name} merges the SQL and PL/pgSQL keyword catalogs. Every consumer must select one language context.`,
    );
  }
  if (/^packages\/(?:editor|shell|views)\//u.test(file.name)) {
    for (const match of file.text.matchAll(
      /\b(?:register[A-Z][A-Za-z0-9]*Provider[A-Za-z0-9]*|set(?:Monarch)?TokensProvider)\s*\(/gu,
    )) {
      const localProvider = match[0].replace(/\s*\($/u, "");
      failures.push(
        `${file.name} calls ${localProvider}, a parallel Monaco language provider. SQL and PL/pgSQL features must come from the SQL authoring LSP client.`,
      );
    }
  }
}

for (const file of allFiles("vscode-extension", (name) => name.endsWith(".tmLanguage.json"))) {
  if (file.name.endsWith(".tmLanguage.json")) {
    failures.push(
      `${file.name} is a parallel TextMate grammar. SQL and PL/pgSQL colouring must come from the SQL authoring server.`,
    );
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `PostgreSQL keyword authority:\n${failures.map((line) => `  ${line}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `PostgreSQL keyword authority:\n` +
    `  SQL ${sqlCatalogWords.size} official entries; ${sqlGrammarWords.size} grammar keyword kinds; ${prunedSqlCatalogWords.length} catalog entries not exposed as kw_* kinds.\n` +
    `  PL/pgSQL ${plpgsqlCatalogWords.size} official entries; ${plpgsqlGrammarWords.size} grammar keyword kinds; ${prunedPlpgsqlCatalogWords.length} catalog entries not exposed as kw_* kinds.\n`,
);

function sourceFiles(directories) {
  return directories.flatMap((directory) =>
    allFiles(directory, (name) => /\.[cm]?[jt]sx?$/u.test(name)),
  );
}

function generatedArrayBody(source, name) {
  const declaration = source.indexOf(`export const ${name}`);
  const start = source.indexOf("[", declaration);
  const plainEnd = source.indexOf("\n];", start);
  const constEnd = source.indexOf("\n] as const;", start);
  const end = [plainEnd, constEnd].filter((candidate) => candidate >= 0).sort((a, b) => a - b)[0];
  if (declaration < 0 || start < 0 || end === undefined) {
    throw new Error(`Cannot isolate ${name} from generated grammar kinds`);
  }
  return source.slice(start, end + 1);
}

function keywordWords(arrayBody) {
  return new Set(
    [...arrayBody.matchAll(/\{ word: "([a-z][a-z0-9_]*)",/gu)].map((match) => match[1]),
  );
}

function allFiles(directory, accept = () => true) {
  const base = resolve(root, directory);
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".vscode-test")
        continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!accept(entry.name)) continue;
      found.push({ name: relative(root, path), text: readFileSync(path, "utf8") });
    }
  };
  walk(base);
  return found;
}
