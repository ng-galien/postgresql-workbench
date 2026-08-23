# PostgreSQL DAP

`@ng-galien/postgresql-dap` is the standalone Debug Adapter Protocol server
used by PostgreSQL Workbench to debug PL/pgSQL routines.

The executable and PostgreSQL Workbench are separate hosts over the same DAP
library. The extension compiles its own adapter entry from the repository; it
does not import this standalone CLI entry or require this package to be
published first.

It communicates over standard input and output and can be launched by any DAP
client:

```bash
npx @ng-galien/postgresql-dap
```

The package uses the native runtime installed by `@code-moniker/client` only
for stateless, on-demand SQL and PL/pgSQL parsing. It starts a private MCP stdio
worker lazily, points it at an empty temporary directory, and stops it with the
DAP process. It does not discover or manage a workspace daemon, index project
files, or call Code Moniker symbols, graph, usages, navigation, or source-set
APIs.

See the [DAP integration guide](https://ng-galien.github.io/postgresql-workbench/docs/dap.html)
for launch arguments and editor integration.

## Diagnostics

```bash
postgresql-dap --version
postgresql-dap --check-code-moniker
```

`--check-code-moniker` starts the private syntax worker, parses a small SQL
statement, and exits after cleaning it up.

## Advanced runtime overrides

PostgreSQL Workbench may point the DAP at the native runtime staged in its VSIX.
Standalone consumers normally do not need either override:

- `PLPGSQL_CODE_MONIKER_RUNTIME`
- `PLPGSQL_CODE_MONIKER_TIMEOUT_MS`

A DAP client may optionally include a `sourceUris` map from PostgreSQL routine
OID to an absolute URI owned by that client. The adapter preserves each URI
exactly, including its scheme and authority. PostgreSQL Workbench uses this to
share its canonical Code Moniker source identities with the DAP it compiles.

Without a client-owned URI, the adapter returns a positive DAP
`sourceReference`; clients retrieve the content through the standard DAP
`source` request. It deliberately omits `Source.path`: the adapter does not
invent a second URI namespace when the client has not supplied one.

## Requirements

- Node.js 22 or newer
- PostgreSQL with `pldbgapi` and `plugin_debugger`

The server works with the standard EnterpriseDB debugger extension and the
optional ng-galien fork.
