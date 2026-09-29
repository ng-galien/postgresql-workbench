import { writeFile } from "node:fs/promises";
import { Client } from "pg";
import {
  type CoverageScope,
  coverageAsLcov,
  mapCoverageToSource,
  StandaloneCoverage,
} from "./standalone.js";

const HELP = `Usage: postgresql-coverage (--schema SCHEMA | --pattern PATTERN) [options]

Cover every application PL/pgSQL function/procedure in a schema, including uncalled routines.
Discover zero-argument functions returning SETOF text; validate TAP output at execution.
No naming convention is required. Patterns match the full schema.function name (* and ?).

  --schema NAME        Whole schema to cover; repeat for multiple schemas
  --pattern GLOB       Alternatively, cover matching routines; repeat to combine patterns
  --test-schema NAME   Schema containing pgTAP tests; repeat for multiple schemas
                       (default: the coverage selection)
  --test-pattern GLOB  Alternatively, discover tests by pattern; repeat to combine patterns
  --format lcov|json   Report format (default: lcov)
  --output PATH        Write report to PATH (default: stdout)
  --timeout MS         Execution timeout in milliseconds (default: 300000)
  --help               Show this help

Connection: PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD and PGSSLMODE,
as supported by node-postgres. Use a test database: instrumentation is rolled back.
Exit codes: 0 tests passed, 1 tests failed, 2 usage or execution error.
`;

interface Options {
  schemas: string[];
  patterns: string[];
  testSchemas: string[];
  testPatterns: string[];
  format: "lcov" | "json";
  output?: string;
  timeout: number;
}

function parseOptions(args: string[]): Options {
  const options: Options = {
    schemas: [],
    patterns: [],
    testSchemas: [],
    testPatterns: [],
    format: "lcov",
    timeout: 300_000,
  };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    switch (flag) {
      case "--schema":
        options.schemas.push(value);
        break;
      case "--pattern":
        options.patterns.push(value);
        break;
      case "--test-pattern":
        options.testPatterns.push(value);
        break;
      case "--test-schema":
        options.testSchemas.push(value);
        break;
      case "--output":
        options.output = value;
        break;
      case "--format":
        if (value !== "lcov" && value !== "json") throw new Error("Format must be lcov or json.");
        options.format = value;
        break;
      case "--timeout":
        options.timeout = Number(value);
        if (
          !Number.isSafeInteger(options.timeout) ||
          options.timeout < 1 ||
          options.timeout > 2_147_483_647
        ) {
          throw new Error("Timeout must be an integer between 1 and 2147483647 milliseconds.");
        }
        break;
      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }
  if (!!options.schemas.length === !!options.patterns.length)
    throw new Error("Select --schema OR --pattern.");
  if (options.testSchemas.length && options.testPatterns.length)
    throw new Error("Select --test-schema OR --test-pattern.");
  return options;
}

async function openClient(): Promise<Client> {
  const client = new Client({ connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.end();
    throw error;
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  const options = parseOptions(args);
  const coverage = new StandaloneCoverage(openClient);
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const scope: CoverageScope = options.schemas.length
      ? { schemas: options.schemas }
      : { patterns: options.patterns };
    const tests: CoverageScope | undefined = options.testSchemas.length
      ? { schemas: options.testSchemas }
      : options.testPatterns.length
        ? { patterns: options.testPatterns }
        : undefined;
    const result = await coverage.runSelected({
      scope,
      tests,
      timeoutMs: options.timeout,
      signal: abort.signal,
    });
    const files = result.routines.map(({ routine, bodyStartLine, coverage }) => ({
      uri: `postgresql://${encodeURIComponent(routine.schema)}/${encodeURIComponent(routine.name)}(${encodeURIComponent(routine.identityArguments)})`,
      statements: mapCoverageToSource(bodyStartLine, coverage).statements,
    }));
    const report =
      options.format === "json"
        ? `${JSON.stringify({ version: 1, scope: result.scope, testScope: result.testScope, excluded: result.excluded, summary: result.summary, tests: result.tests, files }, null, 2)}\n`
        : coverageAsLcov(files);
    if (options.output) await writeFile(options.output, report, "utf8");
    else process.stdout.write(report);
    const { routines, statements, branches } = result.summary;
    process.stderr.write(
      `${result.tests.passed}/${result.tests.total} pgTAP assertions passed.\nCoverage: routines ${routines.covered}/${routines.total}, statements ${statements.covered}/${statements.total}, branches ${branches.covered}/${branches.total}.\n`,
    );
    for (const routine of result.excluded)
      process.stderr.write(
        `Excluded ${routine.schema}.${routine.name}(${routine.identityArguments}): ${routine.reason}\n`,
      );
    for (const test of result.tests.tests.filter((test) => !test.passed)) {
      process.stderr.write(`FAIL ${test.name}${test.message ? `: ${test.message}` : ""}\n`);
    }
    return result.tests.failed > 0 ? 1 : 0;
  } finally {
    await coverage.dispose();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `postgresql-coverage: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  },
);
