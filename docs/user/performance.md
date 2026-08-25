---
title: Measured performance
description: Reproducible PostgreSQL catalog indexing measurements.
eyebrow: Performance
---

# Measured indexing performance

These measurements give an order of magnitude for indexing PostgreSQL catalogs
with many structural objects and almost no application data. They are not a
service-level guarantee: hardware, concurrent workloads, object complexity, and
the installed Code Moniker runtime all affect timings.

The benchmark runs the same Workbench pipeline used by the extension:

1. introspect PostgreSQL objects;
2. materialize one virtual SQL document per object;
3. atomically publish the complete SourceSet to Code Moniker;
4. read the indexed symbols retained by Workbench;
5. query one sampled graph relation.

## Reference catalogs

The measurements below were captured on 2026-08-18 with Code Moniker `0.7.1`,
Node.js `26.7.0`, and an Apple M2 Pro with 10 logical CPUs and 16 GiB RAM.

| Profile | Schemas | Tables | Views | Routines and triggers | Documents | Symbols |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Medium synthetic ERP | 20 | 1,000 | 500 | 1,250 | 2,771 | 27,770 |
| Large synthetic ERP | 50 | 3,000 | 1,500 | 3,500 | 8,051 | 83,050 |

The large profile stays below the current 10,000-document SourceSet limit.

## Observed timings

| Phase | Medium | Large |
| --- | ---: | ---: |
| PostgreSQL introspection | 476 ms | 3.78 s |
| Virtual-document materialization | 31 ms | 71 ms |
| Code Moniker bulk publication | 2.08 s | 16.20 s |
| Workbench symbol scan | 3.78 s | 34.18 s |
| Sample graph query | 1.2 ms | 4.9 ms |
| Identical SourceSet replacement | 26 ms | 97 ms |
| One-document incremental publication | 147 ms | 339 ms |

The structural behavior is more stable than absolute timing:

- initial extraction used 10 Rayon workers and exactly one linkage;
- an identical SourceSet caused zero extraction jobs, zero linkage, and no
  generation change;
- one modified document caused exactly one extraction job, one linkage, and one
  generation increment;
- the sampled SQL `reads` relation was preserved in both profiles.

The remaining scale cost is currently Workbench's complete symbol scan with
source code and 16 context lines. On the large profile this consumer-side scan
is slower than Code Moniker's parallel bulk publication, making it the next
indexing optimization boundary.

## Reproduce the benchmark

Run the benchmark outside CI against the repository's isolated PostgreSQL
fixture:

```bash
npm run bench:workbench-index -- --profile erp-medium
npm run bench:workbench-index -- --profile erp-large
```

Use the same benchmark with the PostGIS, Tiger geocoder, and topology catalog
objects enabled when investigating extension-heavy databases:

```bash
npm run bench:workbench-index -- --profile erp-medium --postgis
```

Add `--output <path>` to keep the machine-readable JSON report for a baseline
or a comparison with another host.

Docker is the default fixture. When Docker is unavailable, configure a local
PostgreSQL server through the standard `PGHOST`, `PGPORT`, `PGUSER`,
`PGPASSWORD`, and `PGDATABASE` variables and add `--no-docker`. The benchmark
creates and removes its own uniquely named database; the selected role must
have those privileges.

The benchmark validates initial and incremental extraction jobs, worker count,
linkage count, generations, and the sampled graph relation. For the identical
replacement, it validates the public `unchanged` result and stable generation;
the detailed record also retains the daemon's zero-job and zero-linkage
diagnostic. Exact artifact provenance is kept in the
[repository benchmark results](https://github.com/ng-galien/postgresql-workbench/blob/main/benchmarks/workbench-index/results/2026-08-18-code-moniker-0.7.1-published.md).
