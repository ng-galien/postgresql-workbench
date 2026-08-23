import * as vscode from "vscode";
import type { WorkbenchObjectModel } from "../../../packages/catalog/src/objectModel.js";
import type { FunctionItem, PlpgsqlTreeItem, WorkbenchTreeProvider } from "./index.js";

/**
 * Choosing a Workbench object: the quick pick that searches the indexed tree, and reading the
 * object a tree selection or a command argument designates. The Workbench owns its objects; the
 * Cockpit and the commands ask it for one.
 */

export interface WorkbenchObjectPick extends vscode.QuickPickItem {
  object: WorkbenchObjectModel;
}
export interface WorkbenchObjectSelection {
  object: WorkbenchObjectModel;
  action: "open" | "graph" | "actions";
}
export function selectionMatchesDatabase(
  item: PlpgsqlTreeItem | undefined,
  serverId: string,
  database: string,
): boolean {
  if (!item) return false;
  if (
    item.kind === "function" ||
    item.kind === "object" ||
    item.kind === "tableMember" ||
    item.kind === "relationGroup"
  ) {
    return item.object.serverId === serverId && item.object.database === database;
  }
  if (item.kind === "relationTarget") {
    return item.target.object?.serverId === serverId && item.target.object.database === database;
  }
  if (item.kind === "extensionGroup") {
    return item.objects.every(
      (object) => object.serverId === serverId && object.database === database,
    );
  }
  if (item.kind === "server" || item.kind === "databaseSource" || item.kind === "sourcesSnapshot") {
    return item.server.id === serverId && item.server.database === database;
  }
  return item.kind === "schema";
}
export function workbenchObjectPicks(
  objects: readonly WorkbenchObjectModel[],
): WorkbenchObjectPick[] {
  return objects.map((object) => ({
    label: `${object.schema}.${object.name}`,
    description: object.kind,
    detail: object.signature || `${object.database} · ${object.sourceUri}`,
    // The Workbench search already matches tokens across schema, name, kind, and
    // signature. Keep those results visible instead of letting QuickPick apply a
    // second, single-field fuzzy filter that can hide valid cross-field matches.
    alwaysShow: true,
    buttons: [
      {
        iconPath: new vscode.ThemeIcon("type-hierarchy"),
        tooltip: "Open Focused Graph",
      },
      {
        iconPath: new vscode.ThemeIcon("gear"),
        tooltip: "Show Object Actions",
      },
    ],
    object,
  }));
}
export function pickWorkbenchObject(
  treeProvider: WorkbenchTreeProvider,
  initialQuery: string,
  onQueryChanged: (query: string) => void,
): Promise<WorkbenchObjectSelection | undefined> {
  const picker = vscode.window.createQuickPick<WorkbenchObjectPick>();
  picker.placeholder = "Search indexed PostgreSQL objects";
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  const update = (query: string) => {
    onQueryChanged(query);
    picker.items = workbenchObjectPicks(treeProvider.searchObjects(query, 200));
  };
  picker.value = initialQuery;
  update(initialQuery);

  return new Promise((resolve) => {
    let settled = false;
    const subscriptions: vscode.Disposable[] = [];
    const finish = (selection: WorkbenchObjectSelection | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
      picker.dispose();
      resolve(selection);
    };
    subscriptions.push(
      picker.onDidChangeValue(update),
      picker.onDidAccept(() => {
        const object = picker.activeItems[0]?.object;
        finish(object ? { object, action: "open" } : undefined);
      }),
      picker.onDidTriggerItemButton((event) => {
        finish({
          object: event.item.object,
          action: event.button.tooltip === "Show Object Actions" ? "actions" : "graph",
        });
      }),
      picker.onDidHide(() => finish(undefined)),
    );
    picker.show();
  });
}
export function routineTreeContext(
  context: unknown,
): Pick<FunctionItem, "serverId" | "oid"> | undefined {
  if (!context || typeof context !== "object") return undefined;
  const candidate = context as { serverId?: unknown; oid?: unknown };
  return typeof candidate.serverId === "string" && typeof candidate.oid === "number"
    ? { serverId: candidate.serverId, oid: candidate.oid }
    : undefined;
}
