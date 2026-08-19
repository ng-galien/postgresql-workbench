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

export async function closePostgresqlDapTabs(): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.filter(
      (tab) =>
        !tab.isDirty &&
        tab.input instanceof vscode.TabInputText &&
        isPostgresqlDapDocument(tab.input.uri),
    ),
  );
  if (tabs.length > 0) await vscode.window.tabGroups.close(tabs, true);
}
