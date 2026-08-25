import * as vscode from "vscode";

/**
 * Setup guide shown when a Connection target lacks the pldebugger extension.
 * Three paths: Docker (fastest), self-hosted, and an honest note about
 * managed cloud services where pldbgapi is simply not available.
 */
export const REQUIREMENTS_GUIDE = `# PostgreSQL Workbench — Connection Requirements

Debugging PL/pgSQL requires the **pldebugger** extension on the PostgreSQL server:

1. \`plugin_debugger\` loaded via \`shared_preload_libraries\` (needs a server restart)
2. The \`pldbgapi\` extension created in your database

## Option 1 — Docker (fastest)

A ready-to-use PostgreSQL image with the debugger preinstalled (PostgreSQL 13–18, amd64/arm64):

Run **PostgreSQL Workbench: Start Local Debug Database (Docker)** from the Command Palette.
The extension pulls the image, starts PostgreSQL on localhost, creates
\`pldbgapi\`, saves the connection, and connects it automatically.

Manual equivalent:

\`\`\`bash
docker run -d --name pg-debug -p 127.0.0.1:5432:5432 \\
  -e POSTGRES_PASSWORD=postgres \\
  galien0xffffff/postgres-debugger:17

docker exec pg-debug psql -U postgres -d postgres \\
  -c 'CREATE EXTENSION IF NOT EXISTS pldbgapi'
\`\`\`

Then connect with \`postgresql://postgres:postgres@localhost:5432/postgres\`.

## Option 2 — Self-hosted server

1. Install the pldebugger extension:
   - Debian/Ubuntu: \`apt install postgresql-17-pldebugger\`
   - RHEL/Fedora: \`dnf install pldebugger_17\`
   - From source: [github.com/ng-galien/pldebugger](https://github.com/ng-galien/pldebugger)
2. In \`postgresql.conf\`:
   \`\`\`
   shared_preload_libraries = 'plugin_debugger'
   \`\`\`
3. **Restart PostgreSQL**
4. In your database (as superuser):
   \`\`\`sql
   CREATE EXTENSION pldbgapi;
   \`\`\`

## Managed cloud services

pldebugger is **not available** on AWS RDS, Aurora, Azure Database,
Google Cloud SQL, Supabase, or Neon — these services do not allow custom
\`shared_preload_libraries\`.

Debug on a **local or Docker development database** instead (Option 1),
then deploy your functions to the managed service.
`;

/** Open the requirements guide as a rendered markdown preview. */
export async function showRequirementsGuide(): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: REQUIREMENTS_GUIDE,
  });
  await vscode.commands.executeCommand("markdown.showPreview", doc.uri);
}
