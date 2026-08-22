# VS Code acceptance tests

This suite drives the real VS Code Electron workbench with Playwright. It is
separate from the six extension-host technical checks in
`src/test/extension.test.ts`: those checks cover activation and narrow VS Code
API adapters without PostgreSQL, while this suite proves complete user-visible
scenarios.

## Test boundary

User scenarios belong in Playwright, including TreeView commands, Quick Picks,
notebooks, Testing and coverage, debugger navigation, webviews, editor cleanup,
and visible schema synchronization. The extension-host suite must not grow a
second database-backed integration campaign. It is limited to checks that are
both faster and more precise below the UI boundary: activation and command
registration, the shared syntax adapter, inline-value projection, semantic
token projection, stateless PL/pgSQL analysis, and virtual-source writes.

Protocol and PostgreSQL backend contracts remain in the root Vitest/E2E suites;
they are not duplicated through the extension host. When a regression is only
observable after composing VS Code UI, extension code, and PostgreSQL, add or
extend a Playwright scenario instead of a `src/test` integration test.

## Structure

- `fixtures/` owns external lifecycle: PostgreSQL demo, the isolated VS Code
  instance, traces, screenshots, and cleanup.
- `pages/` contains reusable UI vocabulary for VS Code, the Workbench TreeView,
  and Cockpit webviews. Selectors and physical pointer gestures belong here.
- `specs/<feature>/` contains product acceptance scenarios phrased in user
  terms. Specs must not call extension commands or internal handlers directly.

Each migrated end-to-end scenario should reuse these fixtures and page objects.
Add a new page object only for a stable product surface; keep assertions about
business outcomes in the spec.

## Shared VS Code lifecycle

The database-backed campaign is split into two independent lanes. The Core lane
contains the connection cinematics, index lifecycle, Scratchpads, notebooks,
Graph, search, coverage-to-debug transition and SQL authoring. Schema Sync owns
a second lane because its listener provisioning and DDL cleanup deliberately
mutate the indexed scope. CI runs those lanes in parallel on separate runners;
each therefore owns a VS Code profile, demo database and index. A third,
database-free Bootstrap lane diagnoses Electron or extension activation before
database and indexing behavior are involved.

Every lane runs with `workers: 1`, no retries, and one worker-scoped VS Code
fixture. Inside a database-backed lane, VS Code and PostgreSQL start once and
the scenarios deliberately reuse one index. No test rebuilds an index merely to
isolate itself. Playwright normally discards its worker after a failure, so each
lane is deliberately fail-fast (`maxFailures: 1`) rather than silently
launching a second VS Code instance for the remaining scenarios.

The Playwright project names and `PGWB_ACCEPTANCE_LANE` values are exactly
`bootstrap`, `core`, and `schema-sync`. Worker fixtures may use that explicit
identity for lane-owned setup or teardown; they must not infer it from a test
title or file path.

Before and after every scenario, the harness saves and closes editors, waits
for in-flight Workbench Graph operations, focuses the Workbench through its
stable view command, restores the 1440x900 viewport, and collapses the TreeView.
Connections and the database index remain campaign-scoped because they are
expensive infrastructure, but every test reconstructs the UI state and product
focus it needs. Tests must never rely on an editor, graph focus, expanded
branch, or selection left by a previous scenario, and they must never relaunch
VS Code as test setup.

## Timing and evidence

Timeouts belong to the functional action that owns them. Ordinary UI gestures
normally use a five-second bound; database indexing explicitly gets thirty
seconds. Do not introduce shared timeout constants: a failure must name the
action that timed out so its measured duration can be reviewed independently.

Local runs retain screenshots and one 1440×900 Electron video per lane. CI and
the Linux Docker runner disable that rich Electron instrumentation because it
can make the renderer unresponsive under Xvfb. They instead retain VS Code logs,
JUnit output and a rolling 1600×1000 Xvfb screenshot. On failure, the last live
frame is preserved as the final screenshot before Electron teardown can replace
it with a black root window.

A Playwright trace is asked for rather than always taken: `PGWB_PLAYWRIGHT_TRACE=1`
records one, covering the whole lane. One VS Code serves every scenario, so
collecting screenshots and DOM snapshots across every webview it holds costs as
much as the lane is long — two minutes of shutdown for a seven-minute lane, paid
whether or not anyone opens the zip. Each run records what its shutdown cost in
`teardown-timing.json`, beside the other artefacts.

## Run

```bash
npm run test:acceptance
npm run test:bootstrap
npm run test:acceptance:core
npm run test:acceptance:schema-sync
npm run test:acceptance:debugger
npm run test:acceptance:graph-dnd
npm run test:acceptance:source-tab-cleanup
```

`test:acceptance` runs Core and Schema Sync sequentially with a fresh worker for
each lane. Use a lane-specific command while iterating so the other state
machine is not needlessly rebuilt.

To reproduce the Linux CI environment locally, run all three lanes or target
one lane and pass Playwright filters through the runner:

```bash
npm run test:acceptance:docker
npm run test:acceptance:docker -- bootstrap
npm run test:acceptance:docker -- core --grep "SQL authoring"
npm run test:acceptance:docker -- schema-sync
```

Each invocation creates a unique Docker Compose project and writes evidence to
`test-results/docker/<run-id>/<lane>`, so concurrent or repeated runs cannot
reuse a profile, database, container name, built image tag or result directory.
Compose derives the runner and PostgreSQL image names from that project and the
runner removes only those project-local images during cleanup. The default
command gives Bootstrap, Core and Schema Sync separate projects and gives both
database-backed lanes fresh PostgreSQL fixtures. Set `PGWB_PLAYWRIGHT_RUN_ID`
when a stable diagnostic identifier is useful; the runner refuses to overwrite
evidence for an existing identifier.

The image pins Node 22.23.2 and Playwright 1.62.1 by their multi-architecture
image manifests, plus VS Code 1.109.0 and Ubuntu Noble. It caches that exact VS
Code binary during the image build instead of following the moving `stable`
channel. The PostgreSQL 17/pldebugger demo base is pinned to its verified
multi-architecture manifest as well, and the runner prints the resulting
fixture image ID. The runner defaults to `linux/amd64` for GitHub
Actions parity, uses Xvfb with a 1600x1000 display, runs with an init process and
2 GiB of shared memory, and shares the demo PostgreSQL network namespace so the
canonical `localhost:5434` fixture remains unchanged. Bootstrap has no database
dependency. Set
`PGWB_PLAYWRIGHT_DOCKER_PLATFORM=linux/arm64` for a faster native Apple Silicon
diagnostic run. Set `PGWB_PLAYWRIGHT_DOCKER_KEEP=1` only when the isolated demo
database must remain available after the runner exits.

The command builds the production extension, starts the deterministic demo
database if needed, launches an isolated VS Code profile, performs the real UI
scenario, and retains Playwright evidence on failure. Set
`PGWB_ACCEPTANCE_KEEP_DEMO=1` to leave a database started by the suite running.
Set `PGWB_ACCEPTANCE_VSCODE_VERSION` only for an intentional compatibility run;
CI and Docker always select 1.109.0 unless explicitly rebuilt otherwise.
