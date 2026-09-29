---
title: pgTAP and coverage
description: Run pgTAP tests and inspect PL/pgSQL statement and branch coverage in VS Code.
eyebrow: pgTAP and coverage
media: coverage.gif
mediaAlt: pgTAP tests with PL/pgSQL coverage in VS Code
---

# pgTAP tests and coverage

PostgreSQL Workbench runs pgTAP tests in VS Code's native Testing UI and reports
PL/pgSQL statement and branch coverage in the editor. Coverage is collected
independently from the debugger in a dedicated transaction.

{{media}}

## Standalone library and CLI

The same engine is distributed as `@ng-galien/postgresql-coverage`, independently
versioned from the extension. It does not require VS Code or the Workbench server.
Use its CLI with:

```bash
npx @ng-galien/postgresql-coverage --schema app --test-schema app_ut --output coverage.lcov
npx @ng-galien/postgresql-coverage --pattern 'app.invoice*' --test-pattern 'checks.invoice*' --format json
```

Schema selection covers every application PL/pgSQL routine in the selected schemas,
including routines no test calls. Pattern selection covers only matching qualified
`schema.function` names (`*` and `?` wildcards). Tests can be selected separately by
schema or pattern, or default to the same scope. No test-name prefix is required:
zero-argument functions returning `SETOF text` are candidates and their TAP output
is validated at execution. All selected candidates run; invalid output fails the suite.

Reports retain each routine and an aggregate summary. Selected tests, extension-owned
routines, and non-PL/pgSQL routines are explicitly listed as excluded, with reasons.
Unsupported PL/pgSQL instrumentation fails instead of silently reducing the denominator.
JSON/LCOV locations refer to database routine definitions, not migration files on disk.

The library exposes `StandaloneCoverage.runSchema()` and `runSelected()` with the same
selection behavior. See the [package README](https://github.com/ng-galien/postgresql-workbench/tree/main/packages/coverage)
for Node.js usage, lifecycle, connection requirements, and the local pack/install smoke test.
The following sections describe the VS Code integration, whose existing discovery
settings and dependency-based selection remain unchanged.

## Discovery

Install pgTAP in the development database. Matching functions must return
`SETOF text`; zero-argument functions can run automatically. Defaults match
`*_ut.test_*` and `*_it.test_*` against `schema.function`. Change the list with
`postgresql-workbench.tests.patterns`.

Schemas containing matched tests are treated as test infrastructure. The
dependency walker may traverse their helpers, but those helpers are not
reported as application coverage.

## How coverage is calculated

1. Resolve routines reached directly and transitively by the selected pgTAP tests.
2. Instrument the selected PL/pgSQL routines once inside a dedicated transaction.
3. Run every selected test once and collect statement and branch counters.
4. Publish coverage through VS Code's native coverage API and always roll back.

Branch coverage distinguishes executed alternatives in conditional and loop
control flow. The deployed source is checked again before detailed coverage is
returned, preventing stale editor mappings.

## Permissions

The database role needs permission to execute tests and `CREATE OR REPLACE` the
covered routines. Instrumentation briefly takes PostgreSQL locks. Routines
containing transaction control are rejected because they cannot be isolated by
the runner.

## Limits

- 200 routines per request by default.
- 300 seconds per database suite.
- 200 retained TAP lines per test.
- 1 MiB retained TAP payload per test.
- 2 databases covered concurrently.

All limits are configurable under `postgresql-workbench.coverage.*`.

> Run coverage against a development or isolated test database, never a
> production database.
