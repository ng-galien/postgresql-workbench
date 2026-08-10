---
title: pgTAP and coverage
description: Test database behavior and see which PL/pgSQL paths ran.
eyebrow: pgTAP and coverage
media: coverage.gif
mediaAlt: pgTAP tests with PL/pgSQL coverage in VS Code
---

# Test database behavior and see which PL/pgSQL paths ran.

Tests use VS Code's native Testing UI. Coverage is collected independently from
the debugger in a dedicated transaction.

{{media}}

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
