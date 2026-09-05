---
title: Standalone MCP server
description: Give agents access to Workbench sessions, captured results, PL/pgSQL debugging, native coverage, and structural observations without VS Code.
eyebrow: Agent integration
---

# Standalone MCP server

The Workbench MCP server runs independently of VS Code. It exposes engine-owned
database sessions, scratchpads, execution evidence, PL/pgSQL debugging, native
coverage, and structural catalog observations. Reading a captured result never
re-executes its SQL.

The extension includes a managed local server, and the standalone launcher is
available from a source checkout (not yet a published npm package). It uses the
[official MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/server)
and its stdio or Streamable HTTP transport. No OpenAI account, API key, or particular model is required.

## Manage MCP from Settings

Open **Connections → Settings → MCP** in a trusted workspace containing one
local project folder. Choose the saved PostgreSQL Connection that agents may
access, then **Start MCP server**. The page shows the process state, PID,
Connection, and loopback URL. **Stop MCP server** closes its sessions and
discards retained observations. Stop it before changing the port (default 7432).
A port conflict is reported without stopping the process that already owns it.
Saved Connection edits apply on the next start.

The server runs in a separate process on the extension host machine. It receives
the selected Connection and its secret through a private parent channel, using
the same TLS and connection tuning as Workbench. It never borrows an editor
session. It stops when its VS Code window closes; the standalone launcher below
can run without VS Code.

**Install / update Codex** writes `.codex/config.toml` in the project;
**Install / update Claude Code** writes `.mcp.json`. Other server entries are
preserved. These files contain a private local bearer token, never the database
password. Workbench excludes them through Git's local exclude file and refuses
to modify a tracked configuration. Keep them private in projects without Git.
Existing Workbench entries managed elsewhere are not overwritten.

The page reports absent, installed, different, invalid, or locally disabled
Codex configuration. After changing the port, update each integration. It does
not claim that a running agent has connected or inspect global client policies.
Restart or reconnect the client and approve its project server: see the official
[Codex MCP guide](https://developers.openai.com/codex/mcp) and
[Claude Code MCP guide](https://code.claude.com/docs/en/mcp).
Local clients must run on the same machine as the server; this loopback endpoint
does not provide access to a hosted cloud agent.

## Start the server

Use Node.js 24 or later. From the repository root:

```bash
npm ci
npm run build:mcp
```

Configure your MCP client to launch `node` with the absolute path to
`dist/mcp/server.cjs`. Pass `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and the
secret `PGPASSWORD` through the launcher's environment. Database and user must
be explicit. Host defaults to `localhost`, port to `5432`. For an interactive
launch with those variables already set, use `npm run --silent mcp`.

Use the direct Node command in MCP configuration: stdout is reserved for MCP
messages. Keep credentials in the client's secret/environment configuration,
outside repository files and tool arguments.

For multiple endpoints, set `PGWB_MCP_PROFILES` to a JSON array of profiles:

```json
[
  {
    "id": "development",
    "host": "localhost",
    "port": 5432,
    "database": "development",
    "user": "developer",
    "passwordEnv": "DEVELOPMENT_DB_PASSWORD",
    "ssl": false
  }
]
```

Set the referenced password variable separately. `ssl: true` enables TLS with
certificate verification. Inline passwords, unknown profile fields, and
duplicate profile IDs are rejected. Without custom profiles, the PostgreSQL
environment variables define a profile named `default`.

For a standalone HTTP server, additionally set `PGWB_MCP_PORT` and a private
`PGWB_MCP_TOKEN` of at least 32 characters in the environment, then launch the
same Node entry point. Connect to `http://127.0.0.1:<port>/mcp` with
`Authorization: Bearer <token>`. Only loopback requests with the exact Host and
no browser Origin are accepted. Each HTTP client owns a separate runtime; up to
16 client sessions can coexist. Clients should terminate their MCP session when
finished. After 30 minutes without a request, a client runtime expires and its
database sessions and observations are released. An executing request prevents
expiration; an idle SSE stream does not. Restarting the service clears all sessions
and observations.

## Tool surface

| Capability | Tools | Result |
| --- | --- | --- |
| Context and connections | `workbench_context`, `session_open`, `session_close` | Configured profile IDs and independent sessions with database, opening role, backend PID, state and opening time. |
| Scratchpads | `scratchpad_put`, `scratchpad_read`, `scratchpad_execute` | In-memory cells with an explicit session association and increasing revision. Execution requires the exact revision and zero-based cell index. |
| Evidence | `observation_read`, `observation_forget` | Immutable captures, readable after editing a scratchpad or closing its session. Forgetting is explicit. |
| Debugging | `debug_start`, `debug_inspect`, `debug_step`, `debug_breakpoint`, `debug_close` | A dedicated PL/pgSQL target, stack, variables, source definitions and captured completion. |
| Tests and coverage | `tests_discover`, `coverage_run` | pgTAP test discovery, source routine associations and retained native coverage reports. |
| Catalog | `catalog_refresh` | Workbench virtual DDL sources, foreign keys, view dependencies and structural differences from the previous refresh. |

Tools return structured content under `data`. A database execution failure is
a retained observation whose data has `status: "failed"`; inspect it even when
the MCP call itself succeeded. Invalid IDs, stale revisions and unavailable
capabilities return MCP tool errors.

`openedAsRole` records the role when a session opened, not the effective role
after `SET ROLE`. Workbench does not inject a role probe before each statement:
such a query would interfere with transaction setup. Execute `SELECT current_user`
as its own cell when you need an observation of the effective role.

## Explain an execution without repeating it

1. Call `workbench_context`, then `session_open` with a returned profile ID.
2. Call `scratchpad_put` with the returned session ID and SQL cells.
3. Call `scratchpad_execute` with the scratchpad ID, its revision and cell index.
4. Inspect the returned observation: it contains the executed SQL, source cell,
   revision, session context, timestamp and bounded result or SQL error.
5. Read it again through `observation_read`, even after changing the scratchpad.

`observation_read` returns chunks of the observation's serialized JSON. Start
at offset zero, append each `text` chunk and follow `nextOffset` until it is
null. Offsets count UTF-16 code units; use the returned offset rather than
computing byte lengths. Parse the concatenated text to recover the observation.
Catalog and coverage tools return an observation ID rather than a potentially
large report; retrieve those reports through the same reader.

## Debugging and coverage

Debugging requires `pldbgapi` and the server's debugger preload. Supply an exact
routine OID and SQL that invokes it. The initial breakpoint is scoped to the
dedicated target backend, so another client calling the same routine is not
captured. Use the returned `debugId` to inspect, step, set line breakpoints or
close the run. Closing disconnects the target; it does not undo committed work.

Coverage requires pgTAP, PL/pgSQL routines owned by the connected role, and the
published native Code Moniker runtime installed with the repository dependencies.
Use `tests_discover` to obtain runnable test OIDs and source associations, then
pass explicit `routineOids` and `testOids` to `coverage_run`. Workbench's coverage
runner instruments routines on a dedicated connection and rolls the transaction
back. Reports retain the analyzed sources and their hashes. PostgreSQL sequences
and external effects of test routines are not generally transactional.

## Ownership and limits

- Each MCP process owns its sessions, scratchpads and observations. Restarting it
  discards them. It does not attach to existing VS Code or browser sessions,
  read editor selections, or observe unsaved buffers from another surface.
- Scratchpad cells use the same session backend, including temporary tables and
  explicit transactions. Debugging and coverage use dedicated backends and do
  not inherit scratchpad transaction state or temporary objects.
- Each scratchpad execution and debug target accepts one SQL statement.
  PostgreSQL's extended-query protocol rejects multiple statements before any
  of them run. Put separate statements in separate cells; semicolons inside a
  function body remain part of that one statement.
- IDs never fall back to another session. Concurrent operations on one session
  are rejected as busy; independent sessions can run concurrently.
- Up to 32 sessions and 100 scratchpads are retained per process. Scratchpads
  contain at most 20 cells, with 100,000 characters per cell.
- Evidence storage is limited to 64 MiB. Observations are not silently evicted;
  use `observation_forget` to release capacity. Execution reserves space before
  submitting SQL.
- Query captures retain at most 200 rows and 256 KiB of result payload. Workbench
  still consumes the complete query; truncation is explicitly reported.
- Ordinary PostgreSQL clients start with a 30-second statement timeout. Coverage
  has a 30-second run deadline. Debug listeners have no statement timeout;
  start/step waits have a 15-second deadline and runs close after five minutes.
- Catalog refresh is explicit and read-only. It compares structural DDL, not
  row contents. This surface does not provision event triggers, run automatic
  DDL listeners or expose the full Code Moniker indexed call graph.

The reusable owner is `packages/runtime`; `packages/mcp` adapts it to MCP.
Neither package imports the VS Code extension, editor, views or browser shell.

## Validate from a checkout

```bash
npm run test:e2e:up
npm run test:mcp
npm run test:e2e:down
```

The Playwright journeys drive an actual MCP client and the standalone stdio
process against the repository PostgreSQL fixture. They require neither a
browser nor VS Code. The runner obtains disposable fixture credentials from
Docker Compose and passes them through the child environment.
