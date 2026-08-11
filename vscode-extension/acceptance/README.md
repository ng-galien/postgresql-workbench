# VS Code acceptance tests

This suite drives the real VS Code Electron workbench with Playwright. It is
separate from the extension-host integration tests under `src/test`: those
tests remain useful for fast API and protocol checks, while this suite proves
complete user-visible journeys.

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

The complete acceptance campaign runs with `workers: 1`, no retries, and one
worker-scoped VS Code fixture. VS Code and the demo database start once, all
successful scenarios run in that same application instance, and teardown
happens after the final scenario. Playwright normally discards its worker after
a failure, so the campaign is deliberately fail-fast (`maxFailures: 1`) rather
than silently launching a second VS Code instance and rebuilding the database
index for the remaining scenarios.

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

The Electron worker records one 1440×900 video for the complete shared-instance
campaign and clears the previous run before launch. Layout scenarios also
attach full screenshots for the side and bottom Source View states; these are
the authoritative visual evidence for responsive dimensions and SQL
readability.

## Run

```bash
npm run test:acceptance
npm run test:acceptance:graph-dnd
npm run test:acceptance:source-tab-cleanup
```

The command builds the production extension, starts the deterministic demo
database if needed, launches an isolated VS Code profile, performs the real UI
journey, and retains Playwright evidence on failure. Set
`PGWB_ACCEPTANCE_KEEP_DEMO=1` to leave a database started by the suite running.
Set `PGWB_ACCEPTANCE_VSCODE_VERSION` to validate a specific VS Code version.
