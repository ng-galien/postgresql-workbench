# Changelog

## Unreleased

### PostgreSQL Workbench

- Refined Cockpit graph cards with an exclusive drag handle, border-only
  interaction feedback, and a compact named layout that remains readable and
  draggable at low zoom
- Added live graph settings for the compact-card threshold, compact object-name
  scale, and edge-label scale; multiple relation labels now stack vertically
- Preserved the user-selected graph viewport and zoom when switching away from
  and back to an already-open Cockpit tab
- Closed clean virtual PostgreSQL source tabs that cannot be resolved after a
  window reload instead of leaving VS Code on a missing-file editor
- Fixed SQL scratchpad Markdown cells so they no longer display PostgreSQL
  binding controls reserved for executable code cells
- Executed multi-statement scratchpad cells sequentially on one PostgreSQL
  client, rendered only statements that return rows, and replaced internal
  stack traces with structured SQL syntax and PostgreSQL diagnostics
- Added separate Playwright journeys for graph interactions, SQL notebooks, and
  stale virtual-source cleanup; the notebook journey verifies VS Code cell
  kinds through the public API, renders Markdown, executes single and
  multi-statement queries, checks silent statements, and inspects result and
  error renderers
- Hardened the shared Playwright instance with explicit extension readiness,
  stable VS Code command IDs, native Electron window selection and resizing,
  per-scenario editor and TreeView reset, fail-fast single-instance execution,
  and guaranteed Docker, tracing, profile, and process cleanup across local,
  CI, and extension release runs
- Fixed Marketplace showcase GIF URLs in packaged VSIX metadata and added a
  packaging guard for all four published media links
- Fixed the Windows Workbench runtime handshake when Code Moniker registers a
  canonical extended-length workspace path
- Removed SQL scratchpad creation from the no-connection welcome state;
  scratchpads remain scoped to an explicit database context
- Fixed the Workbench tree header search action so VS Code view context is not
  mistaken for a text query; clicking it now reliably opens the indexed object
  picker
- Fixed scratchpad commands to consume the actual TreeView item context, kept
  unrelated selections from being mistaken for database contexts, and exposed
  **Reveal Tests** on canonical `code+moniker` routine editors
- Strengthened real VS Code integration coverage for view-title, inline
  TreeView, and editor-title actions, including assertions that interactive
  pickers remain open until the user completes or cancels them

### Standalone PostgreSQL DAP

- Split the shared DAP library from its standalone CLI and the VS Code adapter
  entry, so the extension compiles the shared implementation without importing
  the autonomous executable bootstrap
- Added the independently publishable `@ng-galien/postgresql-dap` package, its
  package validation and real PostgreSQL smoke tests, and a dedicated `dap-v*`
  release workflow
- Separated standalone DAP smoke tests from extension packaging across the
  platform matrix and made npm invocation portable on Windows runners
- Reduced the standalone DAP dependency on Code Moniker to lazy, stateless
  SQL/PL/pgSQL parsing on demand; it no longer manages a workspace daemon,
  indexes sources, or requires Code Moniker URIs
- Preserved exact host-provided source URIs, including their schemes and
  authorities, so the Workbench client and its compiled DAP use the same Code
  Moniker identities
- Kept standalone source retrieval independent from Workbench indexing through
  standard positive DAP source references when no host URI is available, without
  inventing an adapter-owned fallback URI
- Hardened the private syntax worker lifecycle with bounded graceful shutdown,
  SIGTERM and SIGKILL fallbacks, cleanup tests, and an executable architecture
  guard for the reduced DAP boundary
- Documented standalone installation, transport, launch contracts, packaging,
  release tags, platform smoke tests, and the exact Code Moniker boundary

### Documentation tooling

- Normalized generated documentation formatting so repeated site builds remain
  deterministic

## [1.0.0] - 2026-08-10

First Marketplace release of PostgreSQL Workbench: one VS Code extension for
exploring, querying, testing, covering, and debugging PostgreSQL development
databases.

### PostgreSQL Workbench

- Added a unified connection tree organized by server and database context,
  with indexed Sources and persistent SQL Scratchpads
- Added the PostgreSQL Cockpit: searchable dependency graphs with upstream and
  downstream expansion, relation filters, source inspection, pins, and saved
  perspectives
- Added persistent SQL notebooks with explicit database bindings, dedicated
  execution clients, sortable and paged result grids, structured value
  inspection, and bounded TSV export
- Added opt-in structural DDL synchronization through PostgreSQL event triggers
  and a dedicated LISTEN/NOTIFY client, using incremental Code Moniker source
  replacement with an explicit full-refresh fallback
- Added indexed source navigation for schemas, tables, views, routines,
  constraints, and triggers while preserving visible tree state during
  incremental refreshes
- Added a generated documentation site with focused Cockpit, scratchpad,
  coverage, debugger, DAP, command, and settings guides

### Autonomous Code Moniker runtime

- Bundled the matching Code Moniker Node client and platform daemon in the
  Workbench VSIX so database indexing requires no adjacent source checkout
- Added platform, protocol, executable, and checksum validation before the
  Workbench starts or joins a workspace daemon
- Staged the runtime exclusively from the published npm packages locked by the
  extension lockfile
- Added native Linux x64, macOS ARM64, macOS x64, and Windows x64 VSIX build
  matrices with host/target mismatch rejection
- Replaced external ZIP tooling with portable Node verification and validated
  the staged package metadata and native binary checksum before packaging

### PostgreSQL Workbench routine comparison

- Added a CodeLens that compares a local PL/pgSQL routine with the exact
  overloaded routine in the active indexed PostgreSQL snapshot
- Preserved quoted and array type identities, validated the snapshot and
  connection before opening a diff, and kept comparison read-only

### pgTAP testing and native PL/pgSQL coverage

- Added connection-scoped pgTAP discovery in VS Code Test Explorer with
  configurable `schema.function` glob patterns
- Added lazy AST dependency discovery that traverses dedicated test-schema
  helpers without reporting those helpers as application coverage
- Added standard Run and Run with Coverage profiles with native pass, fail,
  error, skip, cancellation, statement, and branch results
- Added transactional multi-routine coverage: selected routines are
  instrumented once, selected pgTAP tests execute once, and exact routine
  definitions are restored by rollback
- Added OID-bound `plpgsql://` coverage sources, editor hit/miss ranges, stale
  source detection, and overload-safe navigation
- Added include/exclude patterns, routine/output/time/parallelism limits, and
  LCOV or JSON export through **PL/pgSQL: Export Last Coverage**
- Added PostgreSQL, legacy debugger, and real VS Code integration coverage for
  success, failure, cancellation, cleanup, source mapping, and pgTAP state
  isolation

### Compatibility and variable inspection

- Added an automated compatibility gate against the unpatched EnterpriseDB
  pldebugger v1.9 on PostgreSQL 17
- Standard legacy pldebugger builds keep scalar inspection and stepping
  functional even when records, rows, and record fields are not exposed
- Anonymous records populated by `SELECT INTO` and `FOR ... SELECT` expand into
  DAP child variables when the server publishes their JSON representation
- Explicit SQL casts preserve PostgreSQL field types such as `int4`, `numeric`,
  `date`, `text`, arrays, and JSONB; runtime JSON inference remains the fallback
- Expanded fields now expose evaluable names such as `rec.id` and `rec.tags[0]`

### Reliability

- Debug sessions can no longer leave orphaned pldbgapi sessions: blocked
  listener backends are terminated through an auxiliary connection, and the DAP
  server cleans up on SIGTERM/SIGINT/stdio close
- Session transitions are explicit and observable in the Debug Console; cleanup
  and the terminal DAP event are idempotent
- `stopOnEntry` now defaults to `true` consistently for CodeLens, generated
  `launch.json` configurations, and direct adapter launches. Set it to `false`
  for intentional run-to-breakpoint behavior
- Concurrent execution commands are rejected while a blocking pldbgapi
  continue/step call is already in flight
- CodeLens, F5, `launch.json`, and programmatic launches share one atomic
  admission gate; concurrent launches are rejected before creating PostgreSQL
  backends, and failed launches release the gate after cleanup
- Repeated line-breakpoint requests reconcile with the target instead of
  accidentally dropping an already installed breakpoint
- Each session uses a unique `application_name` — concurrent debug sessions
  (multiple windows, shared dev servers) no longer interfere; orphan cleanup
  only targets listener backends, never running queries
- A SQL call that completes without reaching the debugged routine now publishes
  its result and fails immediately; `attachTimeoutMs` (default 30s) remains the
  fallback for a target that is still running
- End-of-function is detected immediately instead of hanging up to 10s
- Stack trace, variables, and breakpoint requests survive connection loss —
  the session ends cleanly with a message instead of freezing panels
- Breakpoints set before the session is ready are re-applied and re-verified
  once attached
- Functions using record field assignment (`rec.field := x`) no longer break
  source analysis (parser fallback)
- The connection tree now exposes **Debug sessions** recovery: stale or blocked
  listener/target pairs can be inspected and explicitly terminated together,
  with exact DAP application-name checks protecting unrelated PostgreSQL
  backends
- Debug backend names retain the target routine OID, allowing a reloaded
  extension to recover the schema, routine, kind, state, and exact backend PIDs
  even after the original adapter has disappeared

### UX

- Standalone SQL callsites now require an explicit per-statement PostgreSQL
  connection assignment; the Debug CodeLens appears only after assignment and
  the selected server remains visible beside the call
- Continuing a call to completion now reveals the dedicated PL/pgSQL Results
  panel instead of opening VS Code's generic view command palette
- Starting a subsequent callsite no longer reopens Results while VS Code is
  navigating to the newly stopped routine; pending executions update history
  silently and the panel appears only on completion or failure
- Every suspension publishes its current routine URI and line; Step Into opens
  the called routine, while manual navigation to another call-stack frame is no
  longer overwritten by an automatic retry
- Expandable record, composite, JSON, and array variables use compact `{…}` or
  `[…]` placeholders in the Variables tree instead of multiline JSON values
- CodeLens SQL extraction now ignores leading comments and honors PostgreSQL's
  UTF-8 byte offsets, including accented demo files, so words such as `SELECT`
  inside comments cannot corrupt the launched statement
- Debugged `SELECT`/`CALL` results now appear in a reusable **PL/pgSQL
  Results** panel with a bounded grid, JSON/composite cell inspection, recent
  history, copy, and CSV/JSON preview export
- Result collection streams rows into a retention-bounded preview (rows,
  displayed cells, payload, and history); the Debug Console keeps a compact
  DAP-compatible fallback
- Bytea is truncated before hex conversion, and CSV/TSV exports neutralize
  spreadsheet formulas
- Result history now identifies the callsite and reports running and failed
  executions instead of leaving an older success looking current
- The result grid has roving keyboard focus, arrow navigation, keyboard
  inspection/copy, visible PostgreSQL types, explicit zero-row feedback, and a
  formatted/raw JSON inspector
- Row, cell, and payload truncation are reported separately; incomplete exports
  require confirmation, and CSV/TSV use `\N` for PostgreSQL `NULL`
- Debugging a callsite pins its SQL editor so revealing the stopped routine
  source no longer closes the originating file
- New command **PL/pgSQL: Check Server Requirements** with a guided setup:
  Docker one-liner, self-hosted instructions, managed-cloud guidance
- Registered servers appear as dynamic configurations in "Run and Debug" —
  no launch.json needed; the SQL statement is prompted at launch
- Launched sessions are persisted to `.vscode/launch.json` for F5 replay
- Cancelled or failed launches show a clear warning instead of failing silently
- Connection progress is cancellable
- Status bar distinguishes "connection lost" (warning color) from
  "no connection"; welcome view with prerequisites shown on first open
- Re-adding an existing server offers to connect; server removal asks for
  confirmation; consistent Escape/empty-value handling in the Add Server wizard
- Context commands no longer appear (and crash) in the Command Palette

## [0.1.0] - 2026-04-08

### Added

- DAP server for PL/pgSQL debugging via pldbgapi
- Step over, step into, continue
- Breakpoints with steppable line validation
- Stack trace with virtual source documents (`plpgsql://`)
- Variables panel with expandable records and arrays
- Evaluate on hover and watch panel
- Step-in targets (function calls on current line)
- Connection picker (SQLTools, pgsql, manual)
- CodeLens "Debug" on CREATE FUNCTION/PROCEDURE, CALL, SELECT
- Function TreeView explorer by schema
- Inline values during debug
- PL/pgSQL semantic token highlighting
- Dollar quoting support (`$$` and `$tag$`)
