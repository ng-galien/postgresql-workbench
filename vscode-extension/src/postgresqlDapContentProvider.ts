import * as vscode from "vscode";

export const POSTGRESQL_DAP_SOURCE_SCHEME = "postgresql-dap";

export function isPostgresqlDapDocument(uri: vscode.Uri): boolean {
  if (uri.scheme === POSTGRESQL_DAP_SOURCE_SCHEME) return true;
  if (uri.scheme !== "debug") return false;

  let nested = uri.toString().slice("debug:".length).split("?", 1)[0];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (nested.startsWith(`${POSTGRESQL_DAP_SOURCE_SCHEME}:`)) return true;
    try {
      nested = decodeURIComponent(nested);
    } catch {
      return false;
    }
  }
  return false;
}

export class PostgresqlDapContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const session = vscode.debug.activeDebugSession;
    if (session?.type !== "postgresql-workbench") {
      throw new Error(`No active PL/pgSQL debug session can resolve ${uri.toString()}`);
    }
    const response = (await session.customRequest("source", {
      source: { path: uri.toString() },
      sourceReference: 0,
    })) as { content?: unknown };
    if (typeof response.content !== "string") {
      throw new Error(`PL/pgSQL debug source ${uri.toString()} returned no content`);
    }
    return response.content;
  }
}
