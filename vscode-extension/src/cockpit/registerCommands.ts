import * as vscode from "vscode";
import type { WorkbenchObjectModel } from "../../../packages/catalog/src/objectModel.js";
import type {
  FunctionItem,
  WorkbenchObjectItem,
  WorkbenchRelationTargetItem,
} from "../workbench/index.js";
import {
  actionsForWorkbenchSurface,
  type WorkbenchObjectActionSurface,
} from "../workbench/objectActions.js";
import {
  pickWorkbenchObject,
  routineTreeContext,
  selectionMatchesDatabase,
} from "../workbench/objectPicker.js";
import type { WorkbenchCommandOptions } from "../workbench/registerCommands.js";

/**
 * The VS Code commands of the Cockpit: opening the graph, revealing an object in it, and the
 * navigation between the graph, the tree, and the sources.
 */

export function registerGraphWorkbenchCommands(options: WorkbenchCommandOptions): void {
  const {
    context,
    index,
    tree,
    graph,
    graphSync,
    coverage,
    objectActions,
    runObjectAction,
    search,
  } = options;
  context.subscriptions.push(
    vscode.commands.registerCommand("postgresql-workbench.openDatabaseGraph", async () => {
      const candidate = graphSync.currentSelection;
      const selectedObject =
        candidate?.kind === "function" || candidate?.kind === "object"
          ? candidate.object
          : candidate?.kind === "tableMember" || candidate?.kind === "relationGroup"
            ? candidate.object
            : candidate?.kind === "relationTarget"
              ? candidate.target.object
              : undefined;
      const focused = selectedObject
        ? { serverId: selectedObject.serverId, database: selectedObject.database }
        : graph.currentDatabase;
      if (!focused) {
        void vscode.window.showInformationMessage(
          "Select an indexed PostgreSQL object before opening its graph.",
        );
        return false;
      }
      const state = index.databaseState(focused);
      const result = state.result;
      if (state.status === "indexing" || !result) {
        void vscode.window.showInformationMessage(
          "Select an indexed PostgreSQL object before opening its graph.",
        );
        return false;
      }
      const selected = selectionMatchesDatabase(candidate, result.serverId, result.database)
        ? candidate
        : undefined;
      if (selected?.kind === "function" || selected?.kind === "object") {
        return graph.open(selected.object, result);
      }
      if (selected?.kind === "tableMember" || selected?.kind === "relationGroup") {
        return graph.open(selected.object, result);
      }
      if (selected?.kind === "relationTarget" && selected.target.object) {
        return graph.open(selected.target.object, result);
      }
      const database = { serverId: result.serverId, database: result.database };
      if (selected?.kind === "schema" || selected?.kind === "extensionGroup") {
        return graph.openSchema(database, selected.schema, result);
      }
      return graph.openDatabase(database, result);
    }),
    vscode.commands.registerCommand(
      "postgresql-workbench.openObjectGraph",
      async (
        input: WorkbenchObjectModel | FunctionItem | WorkbenchObjectItem | undefined,
        requestedSnapshot?: { revision: string; generation: number | null },
      ) => {
        if (!input) {
          void vscode.window.showInformationMessage(
            "Choose a PostgreSQL object from the Workbench tree or search first.",
          );
          return false;
        }
        const object = "object" in input ? input.object : input;
        const state = index.databaseState(object);
        const result = state.result;
        const itemSnapshot = "snapshot" in input ? input.snapshot : undefined;
        const snapshot = requestedSnapshot ?? itemSnapshot ?? result;
        if (
          state.status === "indexing" ||
          !result ||
          !snapshot ||
          snapshot.revision !== result.revision ||
          snapshot.generation !== result.generation
        ) {
          void vscode.window.showWarningMessage(
            "This PostgreSQL object belongs to an outdated Workbench snapshot. Refresh the index and try again.",
          );
          return false;
        }
        return graph.open(object, {
          serverId: result.serverId,
          database: result.database,
          revision: snapshot.revision,
          generation: snapshot.generation,
        });
      },
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.revealDatabaseObjectInTree",
      async (item: WorkbenchRelationTargetItem) => {
        const object = item?.target.object;
        const state = object ? index.databaseState(object) : undefined;
        const result = state?.result;
        if (
          !object ||
          state?.status === "indexing" ||
          !result ||
          item.snapshot.revision !== result.revision ||
          item.snapshot.generation !== result.generation
        ) {
          void vscode.window.showWarningMessage(
            "This PostgreSQL reference belongs to an outdated Workbench snapshot. Refresh the index and try again.",
          );
          return false;
        }
        return graphSync.navigateToObject(object);
      },
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.showObjectActions",
      async (
        input: WorkbenchObjectModel | FunctionItem | WorkbenchObjectItem | undefined,
        requestedSnapshot?: { revision: string; generation: number | null },
        surface: WorkbenchObjectActionSurface = "default",
      ) => {
        if (!input) return false;
        const object = "object" in input ? input.object : input;
        const state = index.databaseState(object);
        const result = state.result;
        if (!result) return false;
        const itemSnapshot = "snapshot" in input ? input.snapshot : undefined;
        const snapshot = requestedSnapshot ?? itemSnapshot ?? result;
        if (
          result.serverId !== object.serverId ||
          result.database !== object.database ||
          snapshot.revision !== result.revision ||
          snapshot.generation !== result.generation
        ) {
          void vscode.window.showWarningMessage(
            "This PostgreSQL object belongs to an outdated Workbench snapshot. Refresh the index and try again.",
          );
          return false;
        }
        const actions = actionsForWorkbenchSurface(await objectActions(object), surface).filter(
          (action) =>
            state.status !== "indexing" ||
            action.id === "open-definition" ||
            action.id === "open-deployed-source",
        );
        if (actions.length === 0) return false;
        const selected = await vscode.window.showQuickPick(
          actions.map((action) => ({
            label: action.label,
            description: action.description,
            iconPath: new vscode.ThemeIcon(action.icon),
            action,
          })),
          {
            placeHolder: `Actions for ${object.schema}.${object.name}`,
            matchOnDescription: true,
          },
        );
        return selected ? runObjectAction(selected.action.id, object, snapshot) : undefined;
      },
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.searchDatabaseObjects",
      async (context?: unknown) => {
        const query = typeof context === "string" ? context : undefined;
        if (query !== undefined) search.query = query;
        const objects = query ? tree.searchObjects(query, 500) : [];
        const updateQuery = (value: string) => {
          search.query = value;
        };
        const selection = query
          ? objects.length === 1
            ? { object: objects[0], action: "open" as const }
            : await pickWorkbenchObject(tree, query, updateQuery)
          : await pickWorkbenchObject(tree, search.query, updateQuery);
        if (query && objects.length === 0) {
          await vscode.window.showInformationMessage(
            `No indexed PostgreSQL object matches "${query}".`,
          );
          return undefined;
        }
        if (!selection) return undefined;
        const selectedState = index.databaseState(selection.object);
        const result = selectedState.result;
        if (!result || selectedState.status === "indexing") {
          void vscode.window.showInformationMessage(
            "The selected Connexion index is not ready yet.",
          );
          return undefined;
        }
        const command =
          selection.action === "graph"
            ? "postgresql-workbench.openObjectGraph"
            : selection.action === "actions"
              ? "postgresql-workbench.showObjectActions"
              : "postgresql-workbench.openDatabaseObject";
        return vscode.commands.executeCommand(command, selection.object, {
          revision: result.revision,
          generation: result.generation,
        });
      },
    ),
    vscode.commands.registerCommand("postgresql-workbench.exportCoverage", () =>
      coverage.coverageProfile.exportLastCoverage(),
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.revealRoutineTests",
      async (context?: unknown) => {
        const item = routineTreeContext(context);
        const revealed = item
          ? await coverage.revealRoutine(item.serverId, item.oid)
          : await coverage.revealActiveRoutine();
        if (!revealed) {
          await vscode.window.showInformationMessage(
            "No pgTAP tests are mapped to this PL/pgSQL routine.",
          );
        }
        return revealed;
      },
    ),
  );
}
