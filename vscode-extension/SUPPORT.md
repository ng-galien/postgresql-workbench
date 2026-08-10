# Support

Use [GitHub Issues](https://github.com/ng-galien/postgresql-workbench/issues) for bug
reports and feature requests.

Before opening an issue:

1. Run **PL/pgSQL: Check Server Requirements**.
2. Confirm `shared_preload_libraries` contains `plugin_debugger`.
3. Confirm `CREATE EXTENSION pldbgapi;` succeeds in the target database.
4. Reproduce with the latest extension version.

Include:

- extension and VS Code versions;
- operating system;
- PostgreSQL version and installation method;
- pldebugger source (EnterpriseDB/distribution package or ng-galien fork);
- whether scalar variables remain visible;
- the smallest function or procedure that reproduces the issue;
- relevant output from the VS Code Debug Console.

Remove credentials, connection strings, hostnames, and business data before
sharing logs or SQL.

For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of
opening a public issue.
