# Changelog

## Unreleased

- Let slower Code Moniker workspaces finish loading before Workbench indexing
  fails: the workspace readiness wait now follows the configured command
  timeout, whose default is 120 seconds instead of a separate hard-coded 30
  seconds
- Repaired the repository Workbench index benchmark, made its npm subprocesses
  portable to Windows, added optional PostGIS coverage and JSON reports, and
  allowed an existing local PostgreSQL server when Docker is unavailable

## [1.4.0] - 2026-08-22

PostgreSQL Workbench 1.4.0 adds the Data View: an editor tab that holds a query,
the rows PostgreSQL answered with, and the changes made to them and not yet
written. Tables, views, and query results open in one editable grid, composed
from the Workbench Index and written back in one guarded transaction.

### Data View

- Added the **Data View**, opened from a table or view in the database tree, or
  from the statement under the cursor in a SQL file
- Composed the query from inside the view: project a table's remaining columns,
  join a related table on the key the planner derives from the foreign keys, add
  any other relation, and take a table back out with everything that referenced
  it — by pointer or by keyboard alone
- Filtered on a `WHERE` the reader types, completed by the SQL language server
  against the indexed Connection, and sorted on any column with multiple
  criteria, reversible in place and an explicit NULLS ordering only where
  PostgreSQL would do otherwise
- Edited rows the way a spreadsheet does — cell and rectangle selection, row
  selection in the gutter, copy and tab-separated paste, added rows placed where
  the reader is — with every change held until it is applied
- Applied every pending change in one transaction, each statement parameterized
  and guarded against the row having moved; a stale or missing row rolls the
  whole write back and says which row it was
- Said what a deletion drags along under each foreign key before it happens, and
  refused row addition and deletion where a join means no one table owns the row
- Hid identity and relationship columns by default while keeping them projected,
  so rows stay identified and editable; new setting
  `postgresql-workbench.dataView.hideKeyColumns`
- Paged relations too large to load at once, loading the rest on demand
- Exported the selection, the loaded rows, or every row of the query as CSV,
  TSV, JSON, SQL `INSERT`, or Markdown, with a preview of what will be written
  and hidden columns left out
- Told two JOIN paths apart when they traverse the same relations, by naming the
  key each hop is taken on: a billing and a shipping address to the same table
  used to offer two identical choices
- Coloured the SQL panel by what the language server makes of the query: a
  schema, a relation, the alias standing for it and a column of it are told
  apart, over the syntax colouring the grammar already gave
- Coloured the WHERE field the same way, by asking about the condition as part
  of the query it belongs to
- Brought back the scrollbar across a result wider than its pane: hiding the one
  down the rows, which the grid draws by hand, had hidden that one too
- Followed an address in a cell with Ctrl/Cmd+click, as an editor does, so a
  plain click selects the cell it lands on
- Moved the SQL panel under the toolbar that opens it, gave it a height that
  follows the window instead of a fixed one, and gave every scrollable pane of
  the view the same scrollbar
- Marked the WHERE and ORDER BY lines alike, and dropped the run control at the
  end of the filter: Enter runs it, and the field says when it holds something
  not yet run
- Kept the caret on the filter line while the rows it asked for are fetched
- Stopped the filter box painting itself with the theme's accent colour, which
  left an idle filter reading as a focused one on a light theme
- Added a menu on right-click, on a cell and on a column heading: **Filter** and
  **Exclude** write the condition the cell stands for into the WHERE field —
  where it can be read, corrected and undone — **Inspect** opens the value,
  **Open** follows an address the cell holds, and **Copy** takes the selection.
  It walks with the arrows and gives the focus back where it came from
- Followed an address a cell holds through the host rather than through the page:
  in a VS Code webview a click the grid dispatches itself is ignored and a plain
  click reached the browser whatever the grid did, so the menu's **Open** did
  nothing and the Ctrl/Cmd requirement was not applied. Every result surface —
  Data View, Scratchpad, debug results — now says what the reader asked for and
  the extension opens it, refusing anything that is not `http` or `https`
- Gave a link cell a small open mark, revealed on hover and taking a plain click
  to the address, so following one is not a chord a reader has to be told about
- Opened that menu from the keys, with Shift+F10 or the Menu key, under the cell
  the cursor is on — which is also how the keyboard now follows a link, so the
  grid stays a single stop in the tabbing order
- Drew every menu of the view with the one menu component: the columns picker,
  the additions picker, the actions menu and the pending-changes list dismiss
  alike, walk alike, and turn what is on and off with a checkbox that says so
- Named a Data View opened on a statement after the relations that statement
  draws from, once the query has been read, instead of the statement itself: a
  tab an inch wide showed a wall of column names
- Added new commands **Open Data View** and **Open Data View for Statement**

- Added a Marketplace card for the Data View, first on the page: a related table
  joined on the key the planner derives, a filter written from what a cell holds,
  an order taken, and the composed query opened beside the rows it drew

### SQL authoring

- Proposed the language a statement is written in — `AND`, `OR`, `IS NOT NULL`,
  `ORDER BY`, `LEFT JOIN` and the rest — beside the relations, columns and
  routines the Workbench Index knows. Completion used to offer names only, so a
  reader typing `an` into a condition was answered with nothing
- Said what each proposal replaces instead of leaving every client to guess it:
  a phrase now takes every word it continues, so `IS NOT NULL` accepted after
  `id is n` no longer writes `id is IS NOT NULL`

### Scratchpads and results

- Paged every read-only result through one shared `LIMIT`/`OFFSET` envelope
  instead of a PostgreSQL cursor. The first page and each Next execute the
  wrapped query independently and release the connection: no cursor and no
  Transaction stay open between two pages, so a result left on screen holds
  nothing on the server. Previous reads a page already in memory. Because each
  page is its own statement, a query with no `ORDER BY` of its own is not
  guaranteed to divide into stable pages — the Data View completes the order
  with the keys of the relations it projects wherever it can prove them
- Removed the settings the cursor needed —
  `postgresql-workbench.results.maxCachedRows` and
  `postgresql-workbench.results.cursorIdleTimeoutSeconds` — and added
  `postgresql-workbench.results.maxCellBytes` (256 KiB) in their place. Remove
  the first two from your settings if you set them; VS Code reports a setting
  it no longer knows. The new one is the hard limit of what a result retains
  per cell: the grid shortens a long value only to draw it, and inspection,
  clipboard and export read the retained value, not the shortened one
- Showed a command report for a successful `INSERT`, `UPDATE` or `DELETE`
  without `RETURNING`: the operation and the rows it affected, in the result
  grid, so a statement that returns no row set still answers with something to
  read, select and copy. A data-changing statement with `RETURNING` remains a
  regular row result
- Exported a result as CSV, TSV, JSON or Markdown at three scopes — the
  selection, the rows loaded, or the entire query — with a preview written by
  the module that writes the file. **Entire query** runs the statement again
  and streams its new result; the panel says so before the export, because the
  order and the values can differ and a statement with side effects will have
  them again
- Gave every result grid a row gutter, so rows can be selected, copied, and
  taken out of any of them, and kept the column headings fixed at the top of a
  scrolled result
- Closed the Transaction a Scratchpad held when the Scratchpad itself is closed
- Fixed Scratchpad icons drawing as empty boxes
- Fixed query composition dropping the quotes of a table when the relation
  joined to it is removed, and resolved quoted relation names against the
  catalog

### Commands and menus

- Renamed the six commands that still carried the former domain term:
  `postgresql-workbench.addServer`, `removeServer`, `connectServer`,
  `disconnectServer`, `editServer` and `renameServer` become `addConnection`,
  `removeConnection`, `connectConnection`, `disconnectConnection`,
  `editConnection` and `renameConnection`. Update custom keybindings, tasks or
  `command:` links that referenced the old identifiers. Saved Connections,
  their passwords and their per-workspace open state are untouched: the
  storage keys are deliberately unchanged
- Filed every command under one category root, `PostgreSQL Workbench`. The
  palette printed six families of prefix — `PL/pgSQL:`, `PL/pgSQL Results:`,
  `PostgreSQL Workbench:` and three sub-scopes — for one extension, and one
  command carried no prefix at all, reading like a command of VS Code's own
- Took every prefix out of the titles it was written into. The palette prints
  `category: title`, a menu prints the title alone, so a right-click in a SQL
  file offered `PostgreSQL Workbench: Execute SQL Selection` in full
- Made four Scratchpad commands ask which Scratchpad they are about. Asked for
  from the palette with none open, **Association...**, **Reconnect**,
  **Connect** and **Statement Timeout...** returned in silence, which reads
  exactly like a command that is broken. They now offer the workspace's
  Scratchpads to choose from, which is what Open, Rename, Delete, Duplicate and
  Export have always done
- Offered in the context menu every action a tree row already offered on hover:
  **Debug** on a debuggable routine, **Open Definition** on any indexed object,
  and **Connect** / **Disconnect** on a Connection. Getting Started promised
  "Right-click a function → Debug", and only the hover icon delivered it
- Gave a Connection's menu a defined order — Edit, Rename, Change Password —
  and moved Remove behind a separator of its own, instead of leaving four
  entries to sort themselves
- Fixed Getting Started naming `plpgsql` as the `launch.json` configuration
  type, which resolves nothing; it is `postgresql-workbench`. Fixed the same
  walkthrough asking the reader to drag from **Sources**, a tree node renamed
  **Schemas**
- Renamed the results panel **PostgreSQL Results**: it holds the results of a
  SQL selection and of a Scratchpad as well as those of a debug session
- Declared the license as `MIT`, which is what the LICENSE file has always been
- Removed a compatibility surface nothing was compatible with: five deprecated
  `ConnectionManager` aliases, `bindingSnapshot`, `bindingFingerprint` and
  `resolveNotebookBinding` — whose one returned field had just been renamed —
  and a `postgresql-workbench.debugAvailable` context key set on every
  Connection change and read by nothing

### Documentation

- Added the [Data View guide](https://ng-galien.github.io/postgresql-workbench/docs/data-view.html)

## [1.3.0] - 2026-08-18

PostgreSQL Workbench 1.3.0 makes every Workbench operation exact to its
Connection. Several PostgreSQL Connections can be open at once, each with its own
index, Schema Sync listener, Scratchpad Associations, coverage and debugging
state, replacing the previous single active connection.

- Kept every open Connection connected and indexed independently: the TreeView,
  search, Cockpit, Scratchpads, SQL authoring, pgTAP coverage and the debugger
  resolve their Connection explicitly instead of a global active Connection
- Queued index runs per Connection and database so one Connection never waits
  behind another; automatic refreshes now report their phases and can be
  cancelled for their exact Connection
- Fixed the PL/pgSQL debug launch that aborted when several Connections were
  open and no Association was recorded
- Stopped Schema Sync from falling back to a full rebuild after debugger
  capability probes, and skipped the duplicate full re-index after Scratchpad
  DDL when Schema Sync already listens on that Connection
- Judged Cockpit, relation and source-preview snapshot currency per Connection,
  so indexing another Connection no longer invalidates an unrelated graph
- Attributed each debug result to the Connection that produced it
- Renamed the command `postgresql-workbench.useSqlNotebookBindingAsActive` to
  `postgresql-workbench.connectSqlNotebookAssociation` ("Connect Scratchpad
  Association"); update custom keybindings that referenced the old identifier

## [1.2.1] - 2026-08-18

PostgreSQL Workbench 1.2.1 adopts the published Code Moniker 0.7.1 runtime and
consolidates the performance and CI work validated against it.

- Updated the packaged Code Moniker client and native runtimes to 0.7.1,
  enabling parallel bulk SourceSet extraction, exact incremental publication,
  and client-selected SQL syntax budgets without a server clamp
- Added a reproducible synthetic ERP catalog benchmark and generated-site guide
  with real medium and large indexing measurements and explicit producer versus
  Workbench consumer costs
- Stabilized the Coverage-to-Debug Playwright journey by reusing the already
  active routine editor instead of re-entering a virtualized TreeView after the
  second coverage run
- Consolidated demo, integration, and benchmark PostgreSQL fixtures on one
  pinned debugger image augmented once with pgTAP

## [1.2.0] - 2026-08-17

PostgreSQL Workbench 1.2.0 adds indexed SQL authoring and unifies Run, Debug,
and Deploy workflows across free SQL documents, Scratchpads, and managed
PostgreSQL sources.

### Indexed SQL authoring

- Added one VS Code Language Server Protocol service for PostgreSQL formatting,
  indexed completion, semantic highlighting, hover, navigation, and safe query
  composition
- Added persistent Document Associations for free `.sql` and `.pgsql` files;
  completion, composition, Run, and Debug now use one explicit saved Connection
  without silently following the active DatabaseContext
- Added language-status feedback for missing Associations, missing or stale
  indexes, syntax errors, and configurable syntax-analysis budgets
- Added Shift-drag SQL composition for tables, views, columns, functions,
  procedures, trigger functions, and triggers, with editable generated harnesses
- Added configurable relation aliases, explicit projections, PostgreSQL-aware
  quoting and folding, and duplicate-safe column insertion
- Added foreign-key-backed `JOIN` and `LEFT JOIN` generation that preserves
  nullable rows, distinguishes self-joins, asks the user to choose between
  ambiguous relationships, and falls back to an independent `SELECT` instead
  of guessing
- Kept composition Statement-scoped and conservative for CTEs, nested queries,
  aggregate and set-sensitive projections, incomplete constraints, and stale
  snapshots

### Run, Debug, and Deploy

- Added Statement-level **Run SQL** and eligible **Debug PL/pgSQL** CodeLens
  actions to free SQL documents, both governed by the Document Association
- Added Scratchpad Run/Debug intent for replayable function, procedure, and
  trigger entry points; Debug results remain in the cell and native Stop ends
  the debug session
- Added generated `SELECT`, `CALL`/`DO`, and DML trigger harnesses with typed,
  editable routine arguments
- Added safe managed-routine working copies and explicit Deploy for exact
  PL/pgSQL function or procedure replacements, including signature validation,
  conflict detection, post-deployment index refresh, and concise user feedback
- Kept managed tables, views, schemas, triggers, arbitrary DDL, and DML outside
  implicit synchronization; they remain explicit SQL operations
- Closed native coverage before every admitted debug launch and stabilized
  recursive stack inspection, frame selection, source reveal, and breakpoint
  placement

### Scratchpads and Workbench reliability

- Split Scratchpads into a dedicated, resizable and filterable TreeView below
  Sources, with deterministic automatic Association for a single Connection and
  an explicit selector when several Connections exist
- Added persisted Scratchpad Statement-timeout overrides, actionable timeout
  recovery, native cancellation through `pg_cancel_backend`, and safe shutdown
  rollback for active manual Transactions
- Serialized schema-synchronization listener lifecycle and DDL refreshes,
  preserved full-refresh debt across disconnects and races, and prevented stale
  catalog snapshots from being reported as fresh
- Added deterministic Linux Playwright lanes for bootstrap, core journeys, and
  terminal Schema Sync; hardened VS Code window, TreeView, Notebook, Quick Pick,
  drag-and-drop, coverage, and debugger helpers
- Pinned reproducible Linux acceptance images and expanded packaging checks for
  the SQL authoring server and bundled Code Moniker runtime
- Fixed the demo Fibonacci routine so `NULL` remains valid without bypassing the
  executable body used by PL/pgSQL debugging

## [1.1.0] - 2026-08-13

PostgreSQL Workbench 1.1.0 expands Cockpit and SQL scratchpad workflows and
hardens recursive PL/pgSQL debugging across local and CI execution paths.

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
- Added separate Playwright scenarios for graph interactions, SQL notebooks, and
  stale virtual-source cleanup; the notebook scenario verifies VS Code cell
  kinds through the public API, renders Markdown, executes single and
  multi-statement queries, checks silent statements, and inspects result and
  error renderers
- Made the first TreeView-to-graph drop wait for VS Code's accepted resource
  target, reject unavailable graph state explicitly, and always close the
  synthetic bridge editor instead of leaving a broken tab
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
- Fixed recursive stack inspection so argument and local-variable scopes select
  the frame requested by the DAP client instead of reusing PostgreSQL's current
  frame
- Made stack-frame and variable handles unique across recursive suspensions and
  serialized frame selection with variable inspection; each suspended frame now
  serves one immutable variable snapshot to Arguments, Locals, watches, and
  inline values instead of repeatedly stressing the pldebugger proxy
- Kept **Continue** from surfacing residual copies of the exact temporary entry
  stop after it is released, without hiding other unregistered suspensions;
  Step Over, Step Into, and Step Out still execute exactly one user step command
- Used the actually suspended PostgreSQL stack frame, rather than the differing
  `pldbg_continue()` tuple, to identify breakpoints and residual entry stops
- Normalized DAP client line bases at the protocol boundary so VS Code's
  zero-based editor breakpoints map to PostgreSQL's one-based source lines
- Restored watch evaluation without an explicit stack selection by treating DAP
  frame ID `0` as the current PostgreSQL frame
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

- Added a unified Connection tree organized by Connection and database context,
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
  the selected Connection remains visible beside the call
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
- Registered Connections appear as dynamic configurations in "Run and Debug" —
  no launch.json needed; the SQL statement is prompted at launch
- Launched sessions are persisted to `.vscode/launch.json` for F5 replay
- Cancelled or failed launches show a clear warning instead of failing silently
- Connection progress is cancellable
- Status bar distinguishes "connection lost" (warning color) from
  "no connection"; welcome view with prerequisites shown on first open
- Re-adding an existing Connection offers to connect; Connection removal asks for
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
