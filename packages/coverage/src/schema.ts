import type { Client } from "pg";
import {
  executePgTapTest,
  type PgTapTestRoutine,
  resetPgTapState,
  toCoverageTestReport,
} from "./pgtap.js";
import type {
  CoverageRunRequest,
  CoverageSuiteRunResult,
  CoverageTestClient,
  CoverageTestReport,
} from "./runner.js";

export type CoverageScope =
  | { schemas: readonly string[]; patterns?: never }
  | { patterns: readonly string[]; schemas?: never };

export interface SelectedCoverageRequest {
  scope: CoverageScope;
  tests?: CoverageScope;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ExcludedCoverageRoutine {
  schema: string;
  name: string;
  identityArguments: string;
  reason: "test-candidate" | "extension-owned" | "not-plpgsql";
}

export interface SchemaCoverageResult extends CoverageSuiteRunResult {
  scope: CoverageScope;
  testScope: CoverageScope;
  excluded: ExcludedCoverageRoutine[];
  summary: {
    routines: { covered: number; total: number };
    statements: { covered: number; total: number };
    branches: { covered: number; total: number };
  };
}

export interface SchemaCoverageSelection {
  routineOids: number[];
  tests: PgTapTestRoutine[];
  testScope: CoverageScope;
  excluded: ExcludedCoverageRoutine[];
}

interface CatalogRoutine extends PgTapTestRoutine {
  testCandidate: boolean;
  extensionOwned: boolean;
}

/** Glob patterns match the whole qualified schema.name, with * and ? as wildcards. */
export function matchesCoverageScope(scope: CoverageScope, schema: string, name: string): boolean {
  if (scope.schemas) return scope.schemas.includes(schema);
  const qualified = `${schema}.${name}`;
  return scope.patterns.some((pattern) => {
    const source = [...pattern]
      .map((char) =>
        char === "*" ? ".*" : char === "?" ? "." : char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"),
      )
      .join("");
    return new RegExp(`^${source}$`, "s").test(qualified);
  });
}

async function validateScope(client: Client, scope: CoverageScope): Promise<void> {
  if (!!scope.schemas === !!scope.patterns)
    throw new Error("Select schemas OR patterns, not both.");
  const values = scope.schemas ?? scope.patterns;
  if (!values?.length || values.some((value) => !value))
    throw new Error("Coverage selectors must not be empty.");
  if (scope.schemas) {
    const found = await client.query<{ name: string }>(
      "SELECT nspname AS name FROM pg_namespace WHERE nspname = ANY($1::text[])",
      [scope.schemas],
    );
    const missing = scope.schemas.filter(
      (schema) => !found.rows.some(({ name }) => name === schema),
    );
    if (missing.length) throw new Error(`Schemas not found: ${missing.join(", ")}`);
  }
}

/** Selection never follows test dependencies: uncalled routines remain in the denominator. */
export async function selectSchemaCoverage(
  client: Client,
  request: SelectedCoverageRequest,
): Promise<SchemaCoverageSelection> {
  request.signal?.throwIfAborted();
  const testScope = request.tests ?? request.scope;
  await validateScope(client, request.scope);
  await validateScope(client, testScope);
  const extension = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'pgtap'");
  if (!extension.rowCount) throw new Error("pgTAP is not installed in the selected database.");
  const catalog = await client.query<CatalogRoutine>(
    `SELECT p.oid::int AS oid, n.nspname AS schema, p.proname AS name, l.lanname AS language,
       pg_get_function_identity_arguments(p.oid) AS "identityArguments", (p.pronargs = 0) AS runnable,
       (p.prokind = 'f' AND p.pronargs = 0 AND p.proretset AND p.prorettype = 'text'::regtype) AS "testCandidate",
       EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e') AS "extensionOwned"
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
     WHERE p.prokind IN ('f', 'p')
     ORDER BY n.nspname, p.proname, p.oid`,
  );
  request.signal?.throwIfAborted();
  const tests = catalog.rows
    .filter(
      (row) =>
        row.testCandidate &&
        !row.extensionOwned &&
        matchesCoverageScope(testScope, row.schema, row.name),
    )
    .map((row) => ({ ...row, sourceRoutines: [] }));
  if (!tests.length)
    throw new Error(
      "No pgTAP candidates found: expected zero-argument functions returning SETOF text in the selected scope.",
    );
  const selected = catalog.rows.filter((row) =>
    matchesCoverageScope(request.scope, row.schema, row.name),
  );
  const excluded: ExcludedCoverageRoutine[] = [];
  const routineOids: number[] = [];
  for (const row of selected) {
    const reason = row.extensionOwned
      ? "extension-owned"
      : tests.some((test) => test.oid === row.oid)
        ? "test-candidate"
        : row.language !== "plpgsql"
          ? "not-plpgsql"
          : undefined;
    if (reason)
      excluded.push({
        schema: row.schema,
        name: row.name,
        identityArguments: row.identityArguments,
        reason,
      });
    else routineOids.push(row.oid);
  }
  if (!routineOids.length)
    throw new Error("No application PL/pgSQL routines found in the selected scope.");
  return { routineOids, tests, testScope, excluded };
}

export function schemaTestExecutor(
  tests: readonly PgTapTestRoutine[],
): CoverageRunRequest["executeTests"] {
  return async (client: CoverageTestClient, signal: AbortSignal): Promise<CoverageTestReport> => {
    const combined: CoverageTestReport = { passed: 0, failed: 0, total: 0, tests: [] };
    for (const test of tests) {
      signal.throwIfAborted();
      let report: CoverageTestReport;
      try {
        report = await client.runIsolated(async () => {
          const report = toCoverageTestReport(await executePgTapTest(client, test));
          await resetPgTapState(client);
          return report;
        });
      } catch (error) {
        signal.throwIfAborted();
        report = {
          passed: 0,
          failed: 1,
          total: 1,
          tests: [
            {
              name: `${test.schema}.${test.name}`,
              passed: false,
              message: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
      combined.passed += report.passed;
      combined.failed += report.failed;
      combined.total += report.total;
      combined.tests.push(
        ...report.tests.map((assertion) => ({
          ...assertion,
          name: `${test.schema}.${test.name}: ${assertion.name}`,
        })),
      );
    }
    return combined;
  };
}

export function summarizeSchemaCoverage(
  result: CoverageSuiteRunResult,
): SchemaCoverageResult["summary"] {
  return {
    routines: {
      total: result.routines.length,
      covered: result.routines.filter(({ coverage }) =>
        coverage.points.some(({ executed }) => executed > 0),
      ).length,
    },
    statements: result.routines.reduce(
      (sum, { coverage }) => ({
        covered: sum.covered + coverage.statement.covered,
        total: sum.total + coverage.statement.total,
      }),
      { covered: 0, total: 0 },
    ),
    branches: result.routines.reduce(
      (sum, { coverage }) => ({
        covered: sum.covered + coverage.branch.covered,
        total: sum.total + coverage.branch.total,
      }),
      { covered: 0, total: 0 },
    ),
  };
}
