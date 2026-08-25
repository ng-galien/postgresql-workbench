# Code Moniker 0.8.0 Workbench index baseline

Date: 2026-08-25

Machine: Apple M2 Pro, 10 logical CPUs, 16 GiB RAM, macOS arm64

Node.js: `v26.7.0`

Code Moniker: published npm client and native runtime `0.8.0`, protocol 21

This is a comparison baseline, not a universal performance threshold. The
standard and PostGIS variants use the same generic Workbench index benchmark.
PostGIS `3.6.4`, `postgis_tiger_geocoder`, and `postgis_topology` were enabled
for the PostGIS runs.

## Results

| Metric | ERP medium | ERP medium + PostGIS | ERP large + PostGIS |
| --- | ---: | ---: | ---: |
| Tables | 1,000 | 1,000 | 3,000 |
| Virtual documents | 2,771 | 3,735 | 9,015 |
| Indexed symbols | 27,770 | 29,401 | 84,681 |
| PostGIS setup | n/a | 714.3 ms | 621.7 ms |
| Synthetic DDL | 1,858.4 ms | 1,460.5 ms | 3,438.3 ms |
| PostgreSQL introspection | 455.4 ms | 492.2 ms | 1,623.4 ms |
| Document materialization | 34.5 ms | 34.3 ms | 91.5 ms |
| Code Moniker daemon ready | 287.8 ms | 272.5 ms | 311.2 ms |
| Initial SourceSet publication | 2,123.4 ms | 3,418.7 ms | 17,054.8 ms |
| Initial Workbench indexing | 2,907.2 ms | 4,219.3 ms | 19,082.6 ms |
| Identical publication | 19.6 ms | 24.8 ms | 93.6 ms |
| One-document publication | 106.3 ms | 131.8 ms | 378.1 ms |
| Production-equivalent symbol scan | 3,789.3 ms | 4,323.4 ms | 34,048.1 ms |
| Complete scenario | 6,824.5 ms | 8,702.9 ms | 53,606.4 ms |

Every run used 10 extraction workers for the initial bulk publication, one
linkage invocation, a zero-job identical replacement, and one extraction job
for the single-document replacement. The graph probe passed.

## Interpretation for another machine

Compare phases and ratios before comparing the total. A first actionable signal
is an ERP medium initial indexing or SourceSet publication above 30 seconds,
because it reaches the previous timeout observed in the extension and remains
far outside this baseline. The current default is 120 seconds. Also investigate a
daemon-ready phase measured in seconds rather than hundreds of milliseconds,
an initial extraction worker count of one on a multicore host, a phase more
than three times this baseline on broadly comparable hardware, or large
run-to-run variance.

The large profile deliberately exposes a separate Workbench consumer cost: the
complete symbol scan can be slower than Code Moniker publication. Do not
attribute that time to SourceSet extraction or workspace startup.
