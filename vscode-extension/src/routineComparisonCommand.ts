import * as vscode from "vscode";
import { parseSqlDefinitions } from "../../src/callParser.js";
import type { ConnectionManager } from "./connectionManager.js";
import {
  compareRoutineSource,
  resolveRoutineOid,
  routineRegprocedureIdentity,
} from "./routineSourceComparison.js";
import type { CommandFunctionDefinition } from "./sqlCodeLensProvider.js";
import type { WorkbenchIndexController } from "./workbenchIndexController.js";
import { buildWorkbenchObjects } from "./workbenchTreeModel.js";

export function createRoutineComparisonHandler(
  connections: ConnectionManager,
  index: WorkbenchIndexController,
): (definition?: CommandFunctionDefinition) => Promise<false | RoutineComparisonResult> {
  return async (definition) => {
    if (!definition?.sourceSql || definition.body === undefined) {
      void vscode.window.showInformationMessage(
        "Open a local PL/pgSQL routine definition to compare it with PostgreSQL.",
      );
      return false;
    }
    const client = connections.getClient();
    const activeServer = connections.activeServer;
    if (!client || !connections.isConnected || !activeServer) {
      void vscode.window.showInformationMessage(
        "Connect to a PostgreSQL database before comparing this routine.",
      );
      return false;
    }
    if (definition.serverId && definition.serverId !== activeServer.id) {
      void vscode.window.showInformationMessage(
        "The routine comparison belongs to another PostgreSQL connection. Refresh the CodeLens before comparing.",
      );
      return false;
    }
    const snapshot = index.state.result;
    if (index.state.status !== "available" || !snapshot || snapshot.serverId !== activeServer.id) {
      void vscode.window.showInformationMessage(
        "Index the active PostgreSQL database before comparing this routine.",
      );
      return false;
    }
    const identity = routineRegprocedureIdentity(definition);
    const oid = await resolveRoutineOid(client, identity);
    if (oid === undefined) {
      void vscode.window.showInformationMessage(
        `Routine ${identity} is not deployed in the active database.`,
      );
      return false;
    }
    const object = buildWorkbenchObjects(index.indexedSymbols, {
      serverId: snapshot.serverId,
      database: snapshot.database,
    }).find((candidate) => candidate.oid === oid && candidate.kind === definition.kind);
    if (!object) {
      void vscode.window.showInformationMessage(
        `Routine ${identity} is not present in the current Workbench snapshot. Refresh the database index.`,
      );
      return false;
    }
    const deployed = index.sourceDescriptor(object.symbolUri, snapshot);
    if (!deployed) {
      void vscode.window.showInformationMessage(
        "The indexed routine definition is stale. Refresh the database index.",
      );
      return false;
    }
    const [deployedDefinition] = await parseSqlDefinitions(
      deployed.content,
      await index.syntaxParser(),
    );
    const status = await compareRoutineSource(definition.body, deployedDefinition?.body);
    if (status === "unavailable") {
      void vscode.window.showInformationMessage("The PL/pgSQL routine body could not be compared.");
      return false;
    }
    const localDocument = await vscode.workspace.openTextDocument({
      language: "plpgsql",
      content: definition.sourceSql,
    });
    const deployedUri = index.documentUri(deployed.symbolUri);
    if (!deployedUri) return false;
    await vscode.commands.executeCommand(
      "vscode.diff",
      localDocument.uri,
      deployedUri,
      `${object.schema}.${object.name} — local ↔ deployed`,
    );
    void vscode.window.showInformationMessage(
      status === "identical"
        ? `PL/pgSQL source matches the deployed routine ${identity}.`
        : `PL/pgSQL source differs from the deployed routine ${identity}.`,
    );
    return { status, oid, identity };
  };
}

interface RoutineComparisonResult {
  status: "identical" | "different";
  oid: number;
  identity: string;
}
