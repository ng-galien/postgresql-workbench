---
title: Standalone DAP server
description: Use the PL/pgSQL debugger from another editor or DAP client.
eyebrow: Editor-independent core
---

# A PL/pgSQL debugger that speaks standard DAP over stdio.

The TypeScript debug adapter is separate from the VS Code user interface. Any
editor or client capable of launching a stdio Debug Adapter Protocol server can
integrate it.

The implementation has three explicit layers:

- the shared DAP library contains the protocol session, PostgreSQL debugger,
  and source-routing contracts;
- the standalone `@ng-galien/postgresql-dap` executable is one stdio host over
  that library;
- PostgreSQL Workbench compiles a separate VS Code adapter entry over the same
  library and does not import the standalone CLI entry.

This keeps debugger behavior shared without forcing the extension to consume a
separately published DAP artifact or the standalone executable lifecycle.

{{dap-flow}}

## Distribution

The standalone server is packaged independently from the VS Code extension as
`@ng-galien/postgresql-dap`. After the first npm release, run it with:

```bash
npx @ng-galien/postgresql-dap
```

`@code-moniker/client` installs and selects the matching native syntax runtime
for macOS ARM64/x64, Linux x64, or Windows x64. Normal standalone use does not
require a separate Code Moniker installation or runtime path.

The adapter calls that runtime only through a lazy, private MCP stdio worker for
stateless SQL and PL/pgSQL parsing. It does not attach to a workspace daemon or
index the user's project. Symbol search, graph, usages, navigation, source-set
publication, PostgreSQL catalog projection, and DDL synchronization are
Workbench capabilities and are outside the standalone DAP contract.

Verify the installed runtime without starting a DAP session:

```bash
npx @ng-galien/postgresql-dap --check-code-moniker
```

## Launch contract

The client sends an ordinary DAP `launch` request containing PostgreSQL
connection information and either a replayable SQL call or a structured target.
The adapter resolves the routine, creates the pldbgapi listener, runs target SQL
on a second connection, and reports standard stack, scope, variable, breakpoint,
output, and termination events.

```json
{
  "type": "postgresql-workbench",
  "request": "launch",
  "name": "Debug shop.place_order",
  "host": "127.0.0.1",
  "port": 5432,
  "database": "demo",
  "user": "postgres",
  "password": "...",
  "sql": "SELECT shop.place_order(1, 2, 1)",
  "stopOnEntry": true
}
```

> The standalone protocol needs connection credentials from its DAP client.
> The VS Code extension instead resolves saved servers and keeps passwords in
> SecretStorage.

## Capabilities

- Function, line, and conditional breakpoints, plus logpoints.
- Step over, step into, continue, stack frames, scopes, and variable updates.
- Records, composites, arrays, JSON, and two-pass PostgreSQL value resolution.
- Debug Console SQL evaluation and PostgreSQL notice forwarding.
- Virtual PostgreSQL source documents, with optional canonical identities from
  an indexing host.
- Session isolation, attach timeout, and idempotent cleanup.

## For client implementers

The ordering constraints matter: the adapter emits `initialized` during
Initialize, answers Launch before waiting for the PostgreSQL target, retains
breakpoints received before listener creation, and waits for the target during
Configuration Done. Clients should follow the standard DAP configuration
sequence.

Structured routine targets start without parsing launch SQL. When an integrating
host supplies `sourceUris`, the adapter preserves those absolute client-owned
URIs exactly, including their schemes and authorities. PostgreSQL Workbench
therefore exposes the same canonical Code Moniker identities through both its
client library and its compiled DAP.

For routines without a client-owned URI, the adapter returns a positive DAP
`sourceReference` and serves the content through the standard DAP Source
request. `Source.path` is intentionally absent: a generic DAP client does not
need to register an adapter-owned URI scheme, and only the integrating host may
define a durable source identity.

The [DAP source](https://github.com/ng-galien/postgresql-workbench/tree/main/src)
and [protocol integration tests](https://github.com/ng-galien/postgresql-workbench/tree/main/e2e)
are the current executable contract.
