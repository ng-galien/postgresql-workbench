# PostgreSQL Coverage

Standalone PL/pgSQL statement and branch coverage, as a Node.js library and command-line tool.
No VS Code, Workbench, DAP, workspace index, or running MCP server is required.
The package starts its own lazy Code Moniker parsing worker from its npm dependency.

A `coverage-v<version>` tag launches the package validation and npm publication workflow
described in the repository release guide. For a local checkout, run
`npm run test:coverage:package` to pack and install it in an isolated project.

## Cover a schema

Requires Node.js 24+, a PostgreSQL test database with pgTAP installed, and a database role
allowed to replace the selected routine definitions. Configure the connection with the usual
node-postgres environment variables (`PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`,
and `PGSSLMODE`). Keep credentials outside source control.

```bash
npx @ng-galien/postgresql-coverage --schema app --test-schema app_ut --output coverage.lcov
```

Omit `--test-schema` when tests live alongside application routines. Repeat `--schema` or
`--test-schema` to select several complete schemas. Schema names are literal, not patterns.
Alternatively select by glob, without any implicit schema or naming filter:

```bash
npx @ng-galien/postgresql-coverage --pattern 'app.invoice*' --test-pattern 'checks.invoice*' --format json --output coverage.json
```

Patterns match the complete `schema.function` name: `*` matches any number of characters and `?`
matches one character. Everything else is literal; matching is case-sensitive. Quote patterns to
prevent shell expansion. Overloads with the same name are all selected. Repeat patterns to form
a union. Schema mode and pattern mode are alternatives, not an implicit intersection.
Test selection defaults to the source selection; specify `--test-schema` or `--test-pattern`
independently when the tests are elsewhere.

- Test candidates are zero-argument functions returning `SETOF text`, with **no naming convention**.
  PostgreSQL does not mark pgTAP tests in its catalog: their output is validated as TAP during
  execution. A selected candidate producing other text fails the suite. SQL and PL/pgSQL tests
  are supported; use a test pattern to disambiguate unrelated functions with the same signature.
- All application PL/pgSQL functions and procedures in `--schema` enter the coverage denominator,
  including routines not called by any test. Overloads remain separate. Test functions and
  extension-owned routines are excluded; ordinary helper routines are included.
- SQL-language application functions are outside PL/pgSQL coverage. An unsupported PL/pgSQL
  routine fails the run instead of silently reducing the denominator.
- Missing schemas, missing pgTAP, no test candidates, or no application PL/pgSQL routines are errors.
- Each selected test runs once in an isolated savepoint. Assertion failures and test execution
  errors are reported while remaining tests continue. Cancellation stops the suite.
- Instrumentation and transactional test changes are rolled back. Use a test database:
  sequence increments and external effects are not undone by PostgreSQL rollback.

The default LCOV output has one record per routine. Use `--format json` for the scope summary,
test results, and detailed per-routine coverage. Every selected routine outside instrumentation
(test candidate, extension-owned routine, non-PL/pgSQL routine) is listed with its reason in JSON
and on stderr; these exclusions are never silently counted as covered. Report locations are database routine URIs;
line numbers refer to `pg_get_functiondef`, not automatically to migration files on disk.
`--output` writes a file; otherwise the report goes to stdout. Progress/results go to stderr.

Exit codes: **0** tests passed, **1** tests failed, **2** invalid arguments or execution failure.
Uncovered code lowers coverage but does not change the exit code; no coverage threshold is applied.
`--timeout` controls discovery and the instrumentation/test run (default 300000 milliseconds).

## Node.js / TypeScript

```ts
import { Client } from 'pg';
import { StandaloneCoverage } from '@ng-galien/postgresql-coverage';

const coverage = new StandaloneCoverage(async () => {
  const client = new Client(); // standard PG* environment variables
  await client.connect();
  return client;
});

try {
  const report = await coverage.runSchema({ schema: 'app', testSchemas: ['app_ut'] });
  console.log(report.summary); // routines, statements and branches: covered / total
  console.log(report.tests);
} finally {
  await coverage.dispose();
}
```

For pattern selection, use `coverage.runSelected({ scope: { patterns: ['app.invoice*'] },
tests: { patterns: ['checks.invoice*'] } })`. Both selectors also accept `{ schemas: ['app'] }`.

The factory must return a **new, connected, dedicated `pg.Client` on every call**.
Configure a connection timeout in your factory. A caller-owned connecting promise cannot
be interrupted; cancellation stops awaiting it and closes any client it later delivers.
The engine closes these connections. Do not return a shared client or a pool lease.
`dispose()` is idempotent: it cancels active runs, waits for their database cleanup, then stops
the parsing worker. Await the run promises as well to observe cancellation or cleanup failures.

For explicit selections, `run()` and `runSuite()` accept routine OIDs and an `executeTests`
callback. Hosts supplying their own parser can continue using `CoverageRunner` and
`createCoverageSyntaxService`. The package exports TypeScript declarations and supports both
ES module imports and CommonJS `require`.

## Maintainer validation

```bash
npm run build:coverage:package
npm run test:coverage:package
# With a pgTAP-enabled test database configured via PG*:
npm run test:coverage:package -- --e2e
```

The package has its own `0.1.0` version; it does not follow the extension version.
