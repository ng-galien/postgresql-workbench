# CLAUDE.md

## Project Overview

PL/pgSQL Debug Adapter Protocol (DAP) server — a standalone TypeScript implementation ported from the IntelliJ plugin [idea-plpgdebugger](https://github.com/ng-galien/idea-plpgdebugger).

The original plugin (Kotlin/JVM) integrates with IntelliJ's XDebugger framework. This project extracts the core debugging logic into a language-agnostic DAP server that can be consumed by any DAP client (VS Code, Neovim, Emacs, etc.).

Ported from [idea-plpgdebugger](https://github.com/ng-galien/idea-plpgdebugger) (Kotlin/JVM): PostgreSQL debugger commands with 2-pass variable resolution, call and function-source analysis through Code Moniker syntax trees, and the DAP session.

### pldebugger compatibility

Works with **any** pldebugger (EDB standard, Debian/RPM packages, or the [ng-galien fork](https://github.com/ng-galien/pldebugger)). The 2-pass variable resolution does JSON conversion in SQL (`to_json`/`to_jsonb` via UNION ALL), not in the C extension. The fork's `print-vars` branch improves fallback for exotic types.

## Build Commands

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Watch mode
npm run watch

# Run the DAP server (stdio)
npm start

# Lint + format (biome replaces eslint + prettier)
npm run check
npm run check:fix

# Run unit tests (27 tests — callParser + functionSource + sqlCodeLens)
npm test

# Package VS Code extension (.vsix)
npm run package:ext

# Run e2e tests (requires Docker)
npm run test:e2e        # Full cycle: up + run + down
npm run test:e2e:up     # Start PostgreSQL container
npm run test:e2e:run    # Run e2e tests
npm run test:e2e:down   # Stop and cleanup
npm run test:e2e:legacy # DAP compatibility with unpatched EnterpriseDB v1.9
```

## Architecture

```
packages/              # The engine, one package per subject; boundaries enforced by code-moniker
  sql/                 # Code Moniker syntax boundary, SQL and PL/pgSQL analysis, language server
    analysis/           # The only syntax provider; every feature receives its SyntaxParser
    callParser.ts       # SQL calls and definitions from Code Moniker syntax trees
    functionSource.ts   # PL/pgSQL variables, lines, exceptions, and calls from syntax trees
    text/ query/        # Vocabulary, positions, literals; query composition and join planning
    languageServer/     # Completion, semantic tokens, diagnostics — the front door
  catalog/             # PostgreSQL catalog projection, DDL sync, Cockpit graph
  rows/                # Reading and editing relation rows: editability, edits, Data View engine
  views/               # The React views: result grid, Data View, Cockpit, debug results
  coverage/            # pgTAP coverage analysis and instrumentation
  dap/                 # @ng-galien/postgresql-dap — its own version and release tag
    main.ts             # Entry point — runs DAP session over stdio
    debugger/           # Public DAP surface, launch contract, pldbgapi backend, session
  shell/               # Browser harness driving the views against PostgreSQL without VS Code

e2e/
  init/                # SQL init scripts (extension + test functions)
  e2e.test.ts          # Integration tests against real PostgreSQL
  dap-client.test.ts   # DAP protocol tests over stdio, without VS Code

scripts/               # Every script, one directory per purpose
  dap/ extension/      # Build and package the DAP npm package and the VSIX
  test/                # Run the suites: e2e, VS Code, Playwright, and their build steps
  site/ issues/        # The documentation site and the GitHub issue workflow
  benchmark/ marketplace/

docker/                # Every container definition, one directory per fixture
  postgres/            # The canonical image: pldbgapi + pgTAP, shared by the others
  demo/ e2e/ legacy/   # The databases: demo (5434), integration (5433), unpatched pldebugger (5435)
  acceptance/          # The Playwright CI image and its database
  benchmark/           # The Workbench Index benchmark database

vscode-extension/      # VS Code extension (full-featured, see below)
```

### Debug Flow

1. Client sends `launch` request with PostgreSQL connection info and SQL call
2. `callParser.parseCall()` parses the SQL to extract schema/routine/args
3. `PostgresDebugger` creates listener session via `pldbg_create_listener()`
4. Sets global breakpoint on target function OID
5. Target SQL executed on separate connection in background
6. `PostgresDebugger.waitForTarget()` blocks until breakpoint hit
7. Step commands (`stepOver`, `stepInto`, `stepContinue`) drive execution
8. Stack frames, variables, and breakpoints reported back via DAP events

### DAP Protocol Ordering (critical)

- `InitializedEvent` MUST be sent from `initializeRequest`, not `launchRequest` — VS Code sends `setBreakpoints` and `configurationDone` only after receiving it
- `launchRequest` MUST return (sendResponse) BEFORE `waitForTarget()` — otherwise `configurationDone` is never sent and the session deadlocks
- `waitForTarget()` runs asynchronously via `targetReady` Promise, resolved when the target hits the global breakpoint
- `configurationDoneRequest` awaits `targetReady` before deciding stop-on-entry vs continue
- Guard `if (!this.listenerExecutor)` in `setBreakPointsRequest` — VS Code may send breakpoints before launch completes
- `resolveDebugConfiguration` must pass through configs with inline `host`+`password` (for tests and launch.json) without requiring ConnectionManager

### Key Technical Details

- NEVER set `statement_timeout` on the listener connection — `waitForTarget()` and `pldbg_continue()` block by design and will be killed
- Code Moniker is the only SQL and PL/pgSQL syntax provider. Feature modules receive the shared `SyntaxParser` contract and must never start their own daemon or import another parser.
- Step commands catch errors gracefully when function execution finishes (pldbgapi throws "select() failed waiting for target").
- Variable resolution UNION ALL query uses explicit column aliases (`AS name`, etc.) — positional `Object.values()` is unreliable with PostgreSQL.
- E2e tests use port 5433 to avoid conflicts with local PostgreSQL.

## Dependencies

- **@vscode/debugadapter** + **@vscode/debugprotocol** — DAP protocol implementation + types
- **pg** — PostgreSQL client for Node.js
- **vitest** — Test framework

## VS Code Extension

The `vscode-extension/` is a full-featured VS Code extension:
- ConnectionManager (Connections, secrets, auto-reconnect, SQLTools/pgsql import)
- TreeView (Connections → schemas → functions), CodeLens ("Debug" on CREATE/SELECT/CALL)
- FileSystemProvider for exact canonical `code+moniker://` symbol URIs (breakpoints on virtual source)
- Semantic tokens (variables, params, types, dollar quoting)
- Inline values during debug, RAISE NOTICE → Debug Console
- esbuild bundles extension.ts and the extension-specific dapServer.ts entry; the latter reuses the shared stdio DAP host without importing the standalone CLI entry
- Imports from ../packages/ work via esbuild (not tsc rootDir — removed)
- The extension adapts the engine to VS Code and holds nothing else; the views name their
  colours `--postgres-*` and `webviewPage.ts` says what those names are worth

## Testing

### DAP protocol tests (`e2e/dap-client.test.ts`)
- Uses `@vscode/debugadapter-testsupport` `DebugClient` — talks directly to DAP server via stdio, no VS Code needed
- Pattern: `Promise.all([dc.launch(args), dc.configurationSequence(), dc.waitForEvent("stopped")])` — all three must run concurrently
- `waitForEvent` must be registered BEFORE the action that triggers the event (or in `Promise.all` with it)
- Multi-step sequences suffer from orphaned pldbgapi sessions between tests — `dc.stop()` doesn't fully clean up

### Legacy pldebugger compatibility (`e2e/legacy-compat.test.ts`)
- Builds the unpatched EnterpriseDB v1.9 source at pinned commit `ff0db43` on PostgreSQL 17
- Upstream omits `PLPGSQL_DTYPE_REC`, `ROW`, and `RECFIELD`; this is supported degradation, not a failure
- The contract requires scalar inspection and stepping to remain functional and unsupported composites to return cleanly without DAP errors

### Where the tests live

Unit tests sit next to the code they cover, in `packages/**` and `vscode-extension/src/**`, and run
under vitest. Everything that needs more than a module lives in one place per runner:

- `e2e/` — vitest against a real PostgreSQL (Docker) or a real Code Moniker parser
- `vscode-extension/tests/vscode/` — `@vscode/test-cli` inside a real VS Code: `integration/` (the
  suite) and `smoke/` (activation only), each with its runner config beside it
- `vscode-extension/tests/acceptance/` — Playwright driving VS Code; `playwright/` holds the lane
  configs, `specs/` the journeys, and the CI image sits with them
- `vscode-extension/tests/workspace/` — the workspace both VS Code runners open

Mocha TDD UI in the `tests/vscode/` suites (`suite`/`test`/`suiteSetup`/`teardown`, NOT
`describe`/`it`). `vscode.debug.startDebugging()` returns false if `resolveDebugConfiguration`
returns undefined.

## Important Notes

- Biome enforces: template literals over concat, `Number.isNaN` over `isNaN`, no assignment in expressions, no `void` in union types (use `biome-ignore` for VS Code's `EventEmitter<T | undefined | void>`)
- PostgreSQL server must have `pldbgapi` extension and `shared_preload_libraries = 'plugin_debugger'`
- Works with standard EDB pldebugger — the ng-galien fork is optional (better composite type fallback)
- Biome for lint+format, Lefthook for pre-commit (biome fix → typecheck DAP + extension in parallel)
- `npm run check:architecture` checks the package boundaries (code-moniker architecture profile) and
  runs in CI as the `Architecture` job — a boundary is not a convention here, it is a gate
- Node.js 24+ required
