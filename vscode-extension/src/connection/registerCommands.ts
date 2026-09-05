import * as vscode from "vscode";
import type { WorkbenchDdlSyncController } from "../../../packages/catalog/src/ddlSync.js";
import type { WorkbenchIndexController } from "../../../packages/catalog/src/indexController.js";
import { getConnectionName } from "../../../packages/catalog/src/savedConnection.js";
import { startDockerDebugDatabase } from "../docker/index.js";
import type { ConnectionItem, WorkbenchDdlSyncItem } from "../workbench/index.js";
import { ConnectionsPanel } from "./connectionsPanel.js";
import type { ConnectionManager } from "./index.js";

/**
 * The VS Code commands that manage Connections: adding one, connecting and disconnecting, renaming
 * its display name, removing it, and the Schema Sync switches it carries. Registration only —
 * what each command does lives in the Connection store and in the packages.
 */

export interface ConnectionCommandOptions {
  context: vscode.ExtensionContext;
  connections: ConnectionManager;
  ddlSync: WorkbenchDdlSyncController;
  index: WorkbenchIndexController;
  refreshCodeLens(): void;
  output: vscode.OutputChannel;
}
export function registerConnectionCommands(options: ConnectionCommandOptions): ConnectionsPanel {
  const { context, connections, ddlSync, index, refreshCodeLens, output } = options;
  const connectionsPanel = new ConnectionsPanel(
    connections,
    ddlSync,
    index,
    context.extensionUri,
    () => startDockerDebugDatabase(connections, output),
    context,
  );
  context.subscriptions.push(
    connectionsPanel,
    vscode.commands.registerCommand("postgresql-workbench.manageConnections", () =>
      connectionsPanel.open(),
    ),
    vscode.commands.registerCommand("postgresql-workbench.addConnection", () =>
      connections.commands.addConnection(),
    ),
    vscode.commands.registerCommand("postgresql-workbench.startDockerDebugDatabase", () =>
      startDockerDebugDatabase(connections, output),
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.connectConnection",
      (target: string | ConnectionItem) =>
        connections.connectConnection(typeof target === "string" ? target : target.connection.id),
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.removeConnection",
      (item: ConnectionItem) => connections.commands.removeConnection(item.connection.id),
    ),
    vscode.commands.registerCommand("postgresql-workbench.editConnection", (item: ConnectionItem) =>
      connections.commands.editConnection(item.connection.id),
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.renameConnection",
      (item: ConnectionItem) => connections.commands.renameConnection(item.connection.id),
    ),
    vscode.commands.registerCommand("postgresql-workbench.changePassword", (item: ConnectionItem) =>
      connections.commands.changePassword(item.connection.id),
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.disconnectConnection",
      (target?: string | ConnectionItem) => {
        const id = typeof target === "string" ? target : target?.connection.id;
        return id ? connections.disconnect(id) : false;
      },
    ),
    vscode.commands.registerCommand("postgresql-workbench.pickConnection", async () => {
      const picked = await connections.commands.pickConnection();
      if (picked) refreshCodeLens();
    }),
    vscode.commands.registerCommand(
      "postgresql-workbench.configureWorkbenchSchemaSync",
      async (item?: WorkbenchDdlSyncItem) => {
        let connection = item?.connection;
        if (!connection) {
          const pickedConnection = await vscode.window.showQuickPick(
            connections.connections.map((candidate) => ({
              label: getConnectionName(candidate),
              description: candidate.id,
              connection: candidate,
            })),
            { placeHolder: "Select a PostgreSQL Connection" },
          );
          connection = pickedConnection?.connection;
        }
        if (!connection) return false;
        const configuration = ddlSync.configuration(connection);
        const state = ddlSync.state(connection.id);
        const picked = await vscode.window.showQuickPick(
          [
            {
              label: configuration.enabled
                ? "$(circle-slash) Disable for this Connection"
                : "$(radio-tower) Enable for this Connection",
              detail: configuration.enabled ? "disable" : "enable",
            },
            {
              label: "$(settings) Use User/Workspace Settings",
              description: "Clear connection-specific overrides",
              detail: "settings",
            },
            {
              label: "$(symbol-namespace) Change support schema...",
              description: configuration.supportSchema,
              detail: "schema",
            },
            {
              label: "$(settings-gear) Open extension Settings",
              detail: "open-settings",
            },
            ...(state.status === "provisioning-required" ||
            state.status === "insufficient-privilege"
              ? [
                  {
                    label: "$(tools) Provision database objects...",
                    description: "Requires PostgreSQL superuser privileges",
                    detail: "provision",
                  },
                ]
              : []),
            ...(state.status === "listening" || state.status === "desynchronized"
              ? [
                  {
                    label: "$(trash) Remove database provisioning...",
                    detail: "remove",
                  },
                ]
              : []),
          ],
          { placeHolder: `Schema synchronization · ${getConnectionName(connection)}` },
        );
        switch (picked?.detail) {
          case "enable":
            await ddlSync.setConnectionEnabled(connection.id, true);
            return true;
          case "disable":
            await ddlSync.setConnectionEnabled(connection.id, false);
            return true;
          case "settings":
            await connections.setSchemaSyncOverride(connection.id, undefined);
            return true;
          case "schema": {
            const schema = await vscode.window.showInputBox({
              prompt: "PostgreSQL support schema (lower-case, unquoted identifier)",
              value: configuration.supportSchema,
              validateInput: (value) => {
                try {
                  ddlSync.configuration({
                    ...connection,
                    schemaSync: { ...connection.schemaSync, supportSchema: value },
                  });
                  return undefined;
                } catch (error) {
                  return error instanceof Error ? error.message : String(error);
                }
              },
            });
            if (schema !== undefined) {
              await ddlSync.setConnectionSupportSchema(connection.id, schema);
            }
            return schema !== undefined;
          }
          case "open-settings":
            await vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "@ext:ng-galien.postgresql-workbench schema synchronization",
            );
            return true;
          case "provision":
            return vscode.commands.executeCommand(
              "postgresql-workbench.provisionWorkbenchSchemaSync",
              {
                connection,
              },
            );
          case "remove":
            return vscode.commands.executeCommand(
              "postgresql-workbench.removeWorkbenchSchemaSyncProvisioning",
              { connection },
            );
          default:
            return false;
        }
      },
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.provisionWorkbenchSchemaSync",
      async (item: Pick<WorkbenchDdlSyncItem, "connection">) => {
        const configuration = ddlSync.configuration(item.connection);
        const confirm = await vscode.window.showWarningMessage(
          `Provision schema synchronization on ${getConnectionName(item.connection)}? This creates two database-level EVENT TRIGGER objects and notification functions in schema ${configuration.supportSchema}. PostgreSQL superuser privileges are required.`,
          { modal: true },
          "Provision",
        );
        if (confirm !== "Provision") return false;
        try {
          await ddlSync.provision(item.connection.id);
          void vscode.window.showInformationMessage(
            `Schema synchronization is listening on ${getConnectionName(item.connection)}.`,
          );
          return true;
        } catch (error) {
          void vscode.window.showErrorMessage(
            `Schema synchronization provisioning failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        }
      },
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.removeWorkbenchSchemaSyncProvisioning",
      async (item: Pick<WorkbenchDdlSyncItem, "connection">) => {
        const confirm = await vscode.window.showWarningMessage(
          `Remove Workbench schema synchronization from ${getConnectionName(item.connection)}? The database-level event triggers and Workbench notification functions will be removed without CASCADE.`,
          { modal: true },
          "Remove Provisioning",
        );
        if (confirm !== "Remove Provisioning") return false;
        await ddlSync.removeProvisioning(item.connection.id);
        return true;
      },
    ),
  );
  return connectionsPanel;
}
