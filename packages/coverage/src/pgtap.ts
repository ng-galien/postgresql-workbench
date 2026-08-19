import type { Client, QueryResult, QueryResultRow } from "pg";
import type { SyntaxParser } from "../../sql/src/analysis/syntaxTree.js";
import { extractFuncDeps } from "../../sql/src/deps.js";
import { quoteSqlIdentifier } from "../../sql/src/text/identifiers.js";
import type { CoverageTestReport } from "./runner.js";

export const DEFAULT_PGTAP_TEST_PATTERNS = ["*_ut.test_*", "*_it.test_*"] as const;

export interface PgTapSourceRoutine {
  oid: number;
  schema: string;
  name: string;
  identityArguments: string;
}

export interface PgTapTestRoutine {
  oid: number;
  schema: string;
  name: string;
  identityArguments: string;
  language: string;
  runnable: boolean;
  sourceRoutines: PgTapSourceRoutine[];
}

export interface PgTapDiscovery {
  available: boolean;
  tests: PgTapTestRoutine[];
}

export interface PgTapRoutineDependencyRequest {
  oid: number;
  schema: string;
  name: string;
  language: string;
  ddl: string;
}

export type PgTapRoutineDependencyResolver = (
  routine: PgTapRoutineDependencyRequest,
) => Promise<ReadonlySet<string> | undefined>;

export type PgTapAssertionStatus = "passed" | "failed" | "skipped" | "todo";

export interface PgTapAssertion {
  number?: number;
  name: string;
  status: PgTapAssertionStatus;
  message?: string;
}

export interface PgTapReport {
  plan?: { first: number; last: number };
  assertions: PgTapAssertion[];
  valid: boolean;
  errors: string[];
  bailOut?: string;
  passed: number;
  failed: number;
  skipped: number;
  todo: number;
  total: number;
  output: string[];
  truncated: boolean;
}

export interface PgTapQueryClient {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

interface PgTapCatalogRoutine {
  oid: string;
  schema: string;
  name: string;
  identity_arguments: string;
  language: string;
  argument_count: number;
}

interface PgTapCatalogRow extends PgTapCatalogRoutine {
  ddl: string;
}

interface PgTapSourceCatalogRoutine extends PgTapSourceRoutine {
  ddl: string;
}

interface PgTapDependencyCatalog {
  sourcesByName: Map<string, PgTapSourceCatalogRoutine[]>;
  dependenciesByOid: Map<number, Set<string>>;
}

export async function discoverPgTapTests(
  client: Client,
  parser: SyntaxParser,
  indexedDependencies?: PgTapRoutineDependencyResolver,
  patterns: readonly string[] = DEFAULT_PGTAP_TEST_PATTERNS,
): Promise<PgTapDiscovery> {
  if (!(await hasPgTap(client))) return { available: false, tests: [] };
  const testCandidates = (await queryPgTapRoutineCandidates(client)).filter((row) =>
    matchesPgTapTestPatterns(`${row.schema}.${row.name}`, patterns),
  );
  if (testCandidates.length === 0) return { available: true, tests: [] };

  const testRows = await queryPgTapDefinitions(
    client,
    testCandidates.map(({ oid }) => Number(oid)),
  );
  const testOids = new Set(testRows.map(({ oid }) => Number(oid)));
  const testSchemas = new Set(testRows.map(({ schema }) => schema));
  const testDependencies = new Map<number, Set<string>>();
  await Promise.all(
    testRows.map(async (row) => {
      testDependencies.set(
        Number(row.oid),
        await resolveRoutineDependencies(
          {
            oid: Number(row.oid),
            schema: row.schema,
            name: row.name,
            language: row.language,
            ddl: row.ddl,
          },
          parser,
          indexedDependencies,
        ),
      );
    }),
  );
  const dependencyCatalog = await queryDependencyCatalog(
    client,
    new Set([...testDependencies.values()].flatMap((dependencies) => [...dependencies])),
    testOids,
    parser,
    indexedDependencies,
  );
  const tests = testRows.map(
    (row): PgTapTestRoutine => ({
      oid: Number(row.oid),
      schema: row.schema,
      name: row.name,
      identityArguments: row.identity_arguments,
      language: row.language,
      runnable: row.argument_count === 0,
      sourceRoutines: resolveSourceRoutines(
        testDependencies.get(Number(row.oid)) ?? new Set(),
        dependencyCatalog.sourcesByName,
        dependencyCatalog.dependenciesByOid,
        testSchemas,
      ),
    }),
  );
  return {
    available: true,
    tests: tests.sort(compareTests),
  };
}

async function resolveRoutineDependencies(
  routine: PgTapRoutineDependencyRequest,
  parser: SyntaxParser,
  indexedDependencies: PgTapRoutineDependencyResolver | undefined,
): Promise<Set<string>> {
  const indexed = await indexedDependencies?.(routine);
  if (indexed !== undefined) return new Set(indexed);
  return extractFuncDeps(
    {
      schema: routine.schema,
      name: routine.name,
      lang: routine.language,
      ddl: routine.ddl,
    },
    parser,
  );
}

export function matchesPgTapTestPatterns(
  qualifiedName: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((pattern) => globMatches(qualifiedName, pattern.trim()));
}

export async function executePgTapTest(
  client: PgTapQueryClient,
  test: PgTapTestRoutine,
  maxOutputLines = 5_000,
  maxOutputBytes = 1_048_576,
): Promise<PgTapReport> {
  if (!test.runnable) {
    throw new Error(
      `pgTAP test ${test.schema}.${test.name} requires arguments and cannot be run automatically.`,
    );
  }
  const boundedLines = Math.max(1, Math.floor(maxOutputLines));
  const boundedBytes = Math.max(4, Math.floor(maxOutputBytes));
  const rowLimit = Math.min(boundedLines, Math.max(1, Math.floor(boundedBytes / 4)));
  const maxCharactersPerLine = Math.max(1, Math.floor(boundedBytes / rowLimit / 4));
  const result = await client.query<{
    tap_line: string;
    line_truncated: boolean;
    row_overflow: boolean;
  }>(
    `SELECT CASE
              WHEN output.ordinality <= $1::int
              THEN pg_catalog.left(output.tap_line, $2::int)
              ELSE ''
            END AS tap_line,
            CASE
              WHEN output.ordinality <= $1::int
              THEN pg_catalog.char_length(output.tap_line) > $2::int
              ELSE false
            END AS line_truncated,
            output.ordinality > $1::int AS row_overflow
       FROM ${quoteSqlIdentifier(test.schema)}.${quoteSqlIdentifier(test.name)}()
            WITH ORDINALITY AS output(tap_line, ordinality)
      LIMIT ($1::int + 1)`,
    [rowLimit, maxCharactersPerLine],
  );
  const truncated =
    result.rows.some(({ row_overflow }) => row_overflow) ||
    result.rows.slice(0, rowLimit).some(({ line_truncated }) => line_truncated);
  const report = parsePgTapOutput(result.rows.slice(0, rowLimit).map(({ tap_line }) => tap_line));
  if (truncated) {
    report.truncated = true;
    report.valid = false;
    report.errors.push(
      `pgTAP output exceeded the configured limit of ${boundedLines} lines and ${boundedBytes} bytes.`,
    );
  }
  return report;
}

export async function resetPgTapState(client: PgTapQueryClient): Promise<void> {
  const extension = await client.query<{ schema: string }>(`
    SELECT n.nspname AS schema
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = 'pgtap'
  `);
  const schema = extension.rows[0]?.schema;
  if (!schema) throw new Error("pgTAP is not installed in the selected database.");
  await client.query(`SELECT ${quoteSqlIdentifier(schema)}._cleanup()`);
}

export function parsePgTapOutput(lines: readonly string[]): PgTapReport {
  const assertions: PgTapAssertion[] = [];
  const errors: string[] = [];
  let plan: PgTapReport["plan"];
  let bailOut: string | undefined;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const firstLine = line.split("\n", 1)[0];
    const bailOutMatch = /^\s*Bail out!\s*(.*)$/i.exec(firstLine);
    if (bailOutMatch) {
      bailOut = bailOutMatch[1]?.trim() || "pgTAP bailed out";
      errors.push(`Bail out! ${bailOut}`);
      continue;
    }
    const planMatch = /^\s*(\d+)\.\.(\d+)(?:\s+#\s*(.*))?\s*$/.exec(firstLine);
    if (planMatch) {
      if (plan) errors.push("pgTAP output contains more than one plan.");
      else plan = { first: Number(planMatch[1]), last: Number(planMatch[2]) };
      continue;
    }
    const assertion = parseAssertion(line);
    if (assertion) {
      assertions.push(assertion);
      continue;
    }
    if (!isTapDiagnostic(firstLine)) {
      errors.push(`Unrecognized TAP output: ${firstLine || "<empty line>"}`);
    }
  }
  if (!plan && !bailOut) {
    errors.push("pgTAP output does not contain a test plan.");
  } else if (plan) {
    validatePlan(plan, assertions, errors);
  }
  return {
    plan,
    assertions,
    valid: errors.length === 0,
    errors,
    bailOut,
    passed: assertions.filter(({ status }) => status === "passed").length,
    failed: assertions.filter(({ status }) => status === "failed").length,
    skipped: assertions.filter(({ status }) => status === "skipped").length,
    todo: assertions.filter(({ status }) => status === "todo").length,
    total: assertions.length,
    output: [...lines],
    truncated: false,
  };
}

export function toCoverageTestReport(report: PgTapReport): CoverageTestReport {
  const invalidTests = report.errors.map((message, index) => ({
    name: `Invalid TAP output ${index + 1}`,
    passed: false,
    message,
  }));
  return {
    passed: report.passed + report.skipped + report.todo,
    failed: report.failed + invalidTests.length,
    total: report.total + invalidTests.length,
    tests: [
      ...report.assertions.map((assertion) => ({
        name: assertion.name,
        passed: assertion.status !== "failed",
        message: assertion.message,
      })),
      ...invalidTests,
    ],
  };
}

async function hasPgTap(client: Client): Promise<boolean> {
  const result = await client.query<{ installed: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'pgtap') AS installed",
  );
  return result.rows[0]?.installed ?? false;
}

async function queryPgTapRoutineCandidates(client: Client): Promise<PgTapCatalogRoutine[]> {
  const result = await client.query<PgTapCatalogRoutine>(`
    SELECT p.oid::bigint::text AS oid,
           n.nspname AS schema,
           p.proname AS name,
           pg_get_function_identity_arguments(p.oid) AS identity_arguments,
           l.lanname AS language,
           p.pronargs::int AS argument_count
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
     WHERE p.proretset
       AND p.prorettype = 'pg_catalog.text'::regtype
       AND l.lanname IN ('plpgsql', 'sql')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND NOT EXISTS (
         SELECT 1
           FROM pg_depend d
          WHERE d.classid = 'pg_proc'::regclass
            AND d.objid = p.oid
            AND d.deptype = 'e'
       )
     ORDER BY n.nspname, p.proname, p.oid
  `);
  return result.rows;
}

async function queryPgTapDefinitions(
  client: Client,
  oids: readonly number[],
): Promise<PgTapCatalogRow[]> {
  const result = await client.query<PgTapCatalogRow>(
    `
      SELECT p.oid::bigint::text AS oid,
             n.nspname AS schema,
             p.proname AS name,
             pg_get_function_identity_arguments(p.oid) AS identity_arguments,
             l.lanname AS language,
             p.pronargs::int AS argument_count,
             pg_get_functiondef(p.oid) AS ddl
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_language l ON l.oid = p.prolang
       WHERE p.oid = ANY($1::oid[])
       ORDER BY n.nspname, p.proname, p.oid
    `,
    [oids],
  );
  return result.rows;
}

async function queryDependencyCatalog(
  client: Client,
  initialDependencies: ReadonlySet<string>,
  testOids: ReadonlySet<number>,
  parser: SyntaxParser,
  indexedDependencies: PgTapRoutineDependencyResolver | undefined,
): Promise<PgTapDependencyCatalog> {
  const sourcesByName = new Map<string, PgTapSourceCatalogRoutine[]>();
  const dependenciesByOid = new Map<number, Set<string>>();
  const pending = new Set(initialDependencies);
  const visitedNames = new Set<string>();
  while (pending.size > 0) {
    const names = [...pending].filter((name) => !visitedNames.has(name));
    pending.clear();
    if (names.length === 0) break;
    for (const name of names) visitedNames.add(name);
    const routines = await querySourceRoutines(client, names, testOids);
    await Promise.all(
      routines.map(async (routine) => {
        const key = `${routine.schema}.${routine.name}`;
        const entries = sourcesByName.get(key) ?? [];
        entries.push(routine);
        sourcesByName.set(key, entries);
        const dependencies = await resolveRoutineDependencies(
          {
            oid: routine.oid,
            schema: routine.schema,
            name: routine.name,
            language: "plpgsql",
            ddl: routine.ddl,
          },
          parser,
          indexedDependencies,
        );
        dependenciesByOid.set(routine.oid, dependencies);
        for (const dependency of dependencies) {
          if (!visitedNames.has(dependency)) pending.add(dependency);
        }
      }),
    );
  }
  return { sourcesByName, dependenciesByOid };
}

async function querySourceRoutines(
  client: Client,
  qualifiedNames: readonly string[],
  testOids: ReadonlySet<number>,
): Promise<PgTapSourceCatalogRoutine[]> {
  const result = await client.query<{
    oid: string;
    schema: string;
    name: string;
    identity_arguments: string;
    ddl: string;
  }>(
    `
      SELECT p.oid::bigint::text AS oid,
             n.nspname AS schema,
             p.proname AS name,
             pg_get_function_identity_arguments(p.oid) AS identity_arguments,
             pg_get_functiondef(p.oid) AS ddl
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_language l ON l.oid = p.prolang
       WHERE l.lanname = 'plpgsql'
         AND (n.nspname || '.' || p.proname) = ANY($1::text[])
         AND NOT (p.oid = ANY($2::oid[]))
         AND n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND NOT EXISTS (
           SELECT 1
             FROM pg_depend d
            WHERE d.classid = 'pg_proc'::regclass
              AND d.objid = p.oid
              AND d.deptype = 'e'
         )
       ORDER BY n.nspname, p.proname, p.oid
    `,
    [qualifiedNames, [...testOids]],
  );
  return result.rows.map((row) => ({
    oid: Number(row.oid),
    schema: row.schema,
    name: row.name,
    identityArguments: row.identity_arguments,
    ddl: row.ddl,
  }));
}

function resolveSourceRoutines(
  dependencies: ReadonlySet<string>,
  sourcesByName: ReadonlyMap<string, PgTapSourceCatalogRoutine[]>,
  dependenciesByOid: ReadonlyMap<number, ReadonlySet<string>>,
  testSchemas: ReadonlySet<string>,
): PgTapSourceRoutine[] {
  const resolved = new Map<number, PgTapSourceCatalogRoutine>();
  const pending = [...dependencies];
  const visitedNames = new Set<string>();
  const visitedOids = new Set<number>();
  while (pending.length > 0) {
    const dependency = pending.shift();
    if (!dependency || visitedNames.has(dependency)) continue;
    visitedNames.add(dependency);
    for (const routine of sourcesByName.get(dependency) ?? []) {
      if (visitedOids.has(routine.oid)) continue;
      visitedOids.add(routine.oid);
      if (!testSchemas.has(routine.schema)) resolved.set(routine.oid, routine);
      pending.push(...(dependenciesByOid.get(routine.oid) ?? []));
    }
  }
  return [...resolved.values()]
    .map(({ ddl: _ddl, ...routine }) => routine)
    .sort(compareSourceRoutines);
}

function parseAssertion(line: string): PgTapAssertion | undefined {
  const match = /^\s*(not\s+)?ok(?:\s+(\d+))?(?:\s*-\s*([^#\n]*?))?(?:\s+#\s*(.*))?$/i.exec(
    line.split("\n", 1)[0],
  );
  if (!match) return undefined;
  const directive = match[4]?.trim();
  const directiveKind = /^(skip|todo)\b/i.exec(directive ?? "")?.[1]?.toLowerCase();
  const status: PgTapAssertionStatus =
    directiveKind === "skip"
      ? "skipped"
      : directiveKind === "todo"
        ? "todo"
        : match[1]
          ? "failed"
          : "passed";
  return {
    number: match[2] ? Number(match[2]) : undefined,
    name: match[3]?.trim() || `Assertion ${match[2] ?? "?"}`,
    status,
    message: status === "failed" ? line : undefined,
  };
}

function isTapDiagnostic(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed === "" ||
    trimmed === "---" ||
    trimmed === "..." ||
    trimmed.startsWith("#") ||
    /^TAP version \d+$/i.test(trimmed)
  );
}

function validatePlan(
  plan: NonNullable<PgTapReport["plan"]>,
  assertions: readonly PgTapAssertion[],
  errors: string[],
): void {
  const expected = plan.first === 1 && plan.last === 0 ? 0 : plan.last - plan.first + 1;
  if (expected < 0) {
    errors.push(`Invalid pgTAP plan ${plan.first}..${plan.last}.`);
    return;
  }
  if (assertions.length !== expected) {
    errors.push(`pgTAP plan expected ${expected} assertion(s), but received ${assertions.length}.`);
  }
  let expectedNumber = plan.first;
  for (const assertion of assertions) {
    const actualNumber = assertion.number ?? expectedNumber;
    if (actualNumber !== expectedNumber) {
      errors.push(
        `pgTAP assertion number ${actualNumber} does not match expected ${expectedNumber}.`,
      );
    }
    expectedNumber++;
  }
}

function globMatches(value: string, pattern: string): boolean {
  if (pattern.length === 0) return false;
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`, "i").test(value);
}

function compareSourceRoutines(left: PgTapSourceRoutine, right: PgTapSourceRoutine): number {
  return (
    left.schema.localeCompare(right.schema) ||
    left.name.localeCompare(right.name) ||
    left.identityArguments.localeCompare(right.identityArguments)
  );
}

function compareTests(left: PgTapTestRoutine, right: PgTapTestRoutine): number {
  return (
    left.schema.localeCompare(right.schema) ||
    left.name.localeCompare(right.name) ||
    left.identityArguments.localeCompare(right.identityArguments)
  );
}
