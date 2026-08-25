# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability.

Report it privately through
[GitHub private vulnerability reporting](https://github.com/ng-galien/postgresql-workbench/security/advisories/new).
Include the affected extension version, PostgreSQL/pldebugger version, platform,
reproduction steps, and the potential impact.

You should receive an acknowledgement within seven days. A fix and disclosure
timeline will be coordinated according to severity.

## Security model

- Database passwords are stored through VS Code SecretStorage, not in
  `launch.json`.
- The extension opens only Connections explicitly configured or selected by
  the user.
- SQL entered in the Debug Console runs with the connected PostgreSQL user's
  permissions.
- The debugger is intended for development environments. Do not enable
  `plugin_debugger` on production servers without a dedicated security review.
- The extension does not collect telemetry.
