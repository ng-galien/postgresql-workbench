import * as vscode from "vscode";
import type { WorkbenchDdlSyncController } from "../../../packages/catalog/src/ddlSync.js";
import type { SqlCodeLensProvider } from "../codeLens/index.js";
import { startDockerDebugDatabase } from "../docker/index.js";
import type { ServerItem, WorkbenchDdlSyncItem } from "../workbench/index.js";
import { type ConnectionManager, getConnectionName } from "./index.js";

/**
 * The VS Code commands that manage Connexions: adding one, connecting and disconnecting, renaming
 * its display name, removing it, and the Schema Sync switches it carries. Registration only —
 * what each command does lives in the Connexion store and in the packages.
 */

export interface ConnectionCommandOptions {
  context: vscode.ExtensionContext;
  connections: ConnectionManager;
  ddlSync: WorkbenchDdlSyncController;
  codeLens: SqlCodeLensProvider;
  output: vscode.OutputChannel;
}
export function registerConnectionCommands(options: ConnectionCommandOptions): void {
  const { context, connections, ddlSync, codeLens, output } = options;
  context.subscriptions.push(
    vscode.commands.registerCommand("postgresql-workbench.addServer", () =>
      connections.commands.addServer(),
    ),
    vscode.commands.registerCommand("postgresql-workbench.startDockerDebugDatabase", () =>
      startDockerDebugDatabase(connections, output),
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.connectServer",
      (target: string | ServerItem) =>
        connections.connectServer(typeof target === "string" ? target : target.server.id),
    ),
    vscode.commands.registerCommand("postgresql-workbench.removeServer", (item: ServerItem) => {
      connections.commands.removeServer(item.server.id);
    }),
    vscode.commands.registerCommand("postgresql-workbench.editServer", (item: ServerItem) =>
      connections.commands.editServer(item.server.id),
    ),
    vscode.commands.registerCommand("postgresql-workbench.renameServer", (item: ServerItem) =>
      connections.commands.renameServer(item.server.id),
    ),
    vscode.commands.registerCommand("postgresql-workbench.changePassword", (item: ServerItem) =>
      connections.commands.changePassword(item.server.id),
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.disconnectServer",
      (target?: string | ServerItem) => {
        const id = typeof target === "string" ? target : target?.server.id;
        return id ? connections.disconnect(id) : false;
      },
    ),
    vscode.commands.registerCommand("postgresql-workbench.pickConnection", async () => {
      const picked = await connections.commands.pickConnection();
      if (picked) codeLens.refresh();
    }),
    vscode.commands.registerCommand(
      "postgresql-workbench.configureWorkbenchSchemaSync",
      async (item?: WorkbenchDdlSyncItem) => {
        let server = item?.server;
        if (!server) {
          const pickedServer = await vscode.window.showQuickPick(
            connections.servers.map((candidate) => ({
              label: getConnectionName(candidate),
              description: candidate.id,
              server: candidate,
            })),
            { placeHolder: "Select a PostgreSQL Connexion" },
          );
          server = pickedServer?.server;
        }
        if (!server) return false;
        const configuration = ddlSync.configuration(server);
        const state = ddlSync.state(server.id);
        const picked = await vscode.window.showQuickPick(
          [
            {
              label: configuration.enabled
                ? "$(circle-slash) Disable for this Connexion"
                : "$(radio-tower) Enable for this Connexion",
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
          { placeHolder: `Schema synchronization · ${getConnectionName(server)}` },
        );
        switch (picked?.detail) {
          case "enable":
            await ddlSync.setConnectionEnabled(server.id, true);
            return true;
          case "disable":
            await ddlSync.setConnectionEnabled(server.id, false);
            return true;
          case "settings":
            await connections.setSchemaSyncOverride(server.id, undefined);
            return true;
          case "schema": {
            const schema = await vscode.window.showInputBox({
              prompt: "PostgreSQL support schema (lower-case, unquoted identifier)",
              value: configuration.supportSchema,
              validateInput: (value) => {
                try {
                  ddlSync.configuration({
                    ...server,
                    schemaSync: { ...server.schemaSync, supportSchema: value },
                  });
                  return undefined;
                } catch (error) {
                  return error instanceof Error ? error.message : String(error);
                }
              },
            });
            if (schema !== undefined) {
              await ddlSync.setConnectionSupportSchema(server.id, schema);
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
                server,
              },
            );
          case "remove":
            return vscode.commands.executeCommand(
              "postgresql-workbench.removeWorkbenchSchemaSyncProvisioning",
              { server },
            );
          default:
            return false;
        }
      },
    ),
    vscode.commands.registerCommand(
      "postgresql-workbench.provisionWorkbenchSchemaSync",
      async (item: Pick<WorkbenchDdlSyncItem, "server">) => {
        const configuration = ddlSync.configuration(item.server);
        const confirm = await vscode.window.showWarningMessage(
          `Provision schema synchronization on ${getConnectionName(item.server)}? This creates two database-level EVENT TRIGGER objects and notification functions in schema ${configuration.supportSchema}. PostgreSQL superuser privileges are required.`,
          { modal: true },
          "Provision",
        );
        if (confirm !== "Provision") return false;
        try {
          await ddlSync.provision(item.server.id);
          void vscode.window.showInformationMessage(
            `Schema synchronization is listening on ${getConnectionName(item.server)}.`,
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
      async (item: Pick<WorkbenchDdlSyncItem, "server">) => {
        const confirm = await vscode.window.showWarningMessage(
          `Remove Workbench schema synchronization from ${getConnectionName(item.server)}? The database-level event triggers and Workbench notification functions will be removed without CASCADE.`,
          { modal: true },
          "Remove Provisioning",
        );
        if (confirm !== "Remove Provisioning") return false;
        await ddlSync.removeProvisioning(item.server.id);
        return true;
      },
    ),
  );
}
