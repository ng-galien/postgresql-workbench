# AGENTS.md

## Product

PostgreSQL Workbench is the `ng-galien.postgresql-workbench` VS Code extension.
It combines PostgreSQL schema exploration, an indexed architecture graph, SQL
scratchpads and result inspection, DDL synchronization, pgTAP testing, native
PL/pgSQL coverage, and PL/pgSQL debugging. The repository also contains the
standalone TypeScript DAP server used by the extension.

The canonical repository is
`https://github.com/ng-galien/postgresql-workbench`.

## Repository layout

```text
src/                       standalone DAP server and shared services
  analysis/                Code Moniker syntax boundary
  coverage/                pgTAP coverage analysis and instrumentation
  debugger/                DAP launch, PostgreSQL backend, and session
  workbench/               PostgreSQL catalog projection and DDL sync
vscode-extension/          VS Code extension, notebook renderer, and Cockpit UI
e2e/                       PostgreSQL, DAP, coverage, and compatibility tests
demo/                      deterministic PostgreSQL demo used by showcases
docs/                      design and Marketplace showcase configuration
scripts/                   repository-level automation
packages/postgresql-dap/   independently versioned npm DAP package
```

## Documentation

- Write all repository documentation in English.
- Keep the product name, extension ID, repository URLs, commands, screenshots,
  and release instructions aligned with PostgreSQL Workbench.
- Prefer current product behavior over historical implementation details. If a
  claim cannot be verified from the checkout or a live test, remove it or mark
  it explicitly as unverified.

## Development commands

Use Node.js 22 or later.

```bash
npm install
npm --prefix vscode-extension install

npm run check                 # Biome
npm run typecheck             # DAP + extension TypeScript
npm test                      # unit and script tests
npm run build                 # DAP + extension build
npm run test:dap:package      # pack/install/runtime smoke for npm DAP
npm run package:ext           # host-platform VSIX + content verification

npm run test:e2e:up           # start PostgreSQL test fixture
npm run test:e2e:run          # real PostgreSQL integration tests
npm run test:e2e:down         # stop and remove the fixture
npm run test:e2e:legacy       # upstream EnterpriseDB pldebugger compatibility

npm run marketplace:media -- capture-all --theme light
```

During feature iterations, run the smallest relevant unit or integration test.
Before a release candidate, run the complete local gates, package the VSIX, and
verify the real VS Code and PostgreSQL paths affected by the release.

## Code Moniker runtime

- Consume the published `@code-moniker/client` and platform CLI packages from
  npm. The lockfile is the reproducible source of truth for CI and releases.
- Do not check out or build Code Moniker source from this repository's CI or
  release workflows.
- `npm --prefix vscode-extension run stage:code-moniker` stages and validates
  the installed npm runtime for the current `CODE_MONIKER_TARGET`.
- The standalone `@ng-galien/postgresql-dap` package consumes
  the optional native package installed by `@code-moniker/client`. It may use
  only a lazy MCP stdio worker for stateless SQL/PL-pgSQL parsing. It must not
  discover, launch, connect to, restart, or stop a workspace daemon; index a
  workspace; or call symbols, graph, usages, navigation, or source-set APIs.
  Do not duplicate native Code Moniker packages in the DAP.
- Code Moniker is the shared SQL and PL/pgSQL syntax/index provider. Feature
  modules receive the `SyntaxParser` port and must not construct runtime clients.
  Only the Workbench index owner and the standalone DAP syntax boundary may
  create their respective Code Moniker transport.

## Architecture invariants

- Keep `ActiveDatabaseContext` separate from a notebook's persisted
  `NotebookBinding`; never silently fall back or switch contexts.
- Sources, Graph, and status surfaces follow the active database context.
  Notebook headers, execution, inlays, and results follow the notebook binding.
- Workbench schema synchronization is structural DDL synchronization only. It is
  opt-in, uses a dedicated listener, and must never react to DML.
- Preserve indexed tree identities and visible expansion state during
  incremental refreshes.
- DAP `InitializedEvent` is sent from `initializeRequest`. Launch must respond
  before waiting for a target, and listener connections must not use
  `statement_timeout`.
- Passwords belong in VS Code secret storage and must never enter notebooks,
  launch configurations, logs, fixtures, or Git.

## CI and release workflow

### Playwright VS Code bootstrap

- Keep acceptance credentials isolated with VS Code's
  `--use-inmemory-secretstorage`; tests must never read or persist a developer's
  keychain.
- Bootstrap in this order: wait for the VS Code window, wait for the extension's
  `onStartupFinished` readiness signal, then focus the Workbench through the
  extension-owned acceptance control command. Do not open a synthetic SQL file
  or click the renderer merely to force activation.
- Linux runs need a real display such as Xvfb. Docker reproductions must use
  both `--init` and at least `--shm-size=2g`: Docker's 64 MB default `/dev/shm`
  crashes the Electron renderer with code 5 without marking the container
  `OOMKilled`, and making `xvfb-run` PID 1 prevents its `SIGUSR1` readiness
  handshake.
- Do not enable Playwright `recordVideo` or trace screenshots/snapshots for the
  VS Code Electron renderer on GitHub-hosted Linux runners: that instrumentation
  can leave the renderer unresponsive even though VS Code created its window.
  CI uses `scripts/run-playwright-ci.sh` to retain VS Code logs and a raw
  1600x1000 Xvfb screenshot on failure; local runs keep the richer artifacts.
- `playwright.bootstrap.config.ts` is the database-free runner smoke. Keep it
  separate from the full acceptance suite so Electron or extension bootstrap
  failures are diagnosed without indexing or PostgreSQL fixture noise.

- `.github/workflows/ci.yml` runs for pushes to `main`, pull requests targeting
  `main`, and manual dispatch.
- `.github/workflows/release-extension.yml` runs only for
  `extension-v<version>` tags. Never create or push a release tag unless the
  user explicitly authorizes publication.
- `.github/workflows/release-dap.yml` runs only for `dap-v<version>` tags and
  publishes `@ng-galien/postgresql-dap` through npm trusted publishing.
- A regular commit or push must never publish the extension.
- All external GitHub Actions must remain pinned to full commit SHAs with a
  readable version comment.
- The Marketplace job requires the protected `marketplace` environment and its
  `VSCE_PAT`. Confirm both before the first release tag.
- `RELEASING.md` is the operational release checklist.

## GitHub CLI on macOS

- Run every `gh` command outside the sandbox. The sandbox cannot access the
  macOS credential store used by GitHub CLI.
- An in-sandbox authentication failure is not evidence that credentials are
  invalid. Retry the exact command outside the sandbox first.
- Never run `gh auth logout`, replace credentials, or request reauthentication
  because of an in-sandbox `gh auth status` result.
- Keep authentication checks, repository settings, workflow dispatch, run
  polling, and Actions log retrieval outside the sandbox for the entire task.

## Change safety

- Preserve unrelated user WIP and stage explicit paths only.
- Do not commit generated secrets, local connection settings, `.codex/`
  configuration, raw screen recordings, VSIX files, or test databases.
- Use `apply_patch` for source and documentation edits.
- Before a non-trivial push: inspect the complete diff, run proportionate
  validations, obtain an independent read-only review, fix actionable findings,
  and re-run the reviewer on the final diff.
- Do not push, tag, create a release, or publish to Marketplace without the
  corresponding explicit user authorization.
