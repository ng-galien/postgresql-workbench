---
title: Standalone DAP server
description: Use the PL/pgSQL debugger from another editor or DAP client.
eyebrow: Editor-independent core
---

# A PL/pgSQL debugger that speaks standard DAP over stdio.

The TypeScript debug adapter is separate from the VS Code user interface. Any
editor or client capable of launching a stdio Debug Adapter Protocol server can
integrate it.

{{dap-flow}}

## Current distribution

The standalone server is built from this repository and bundled into the VS
Code extension. A separate package is planned, but is not published yet. Until
then, build and run the repository version:

```bash
npm install
npm run build:dap
npm start
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
- Canonical virtual PostgreSQL source documents.
- Session isolation, attach timeout, and idempotent cleanup.

## For client implementers

The ordering constraints matter: the adapter emits `initialized` during
Initialize, answers Launch before waiting for the PostgreSQL target, retains
breakpoints received before listener creation, and waits for the target during
Configuration Done. Clients should follow the standard DAP configuration
sequence.

The [DAP source](https://github.com/ng-galien/postgresql-workbench/tree/main/src)
and [protocol integration tests](https://github.com/ng-galien/postgresql-workbench/tree/main/e2e)
are the current executable contract.
