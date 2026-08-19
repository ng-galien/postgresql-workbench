# Workbench index benchmark

This internal benchmark measures the real PostgreSQL Workbench indexing path:

1. create an empty synthetic ERP schema in PostgreSQL;
2. introspect the PostgreSQL catalog and materialize virtual SQL documents;
3. publish the source set to the packaged Code Moniker runtime;
4. republish the identical set to verify the idempotent no-op;
5. change one virtual document to measure incremental replacement;
6. enumerate the indexed Workbench symbols and probe one graph relation.

It deliberately inserts no business rows. The benchmark measures schema volume,
not query or storage performance, and is not part of CI.

## Run

```bash
npm run bench:workbench-index -- --profile erp-medium
npm run bench:workbench-index -- --profile erp-large
```

The runner uses a dedicated Compose project and port `55433`, builds from the
existing demo PostgreSQL image, stages the installed Code Moniker runtime, and
removes its database container and volume after the run by default.

Set `PGWB_BENCH_PORT` to use another host port. Use `--skip-build` only after
the TypeScript output and packaged runtime have already been prepared. Use
`--keep-database` to retain the generated database for inspection, then clean it
up explicitly:

```bash
COMPOSE_PROJECT_NAME=postgresql-workbench-index-benchmark \
  docker compose -f docker/benchmark/compose.yml down -v
```

## Profiles

| Profile | Schemas | Tables | Views | Functions | Procedures | Triggers | Columns per table |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `erp-medium` | 20 | 1,000 | 500 | 500 | 250 | 250 | 12 |
| `erp-large` | 50 | 3,000 | 1,500 | 1,500 | 1,000 | 500 | 12 |

Trigger support functions are additional routines. Tables form a cross-schema
foreign-key chain; views read and join those tables; functions read them;
procedures update them; and triggers reference their support functions. This
provides useful graph structure without pretending to model a real ERP domain.

The large profile stays below Code Moniker's current limit of 10,000 documents
per source set. It generates about 8,051 virtual documents, including schema and
database documents and the additional trigger support functions.

The final JSON report includes generated catalog counts, DDL time, catalog
introspection, document materialization, Code Moniker phase timings and
generations for all three publications, symbol scan, graph probe, total indexing
time, and process memory.

When the staged Code Moniker runtime exposes memory SourceSet telemetry, the
runner enforces the bulk and single-document job, worker, linkage, and
generation contracts. For an identical replacement, protocol 17 exposes the
`unchanged` command result and stable generation while retaining the preceding
operation timings in `WorkspaceStatus`; the daemon diagnostic output provides
the zero-job and zero-linkage observation recorded under [`results/`](results/).

The reported memory is the Node benchmark runner's memory. It does not claim to
measure the separate PostgreSQL container or Code Moniker daemon processes.
