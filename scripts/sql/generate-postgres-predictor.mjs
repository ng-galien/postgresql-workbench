#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const SOURCE_ROOT = resolve(ROOT, "scripts/sql/upstream/postgresql/REL_18_4");
const OUTPUT = resolve(ROOT, "packages/sql/src/authoring/generated/postgresPredictorTables.ts");
const SQL_GRAMMAR = resolve(SOURCE_ROOT, "gram.y");
const PLPGSQL_GRAMMAR = resolve(SOURCE_ROOT, "pl_gram.y");
const SQL_KEYWORDS = resolve(SOURCE_ROOT, "kwlist.h");
const PLPGSQL_RESERVED = resolve(SOURCE_ROOT, "pl_reserved_kwlist.h");
const PLPGSQL_UNRESERVED = resolve(SOURCE_ROOT, "pl_unreserved_kwlist.h");
const SCANNER = resolve(ROOT, "packages/sql/src/authoring/postgresPredictorScanner.ts");
const SQL_LANGUAGE = resolve(ROOT, "packages/sql/src/authoring/postgresSqlPredictorLanguage.ts");
const PLPGSQL_LANGUAGE = resolve(ROOT, "packages/sql/src/authoring/plpgsqlPredictorLanguage.ts");
const PROJECTION = resolve(ROOT, "scripts/sql/postgres-predictor-projection.json");

const EXPECTED_SQL_GRAMMAR_SHA256 =
  "7e548b673a1e03eb3a56c5eb9ad92d8e11095fac76e14cb258ca851f58274724";
const EXPECTED_PLPGSQL_GRAMMAR_SHA256 =
  "6e2848c63f851964c9df4a99681b51c9a2fbbfb5acf6896716f61b6ec9bed790";

const sqlGrammar = verified(SQL_GRAMMAR, EXPECTED_SQL_GRAMMAR_SHA256);
const plpgsqlGrammar = verified(PLPGSQL_GRAMMAR, EXPECTED_PLPGSQL_GRAMMAR_SHA256);
const projection = JSON.parse(readFileSync(PROJECTION, "utf8"));
validateProjection(projection);

const temporary = mkdtempSync(join(tmpdir(), "pgwb-postgres-predictor-"));
try {
  const sql = generateGrammar("sql", SQL_GRAMMAR, temporary, projection.sqlSlots);
  const plpgsql = generateGrammar("plpgsql", PLPGSQL_GRAMMAR, temporary);
  const bisonVersion = execFileSync("bison", ["--version"], { encoding: "utf8" })
    .split("\n")[0]
    .replace(/^bison \(GNU Bison\) /u, "");
  const source = render({
    bisonVersion,
    sql,
    plpgsql,
    authority: {
      postgresRef: "REL_18_4",
      postgresVersion: "18.4",
      sqlGrammarDigest: sha256(sqlGrammar),
      plpgsqlGrammarDigest: sha256(plpgsqlGrammar),
      sqlKeywordDigest: sha256(readFileSync(SQL_KEYWORDS)),
      plpgsqlKeywordDigest: sha256(
        Buffer.concat([readFileSync(PLPGSQL_RESERVED), readFileSync(PLPGSQL_UNRESERVED)]),
      ),
      scannerDigest: sha256(
        Buffer.concat([
          readFileSync(SCANNER),
          readFileSync(SQL_LANGUAGE),
          readFileSync(PLPGSQL_LANGUAGE),
        ]),
      ),
      predictorDigest: sha256(Buffer.from(`${table(sql)}\n${table(plpgsql)}`)),
      projectionDigest: sha256(readFileSync(PROJECTION)),
    },
  });
  if (process.argv.includes("--check")) {
    if (readFileSync(OUTPUT, "utf8") !== source) {
      throw new Error(`${OUTPUT} is stale. Run node ${import.meta.filename}.`);
    }
  } else {
    mkdirSync(resolve(OUTPUT, ".."), { recursive: true });
    writeFileSync(OUTPUT, source);
    process.stdout.write(`PostgreSQL predictor tables written to ${OUTPUT}\n`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

function generateGrammar(name, grammar, directory, slots = undefined) {
  const cFile = resolve(directory, `${name}.c`);
  execFileSync("bison", ["--report=all", "-d", "-v", "-o", cFile, grammar], {
    stdio: "pipe",
  });
  const c = readFileSync(cFile, "utf8");
  const report = readFileSync(resolve(directory, `${name}.output`), "utf8");
  const terminalCount = definition(c, "YYNTOKENS");
  const names = stringArray(c, "yytname");
  const yyr1 = numericArray(c, "yyr1");
  const actionMetadata = name === "plpgsql" ? plpgsqlActionMetadata(c, yyr1.length) : undefined;
  return {
    finalState: definition(c, "YYFINAL"),
    lastIndex: definition(c, "YYLAST"),
    terminalCount,
    pactNinf: definition(c, "YYPACT_NINF"),
    tableNinf: definition(c, "YYTABLE_NINF"),
    terminalByName: Object.fromEntries(
      names.slice(0, terminalCount).map((value, index) => [value, index]),
    ),
    directTerminals: directTerminals(
      report,
      numericArray(c, "yypact").length,
      Object.fromEntries(names.slice(0, terminalCount).map((value, index) => [value, index])),
    ),
    yyr1,
    yyr2: numericArray(c, "yyr2"),
    yydefact: numericArray(c, "yydefact"),
    yydefgoto: numericArray(c, "yydefgoto"),
    yypact: numericArray(c, "yypact"),
    yypgoto: numericArray(c, "yypgoto"),
    yytable: numericArray(c, "yytable"),
    yycheck: numericArray(c, "yycheck"),
    slotMasks: slots ? sqlSlotMasks(report, numericArray(c, "yypact").length, slots) : [],
    nonlocalReductions: actionMetadata?.nonlocalReductions ?? [],
    lookupModeReductions: actionMetadata?.lookupModeReductions ?? [],
  };
}

function directTerminals(report, stateCount, terminalByName) {
  const direct = Array.from({ length: stateCount }, () => []);
  const identifierKeywordRules = new Set([
    "unreserved_keyword",
    "col_name_keyword",
    "type_func_name_keyword",
    "reserved_keyword",
  ]);
  const statePattern = /^state ([0-9]+)\n([\s\S]*?)(?=^state [0-9]+\n|(?![\s\S]))/gimu;
  for (const match of report.matchAll(statePattern)) {
    const state = Number(match[1]);
    let lhs;
    for (const line of match[2].split("\n")) {
      const production = /^\s+[0-9]+\s+([A-Za-z_][A-Za-z0-9_]*):/u.exec(line);
      if (production) lhs = production[1];
      if (!lhs || identifierKeywordRules.has(lhs)) continue;
      const terminal =
        /(?:^\s+[0-9]+\s+(?:[A-Za-z_][A-Za-z0-9_]*:|\|))[^.•]*[.•]\s+([A-Z][A-Z0-9_]*|'(?:\\.|[^'])*')/u.exec(
          line,
        )?.[1];
      const symbol = terminal === undefined ? undefined : terminalByName[terminal];
      if (symbol !== undefined && !direct[state].includes(symbol)) direct[state].push(symbol);
    }
    direct[state].sort((left, right) => left - right);
  }
  return direct;
}

function definition(source, name) {
  const match = new RegExp(`^#define\\s+${name}\\s+\\(?(-?[0-9]+)\\)?`, "mu").exec(source);
  if (!match) throw new Error(`Bison output does not define ${name}`);
  return Number(match[1]);
}

function numericArray(source, name) {
  const match = new RegExp(
    `static const [^;\\n]+\\s+${name}\\[\\]\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`,
    "mu",
  ).exec(source);
  if (!match) throw new Error(`Bison output does not contain ${name}[]`);
  return [...match[1].matchAll(/-?[0-9]+/gu)].map((entry) => Number(entry[0]));
}

function stringArray(source, name) {
  const match = new RegExp(
    `static const char \\*const ${name}\\[\\]\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`,
    "mu",
  ).exec(source);
  if (!match) throw new Error(`Bison output does not contain ${name}[]`);
  return [...match[1].matchAll(/"(?:\\\\.|[^"\\\\])*"/gu)].map((entry) =>
    entry[0]
      .slice(1, -1)
      .replaceAll('\\\\\\"', '"')
      .replaceAll("\\\\\\\\", "\\\\")
      .replaceAll("\\\\'", "'"),
  );
}

function sqlSlotMasks(report, stateCount, slots) {
  const masks = Array(stateCount).fill(0);
  const statePattern = /^state ([0-9]+)\n([\s\S]*?)(?=^state [0-9]+\n|(?![\s\S]))/gimu;
  for (const match of report.matchAll(statePattern)) {
    const state = Number(match[1]);
    const body = match[2].replaceAll("•", ".");
    let mask = 0;
    for (const [bit, slot] of ["relation", "column", "routine", "type", "procedure"].entries()) {
      const rule = slots[slot];
      const hasGoto = rule.nonterminalGotos?.some((name) =>
        new RegExp(`^\\s+${escapeRegExp(name)}\\s+go to state`, "mu").test(body),
      );
      const hasKernel = rule.kernelItems?.some((item) => body.includes(item));
      if (hasGoto || hasKernel) mask |= 1 << bit;
    }
    masks[state] = mask;
  }
  return masks;
}

function plpgsqlActionMetadata(source, ruleCount) {
  const nonlocalReductions = Array(ruleCount).fill(0);
  const lookupModeReductions = Array(ruleCount).fill(0);
  const headers = [...source.matchAll(/^\s*case ([0-9]+):\n#line [0-9]+ "[^"]*pl_gram\.y"\n/gmu)];
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    const rule = Number(header[1]);
    const action = source.slice(header.index, headers[index + 1]?.index ?? source.length);
    if (
      /\b(?:read_sql_[a-z0-9_]*|read_datatype|read_cursor_args|make_execsql_stmt|make_return_[a-z0-9_]*|make_dynexecute_stmt|make_fetch_stmt|make_case)\s*\(/u.test(
        action,
      )
    ) {
      nonlocalReductions[rule] = 1;
    }
    const lookup = /IDENTIFIER_LOOKUP_(DECLARE|NORMAL|EXPR)/u.exec(action)?.[1];
    lookupModeReductions[rule] =
      lookup === "DECLARE" ? 1 : lookup === "NORMAL" ? 2 : lookup === "EXPR" ? 3 : 0;
  }
  return { nonlocalReductions, lookupModeReductions };
}

function validateProjection(value) {
  const expected = ["relation", "column", "routine", "type", "procedure"];
  if (!value || typeof value !== "object" || !value.sqlSlots) {
    throw new Error(`${PROJECTION} does not define sqlSlots`);
  }
  if (Object.keys(value.sqlSlots).sort().join(",") !== expected.sort().join(",")) {
    throw new Error(`${PROJECTION} must define exactly ${expected.join(", ")}`);
  }
  for (const slot of expected) {
    const rule = value.sqlSlots[slot];
    if (!rule || (!Array.isArray(rule.nonterminalGotos) && !Array.isArray(rule.kernelItems))) {
      throw new Error(`${PROJECTION} has no grammar evidence for ${slot}`);
    }
  }
}

function render({ bisonVersion, sql, plpgsql, authority }) {
  return `// Generated by scripts/sql/generate-postgres-predictor.mjs. Do not edit.
// biome-ignore-all format: generated parser tables are intentionally compact

export interface GeneratedPostgresParserTables {
  readonly finalState: number;
  readonly lastIndex: number;
  readonly terminalCount: number;
  readonly pactNinf: number;
  readonly tableNinf: number;
  readonly terminalByName: Readonly<Record<string, number>>;
  readonly directTerminals: readonly (readonly number[])[];
  readonly yyr1: readonly number[];
  readonly yyr2: readonly number[];
  readonly yydefact: readonly number[];
  readonly yydefgoto: readonly number[];
  readonly yypact: readonly number[];
  readonly yypgoto: readonly number[];
  readonly yytable: readonly number[];
  readonly yycheck: readonly number[];
  readonly slotMasks: readonly number[];
  readonly nonlocalReductions: readonly number[];
  readonly lookupModeReductions: readonly number[];
}

export const POSTGRES_PREDICTOR_AUTHORITY = ${JSON.stringify(
    {
      postgresRef: authority.postgresRef,
      postgresVersion: authority.postgresVersion,
      generatorName: "gnu-bison",
      generatorVersion: bisonVersion,
      sqlGrammarDigest: authority.sqlGrammarDigest,
      plpgsqlGrammarDigest: authority.plpgsqlGrammarDigest,
      sqlKeywordDigest: authority.sqlKeywordDigest,
      plpgsqlKeywordDigest: authority.plpgsqlKeywordDigest,
      scannerDigest: authority.scannerDigest,
      predictorDigest: authority.predictorDigest,
      projectionDigest: authority.projectionDigest,
    },
    null,
    2,
  )} as const;

export const SQL_PREDICTOR_TABLES: GeneratedPostgresParserTables = ${table(sql)};

export const PLPGSQL_PREDICTOR_TABLES: GeneratedPostgresParserTables = ${table(plpgsql)};
`;
}

function table(value) {
  return `{
  finalState: ${value.finalState},
  lastIndex: ${value.lastIndex},
  terminalCount: ${value.terminalCount},
  pactNinf: ${value.pactNinf},
  tableNinf: ${value.tableNinf},
  terminalByName: ${JSON.stringify(value.terminalByName)},
  directTerminals: ${JSON.stringify(value.directTerminals)},
  yyr1: ${numbers(value.yyr1)},
  yyr2: ${numbers(value.yyr2)},
  yydefact: ${numbers(value.yydefact)},
  yydefgoto: ${numbers(value.yydefgoto)},
  yypact: ${numbers(value.yypact)},
  yypgoto: ${numbers(value.yypgoto)},
  yytable: ${numbers(value.yytable)},
  yycheck: ${numbers(value.yycheck)},
  slotMasks: ${numbers(value.slotMasks)},
  nonlocalReductions: ${numbers(value.nonlocalReductions)},
  lookupModeReductions: ${numbers(value.lookupModeReductions)},
}`;
}

function numbers(values) {
  const lines = [];
  for (let index = 0; index < values.length; index += 32) {
    lines.push(`    ${values.slice(index, index + 32).join(",")}`);
  }
  return `[\n${lines.join(",\n")}\n  ]`;
}

function verified(path, expected) {
  const source = readFileSync(path);
  const actual = sha256(source);
  if (actual !== expected) {
    throw new Error(`${basename(path)} SHA-256 mismatch: expected ${expected}, got ${actual}`);
  }
  return source;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
