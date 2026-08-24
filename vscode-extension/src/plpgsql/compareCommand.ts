import * as vscode from "vscode";
import type { WorkbenchIndexController } from "../../../packages/catalog/src/indexController.js";
import type {} from "../../../packages/catalog/src/objectModel.js";
import { buildWorkbenchObjects } from "../../../packages/catalog/src/objectModel.js";
import { parseSqlDefinitions } from "../../../packages/sql/src/callParser.js";
import {
  compareRoutineSource,
  resolveRoutineOid,
  routineRegprocedureIdentity,
} from "../../../packages/sql/src/routines/compareSource.js";
import type { CommandFunctionDefinition } from "../codeLens/index.js";
import type { ConnectionManager } from "../connection/index.js";
import type { WorkbenchSourceUris } from "../workbench/sourceUris.js";

export function createRoutineComparisonHandler(
  connections: ConnectionManager,
  index: WorkbenchIndexController,
  sourceUris: WorkbenchSourceUris,
): (definition?: CommandFunctionDefinition) => Promise<false | RoutineComparisonResult> {
  return async (definition) => {
    if (!definition?.sourceSql || definition.body === undefined) {
      void vscode.window.showInformationMessage(
        "Open a local PL/pgSQL routine definition to compare it with PostgreSQL.",
      );
      return false;
    }
    const connection = definition.connectionId
      ? connections.store.get(definition.connectionId)
      : undefined;
    const client = connection ? connections.getClient(connection.id) : undefined;
    if (!client || !connection) {
      void vscode.window.showInformationMessage(
        "Connect to a PostgreSQL database before comparing this routine.",
      );
      return false;
    }
    const state = index.databaseState({
      connectionId: connection.id,
      database: connection.database,
    });
    const snapshot = state.result;
    if (state.status !== "available" || !snapshot) {
      void vscode.window.showInformationMessage(
        "Index the active PostgreSQL database before comparing this routine.",
      );
      return false;
    }
    const identity = routineRegprocedureIdentity(definition);
    const oid = await resolveRoutineOid(client, identity);
    if (oid === undefined) {
      void vscode.window.showInformationMessage(
        `Routine ${identity} is not deployed in this Connection.`,
      );
      return false;
    }
    const object = buildWorkbenchObjects(
      index.databaseSymbols({ connectionId: connection.id, database: connection.database }),
      {
        connectionId: snapshot.connectionId,
        database: snapshot.database,
      },
    ).find((candidate) => candidate.oid === oid && candidate.kind === definition.kind);
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
    const deployedUri = sourceUris.documentUri(deployed.symbolUri);
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
