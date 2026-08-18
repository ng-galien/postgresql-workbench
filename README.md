# PostgreSQL Workbench

[![Visual Studio Marketplace](https://img.shields.io/badge/VS%20Marketplace-install-007ACC?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=ng-galien.postgresql-workbench)
[![Documentation](https://img.shields.io/badge/documentation-GitHub%20Pages-1f6f4f)](https://ng-galien.github.io/postgresql-workbench/)
[![GitHub Release](https://img.shields.io/github/v/release/ng-galien/postgresql-workbench?display_name=tag&sort=semver)](https://github.com/ng-galien/postgresql-workbench/releases/latest)
[![CI](https://github.com/ng-galien/postgresql-workbench/actions/workflows/ci.yml/badge.svg)](https://github.com/ng-galien/postgresql-workbench/actions/workflows/ci.yml)
[![Docker pulls](https://img.shields.io/docker/pulls/galien0xffffff/postgres-debugger?logo=docker)](https://hub.docker.com/r/galien0xffffff/postgres-debugger)
[![License: MIT](https://img.shields.io/github/license/ng-galien/postgresql-workbench)](LICENSE)

PostgreSQL Workbench is a VS Code extension for database exploration, SQL
scratchpads, result inspection, schema synchronization, pgTAP testing,
coverage, and PL/pgSQL debugging. Its standalone
[Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/)
server remains usable from other DAP clients such as Neovim and Emacs.

Read the [PostgreSQL Workbench documentation](https://ng-galien.github.io/postgresql-workbench/)
for feature guides, setup instructions, and the complete command and settings reference.

## Architecture

```
postgresql-workbench/
├── src/                  # DAP server (TypeScript, stdio)
├── vscode-extension/     # VS Code extension (first-party client)
├── e2e/                  # Integration tests (Docker + PostgreSQL)
└── demo/                 # Demo container + sample functions to debug
```

The DAP server communicates with PostgreSQL via `pldbgapi` (the PostgreSQL debugger API) using two connections: a **listener** that controls the debugger, and a **target** that executes the user's SQL.

## Prerequisites

- Node.js 22+
- PostgreSQL with [pldebugger](https://github.com/ng-galien/pldebugger) extension
- `shared_preload_libraries = 'plugin_debugger'`

Ready-to-debug images are published on
[Docker Hub](https://hub.docker.com/r/galien0xffffff/postgres-debugger) for
PostgreSQL 13–18 on amd64 and arm64.

From VS Code, run **`PostgreSQL Workbench: Start Local Debug Database (Docker)`**. The
extension:

1. pulls the selected `galien0xffffff/postgres-debugger` image;
2. starts a container exposed only on `127.0.0.1`;
3. waits for PostgreSQL and creates `pldbgapi`;
4. saves and connects the server in the PL/pgSQL sidebar.

PostgreSQL 17 and local port 5432 are selected by default. The generated local
connection uses `postgres` for the database, user, and password.

> [!WARNING]
> These fixed credentials are only for a disposable development container bound
> to `127.0.0.1`. Never expose this container on `0.0.0.0`, a LAN interface, or
> a remote host. Use a unique strong password for any non-local deployment.

The equivalent CLI setup is:

```bash
docker run -d --name pg-debug -p 127.0.0.1:5432:5432 \
  -e POSTGRES_PASSWORD=postgres \
  galien0xffffff/postgres-debugger:17

docker exec pg-debug psql -U postgres -d postgres \
  -c 'CREATE EXTENSION IF NOT EXISTS pldbgapi'
```

## Development

```bash
npm install
npm run build        # Build DAP server + extension
npm run watch        # Watch mode (DAP server)
npm test             # Unit tests
npm --prefix vscode-extension run test:acceptance:debugger # Playwright debugger journeys in VS Code
npm run test:e2e     # E2E tests (Docker required)
npm run test:e2e:legacy # Compatibility with unpatched EnterpriseDB pldebugger
npm run check        # Biome checks on server, extension, and e2e code
npm --prefix vscode-extension run compile
npm --prefix vscode-extension run package
```

## VS Code Extension

See [vscode-extension/README.md](vscode-extension/README.md) for usage and features.

The extension also provides a pgTAP Test Explorer and native PL/pgSQL
statement/branch coverage. Coverage uses a dedicated transactional runner and
does not depend on DAP or pldebugger; see the extension README for database
permissions, test discovery patterns, limits, and export formats.

Build the installable extension with:

```bash
npm run package:ext
code --install-extension \
  vscode-extension/postgresql-workbench-1.2.1-darwin-arm64.vsix \
  --force
```

Replace `darwin-arm64` with the target produced for your host.

The CI jobs, release checklist, VSIX contract, tag convention, GitHub Release
workflow, Marketplace publication procedure, and recovery steps are documented
in [RELEASING.md](RELEASING.md).


## License

MIT
