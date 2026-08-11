# VS Code acceptance tests

This suite drives the real VS Code Electron workbench with Playwright. It is
separate from the extension-host integration tests under `src/test`: those
tests remain useful for fast API and protocol checks, while this suite proves
complete user-visible journeys.

## Structure

- `fixtures/` owns external lifecycle: PostgreSQL demo, one isolated VS Code
  instance per Playwright worker, traces, screenshots, and cleanup.
- `pages/` contains reusable UI vocabulary for VS Code, the Workbench TreeView,
  and Cockpit webviews. Selectors and physical pointer gestures belong here.
- `specs/<feature>/` contains product acceptance scenarios phrased in user
  terms. Specs must not call extension commands or internal handlers directly.

Each migrated end-to-end scenario should reuse these fixtures and page objects.
Add a new page object only for a stable product surface; keep assertions about
business outcomes in the spec.

## Shared VS Code lifecycle

The complete acceptance campaign runs with `workers: 1` and a worker-scoped
VS Code fixture. VS Code and the demo database start once, all scenarios run in
that same application instance, and teardown happens after the final scenario.
Tests must reset only the product state they own (open editors, connections,
graph focus, and fixture data); they must never relaunch VS Code as test setup.
This keeps the suite fast while still exercising real Workbench UI gestures.

Feature journeys may use a serial group when the intermediate state is itself
part of the acceptance contract. The Cockpit campaign deliberately progresses
from an empty graph to one source and then two sources, while keeping the same
VS Code process. Each test name and step still describes one visible user
outcome so failures remain attributable.

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
npm run test:acceptance:graph-dnd
npm run test:acceptance:source-tab-cleanup
```

The command builds the production extension, starts the deterministic demo
database if needed, launches an isolated VS Code profile, performs the real UI
journey, and retains Playwright evidence on failure. Set
`PGWB_ACCEPTANCE_KEEP_DEMO=1` to leave a database started by the suite running.
Set `PGWB_ACCEPTANCE_VSCODE_VERSION` to validate a specific VS Code version.
