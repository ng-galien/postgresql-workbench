# AGENTS.md

## Agent collaboration

- Carry authorized work through implementation, relevant validation, and review.
  Resolve routine choices from the checkout and conversation; ask only when
  missing information materially changes the outcome. Continue independent work
  while awaiting an answer.
- Keep read-only requests read-only. Raise product or architecture decisions
  explicitly when they change the agreed scope or contracts.
- Reuse authorization already given for the same action and scope. Commit,
  push, merge, and publication remain separate authorization boundaries.
- Treat mid-task corrections as updates to the ongoing task; preserve completed
  work and the original objective unless the user replaces it.
- Use applicable skills for their specific task. Explain any instruction that
  blocks progress, with its source and the concrete action requiring approval.
- Delegate bounded, independent work when requested; use an independent
  read-only reviewer for the delivery gates below. Give reviewers the scope,
  final diff, and validation evidence; report findings only after they return.
- Keep updates and final answers concise, in the user's language. State the
  outcome, evidence, and remaining limitations; repository documentation stays
  in English.

These collaboration rules apply the
[GPT-6 Astra guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra)
to this repository.

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
packages/                  the engine, one package per subject
  sql/                     Code Moniker syntax boundary, SQL and PL/pgSQL analysis,
                           and the SQL authoring language server
  catalog/                 PostgreSQL catalog projection, DDL sync, and the Cockpit graph
  rows/                    reading and editing relation rows: query composition,
                           editability, and the Data View engine
  presentation/            host-neutral visual roles, default theme, and PostgreSQL identities
  editor/                  host-neutral Monaco editor and official LSP client integration,
                           depending only on SQL authoring and presentation contracts
  views/                   the React views every surface renders: result grid,
                           Data View, Cockpit, debug results
  coverage/                pgTAP coverage analysis and instrumentation
  dap/                     `@ng-galien/postgresql-dap`, the independently versioned
                           npm DAP server: launch, PostgreSQL backend, and session
  shell/                   browser harness driving the views without VS Code
  runtime/                 standalone database sessions, scratchpads, and retained observations
  mcp/                     MCP stdio/HTTP adapters and project integration over the standalone runtime
vscode-extension/          VS Code extension: the host that adapts the engine to VS Code
e2e/                       PostgreSQL, DAP, coverage, and compatibility tests
demo/                      deterministic PostgreSQL demo used by showcases
docs/                      user guide, design, and Marketplace showcase configuration
scripts/                   repository-level automation, one directory per purpose
```

## Documentation

- Write all repository documentation in English.
- Keep the product name, extension ID, repository URLs, commands, screenshots,
  and release instructions aligned with PostgreSQL Workbench.
- Keep every user-visible capability aligned across the complete documentation
  surface: the root `README.md`, `vscode-extension/README.md`, extension metadata,
  the public GitHub repository description and homepage, the landing page in
  `site/`, its guide and navigation in `docs/user/`, and the shared showcase
  declaration in `docs/marketplace-showcase.json`.
- A showcase scene promoted on the documentation site must declare its `site`
  asset name in `docs/marketplace-showcase.json`; the landing page and guide must
  then reference the generated asset. Capturing Marketplace media alone does not
  publish that capability on GitHub Pages.
- Prefer current product behavior over historical implementation details. If a
  claim cannot be verified from the checkout or a live test, remove it or mark
  it explicitly as unverified.

## Development commands

Use Node.js 24 or later, the version CI installs.

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
Choose checks that exercise the affected behavior. Documentation-only changes
need a diff and content review, not a product test suite. After checks pass,
repeat or broaden them only for subsequent edits, failures, or unresolved risks.
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

## GitHub issue workflow

- `scripts/issues/workflow.mjs` is the canonical source for technical labels,
  durable capabilities, body sections, and delivery requirements. The script
  consumes it directly. GitHub requires static forms, so
  `scripts/issues/check-templates.mjs`, run by `npm run check`, compares each
  committed form byte-for-byte to its complete projection and rejects drift.
- Use the repository issue forms in `.github/ISSUE_TEMPLATE/` for human-created
  issues. `bug.yml` applies `bug`; `product-improvement.yml` applies
  `enhancement`. Both capture the product capability, but GitHub forms cannot
  convert a dropdown choice into a label dynamically.
- Apply one technical label (`bug`, `enhancement`, `documentation`,
  `dependencies`, or `github_actions`) and the relevant durable capability
  label during triage: `capability:cockpit`, `capability:scratchpads`,
  `capability:testing-coverage`, and/or `capability:debugger`. Use more than
  one capability only for a genuine cross-capability workflow.
- Agents can preview a body rendered from the canonical workflow without a GitHub write using
  `node scripts/issues/create.mjs`. It requires a type, title, problem,
  expected behavior, and acceptance-criteria files, which must not be empty;
  use `--context-file` for
  optional context, and bug reports also require actual behavior, reproduction
  steps, and environment files. The supported `--type` values are the technical
  labels above. Add `--create` only when issue creation is explicitly
  authorized. Pass one or more
  `--capability capability:<name>` options so the approved labels are applied
  with the issue.
- Every implementation issue uses a dedicated branch; do not share an
  implementation branch between tickets. A user-visible change needs a
  Playwright journey as its primary proof. Add focused unit, integration, or
  other tests when the affected code contract warrants them; they complement
  rather than replace the Playwright proof.
- Before delivery, run the relevant validations and obtain an independent
  read-only review as the final gate. Address actionable findings and rerun the
  relevant validations and review on the final diff. Never put passwords,
  connection strings, or private database data in an issue.

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
