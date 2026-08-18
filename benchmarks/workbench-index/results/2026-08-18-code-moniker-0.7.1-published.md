# Code Moniker 0.7.1 published Workbench validation

Date: 2026-08-18  
Status: validated against the published npm dependency  
Machine: Apple M2 Pro, 10 logical CPUs, 16 GiB RAM, macOS arm64  
Node.js: `v26.7.0`

## Provenance

The validation used the Code Moniker artifacts published on npm and installed
through the Workbench lockfiles:

| Artifact | SHA-256 |
| --- | --- |
| `code-moniker-client-0.7.1.tgz` | `9ddbe4e6fbc7e73c2e3c25da3f12b8a7099d2ff49668a9c88a337a1c8d6bc72e` |
| `code-moniker-cli-darwin-arm64-0.7.1.tgz` | `d7cdbc6af3ba86d5ba9768471bcd638a78258dc9ddf337b830b7a85209702cdd` |
| staged `code-moniker` binary | `8aa2fc95997295622e203a959af77d3ecfb4cafa4500880980958d81a9688796` |

The staged Workbench runtime reported:

- client version `0.7.1`;
- binary version `0.7.1`;
- protocol version `17`;
- native target `darwin-arm64`;
- the exact binary SHA above.

Both Workbench package manifests and lockfiles require exact version `0.7.1`.
The staged runtime was rebuilt from those installed npm packages before each
benchmark profile.

## SQL syntax budget contract

The real staged runtime was exercised through the Workbench
`createCodeMonikerSyntaxParser` adapter in
`e2e/code-moniker-runtime.test.ts`.

Confirmed behavior:

- the PostgreSQL SELECT containing 17 qualified columns parses with
  `maxDepth: 64` and `maxNodes: 2_000` without truncation;
- `maxDepth: 1_000` and `maxNodes: 20_000` are accepted without a server clamp;
- a deliberately small `maxDepth: 4`, `maxNodes: 10` budget truncates
  deterministically and remains within the requested node bound;
- `maxNodes: 0` is rejected.

Targeted proof:

```text
e2e/code-moniker-runtime.test.ts: 3/3 passed
```

## SourceSet contract

Both benchmark profiles executed the exact Workbench SourceSet publication
path. The runner checks the bulk and single-document structural counters and
fails if they drift. For an identical replacement, the public command response
reports `unchanged` and preserves the generation. Protocol 17 retains the
preceding operation timings in `WorkspaceStatus`, so the zero-job and
zero-linkage values below come from the daemon diagnostic emitted for the same
request rather than from that status object.

| Scenario | Medium result | Large result |
| --- | --- | --- |
| documents / symbols | 2,771 / 27,770 | 8,051 / 83,050 |
| initial mode | `bulk` | `bulk` |
| initial extraction jobs | 2,771 | 8,051 |
| observed extraction workers | 10 | 10 |
| initial linkage invocations | 1 | 1 |
| initial generation | 2 | 2 |
| identical replacement | 0 jobs, 0 linkage | 0 jobs, 0 linkage |
| identical generation | 2 | 2 |
| changed documents | 1 | 1 |
| incremental extraction jobs | 1 | 1 |
| incremental linkage invocations | 1 | 1 |
| incremental generation | 3 | 3 |
| sample view outgoing `reads` | 1 | 1 |

The SourceSet therefore remains one atomic publication while extraction work
is proportional to the actual URI/language/content delta.

## Workbench-observed timings

These are independent local runs after aligning the benchmark symbol query
with the production controller (`includeCode: true`, `contextLines: 16`, pages
of 500 symbols).

### Medium

| Phase | Duration |
| --- | ---: |
| PostgreSQL introspection | 476.0 ms |
| virtual-document materialization | 30.7 ms |
| Code Moniker bulk transition | 2,077 ms |
| extraction inside bulk | 1,559 ms |
| linkage inside bulk | 159 ms |
| client-observed publication | 2,135.0 ms |
| identical publication | 25.6 ms |
| one-document transition | 114 ms |
| client-observed one-document publication | 146.7 ms |
| production-equivalent symbol scan | 3,778.5 ms |
| sample graph query | 1.2 ms |

### Large

| Phase | Duration |
| --- | ---: |
| PostgreSQL introspection | 3,783.3 ms |
| virtual-document materialization | 70.9 ms |
| Code Moniker bulk transition | 16,201 ms |
| extraction inside bulk | 13,661 ms |
| linkage inside bulk | 1,279 ms |
| client-observed publication | 16,378.6 ms |
| identical publication | 97.4 ms |
| one-document transition | 235 ms |
| client-observed one-document publication | 338.5 ms |
| production-equivalent symbol scan | 34,182.2 ms |
| sample graph query | 4.9 ms |

Timing variation from the Code Moniker producer's measurements is expected on
an interactive development machine. The stable conclusions are the job,
worker, linkage and generation counters; all matched exactly.

## Workbench conclusion

The published Code Moniker `0.7.1` build fixes the two upstream blockers for the
Workbench integration:

1. Workbench-selected syntax budgets are transmitted and honored;
2. virtual SQL SourceSets use parallel bulk extraction and exact incremental
   refresh while retaining one linkage and atomic generation.

One independent Workbench-side scale cost remains visible. The controller reads
and retains every indexed SQL symbol after publication using `includeCode` and
16 context lines. That query took 3.8 seconds for 27,770 symbols and 34.2 seconds
for 83,050 symbols, exceeding Code Moniker bulk time on the large profile. It is
not a failure of the SourceSet correction, but it is the next relevant
Workbench indexing optimization target.

The published dependency, staged runtime, syntax contract, and benchmark
contracts are now aligned on Code Moniker `0.7.1`.
