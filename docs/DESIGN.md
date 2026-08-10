# PostgreSQL Workbench — Design and Roadmap

This document is the source of truth for the product and its technical invariants.
It describes the current state and the next two milestones, not a long-term idea list.

## Product

The project provides a standalone Debug Adapter Protocol server for PL/pgSQL and a
reference VS Code extension. Its goal is to make PostgreSQL debugging reliable and
accessible outside a proprietary IDE.

The debugger targets local, Docker, or self-hosted development databases. It requires
`pldebugger`, `plugin_debugger` in `shared_preload_libraries`, and the `pldbgapi`
extension. Managed PostgreSQL services that prohibit these extensions cannot host a
debug session.

The project is not intended to become a general-purpose SQL client. Its product
direction is the development lifecycle for code executed inside PostgreSQL: validate,
deploy, test, and debug a version-controlled routine.

### Virtual Source URI Contract

- A PostgreSQL symbol is represented on every product surface by the exact
  `CodeMonikerSymbol.uri` returned by Code Moniker. The extension does not parse or
  rebuild that URI. Callable signatures in the canonical URI distinguish overloads.
- Code Moniker's `file` value is a source location, not symbolic identity. A separate
  source descriptor associates the canonical URI with the PostgreSQL server, database,
  schema, object kind, deployment OID, source revision, and Code Moniker generation.
- PostgreSQL OIDs are deployment lookup data only. The DAP receives an explicit
  OID-to-canonical-URI registry and emits the canonical URI unchanged as `Source.path`.
  Server routing is resolved through the source descriptor, never a URI query parameter.
- Inline values do not depend on VS Code's internal variable resolution. The provider
  queries the active session, using the `frameId` supplied by the context or the top
  frame otherwise, and emits resolved `InlineValueText` values. It falls back to
  `InlineValueVariableLookup` when no session exists.
- Validated display rule: **current** values are shown for every visible occurrence,
  including occurrences below the stopped line. Parameters are also shown on the
  routine signature line, so their values are visible from entry as in IntelliJ. The
  execution pointer follows the standard convention and marks the next line to run.

### Code Authority

- A canonical `code+moniker://` document represents the function currently stored in
  the database. Saving it redeploys that definition through its source descriptor.
- In the future Workbench mode, the version-controlled repository file will be
  authoritative. The database will be an explicit target and will never be modified
  silently from a snapshot.

## Current Architecture

```text
DAP client ──stdio──> PlpgsqlDebugSession
                           │
                    PostgresDebugger
                      ┌────┴────┐
                      │         │
                  listener    target
                      └──── PostgreSQL + pldbgapi
```

| Component | Responsibility |
|---|---|
| `src/debugger/index.ts` | Public DAP server surface |
| `src/debugger/launch/index.ts` | Launch contract shared with clients |
| `src/debugger/postgres/index.ts` | PostgreSQL facade and pldbgapi commands |
| `src/callParser.ts` | SQL call and definition analysis |
| `src/functionSource.ts` | PL/pgSQL body AST analysis |
| `vscode-extension/` | VS Code connections, navigation, editing, and user experience |

SQL and PL/pgSQL analysis consumes syntax trees from the local Code Moniker runtime.
Feature-specific visitors remain in the Workbench and no parser is bundled in the
extension. The debugger works with standard pldebugger; the `ng-galien/pldebugger`
fork only improves some complex-type fallbacks.

## Delivered Capabilities

### DAP Server

- Launch a function or procedure from a SQL call or structured target.
- Step over, step into, continue, inspect the call stack, and expose virtual sources.
- Line, function, and conditional breakpoints, plus logpoints.
- Expandable arguments, local variables, records, arrays, and JSON values.
- Watches for variables, `record.field`, and `array[index]`.
- Variable updates through `pldbg_deposit_value`.
- SQL REPL and completion in the Debug Console.
- `RAISE NOTICE/WARNING/INFO` forwarding.
- Best-effort exception-handler detection.
- Bounded attach timeout and session cleanup.

### VS Code Extension

- Connection manager with passwords stored in SecretStorage.
- Guided pldebugger requirement diagnostics.
- Server → schema → function and procedure explorer.
- CodeLens actions on definitions and replayable SQL calls.
- Editable canonical Code Moniker documents with persistent breakpoints.
- Semantic highlighting and inline values.
- Dynamic configurations with optional persistence to `launch.json`.
- `plpgsql_check` diagnostics when the PostgreSQL extension is available.

## Technical Invariants

### DAP Ordering

- `InitializedEvent` is sent from `initializeRequest`.
- `launchRequest` responds before the target's blocking wait begins.
- `configurationDoneRequest` waits for the target to reach the global breakpoint.
- Breakpoints received before `launch` are retained and replayed when the listener
  exists. Their updated state is published through `BreakpointEvent`.

### Connections and Lifecycle

- A session uses two connections: the listener drives pldbgapi, while the target
  executes the user's SQL.
- The DAP lifecycle follows explicit states: `idle → preparing → waitingForTarget →
  suspended ↔ resuming → terminating → terminated/failed`.
- Only one execution command (`continue`, `next`, `stepIn`, or `stepOut`) may be in
  flight because the corresponding pldbgapi calls block until the next stop.
- `stopOnEntry` alone determines whether the entry stop is published (`true`, the
  default) or the session intentionally resumes to the next breakpoint (`false`).
- Local breakpoints are reconciled with the target. Reapplying an existing breakpoint
  retains and verifies it instead of attempting to create it again.
- Never set `statement_timeout` on the listener because pldbgapi commands block by
  design.
- Every session has unique `application_name` values and PIDs. It terminates only its
  own backends.
- If another session already owns a routine's global breakpoint, launch fails without
  interrupting the active session.
- A blocked listener is interrupted through an auxiliary connection; `abort()` is
  never queued behind a blocking query.
- Termination and cleanup are idempotent: a session emits at most one
  `TerminatedEvent`.
- If the SQL completes without reaching the entry point, its result is still
  published, then the session fails immediately with a diagnostic. `attachTimeoutMs`
  remains the safety net for a query that is still running.

### Data and Security

- Generated SQL identifiers are escaped, and structured arguments are bound.
- Passwords are never written to `launch.json`.
- Complex-type resolution uses two passes and falls back to the raw value if JSON
  conversion fails.

## Current Limitations

- `stepOut` still approximates the operation with `continue`.
- A dedicated `terminateRequest`, separate from `disconnectRequest`, is not
  implemented.
- pldbgapi exposes no native exception event, so uncaught exceptions cannot always
  produce a stop.
- `plpgsql_check` operates on a routine that already exists in the database.
- No project model currently maps a repository file to a database object.

## Quality Requirements

Before release:

```bash
npm run check
npm run typecheck
npm test
npm run test:e2e
npm run build
```

The end-to-end tests use a real PostgreSQL instance with pldbgapi. They cover DAP
ordering, stepping, complex variables, early breakpoints, concurrent sessions, and
cleanup.

## Roadmap

### +1 — Ship the Debugger

Goal: publish a reliable installable release without widening the scope.

- Implement real `stepOut` and `terminateRequest` behavior.
- Build and test the VSIX.
- Publish to VS Code Marketplace and then Open VSX.
- Keep tests and packaging as release criteria.

The milestone is complete when a user can install the extension, connect a compatible
database, launch a debug session, and finish it without a manual recovery procedure.

### +2 — First Workbench Vertical

Goal: manage a version-controlled routine end to end from its local file.

- Minimal project configuration: SQL root and target environment, without secrets.
- Stable routine identity: schema, name, and argument types.
- Association between a local file and a PostgreSQL routine.
- Status and diff between the repository and the database.
- Validation with `plpgsql_check`.
- Explicit deployment with a preview.
- Execution of a pgTAP test when one exists.
- Debugger launch against the deployed routine.

In this mode, the repository is authoritative. A database change never overwrites a
local file without an explicit action.

The following are outside these two milestones: a general-purpose SQL client,
full-schema synchronization, a migration engine, notebooks, profiling, time travel,
and an AI assistant. These topics will be planned only after validating the Workbench
vertical.

## Documentation Policy

- `README.md`: repository overview and development commands.
- `vscode-extension/README.md`: extension user documentation.
- `docs/DESIGN.md`: technical contract, limitations, and +1/+2 roadmap.
- `AGENTS.md`: operational instructions for development agents.
- `vscode-extension/CHANGELOG.md`: changes grouped by published version.

Point-in-time audits are not retained as permanent documentation. Their findings
become tests, issues, or updates to this document.
