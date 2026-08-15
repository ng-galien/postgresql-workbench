import { join } from "node:path";
import * as vscode from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import type { ConnectionManager } from "../connectionManager.js";
import {
  resolveScratchpadAssociation,
  SQL_NOTEBOOK_TYPE,
  type SqlNotebookMetadata,
} from "../sqlNotebookModel.js";
import type { WorkbenchIndexController } from "../workbenchIndexController.js";
import { sqlAuthoringEditStillApplies } from "./composeRequest.js";
import {
  parseSqlAuthoringDrag,
  SQL_AUTHORING_COMPOSE_REQUEST,
  SQL_AUTHORING_CONTEXT_REQUEST,
  SQL_AUTHORING_OBJECT_MIME,
  SQL_AUTHORING_SYNTAX_REQUEST,
  type SqlAuthoringComposeRequest,
  type SqlAuthoringComposeResult,
  type SqlAuthoringDocumentContext,
  type SqlAuthoringSyntaxResult,
  sqlAuthoringContextMatchesToken,
} from "./protocol.js";

const SQL_DOCUMENT_SELECTOR = [
  { language: "sql", scheme: "file" },
  { language: "plpgsql", scheme: "file" },
  { language: "plpgsql", scheme: "vscode-notebook-cell" },
] as const;

export async function registerSqlAuthoring(
  context: vscode.ExtensionContext,
  connections: ConnectionManager,
  index: WorkbenchIndexController,
): Promise<vscode.Disposable> {
  const module = context.asAbsolutePath(join("dist", "sql-authoring-server.js"));
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    debug: { module, transport: TransportKind.ipc },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [...SQL_DOCUMENT_SELECTOR],
    outputChannelName: "PostgreSQL Workbench SQL Authoring",
  };
  const client = new LanguageClient(
    "postgresql-workbench-sql-authoring",
    "PostgreSQL Workbench SQL Authoring",
    serverOptions,
    clientOptions,
  );
  await client.start();

  client.onRequest<SqlAuthoringDocumentContext, never>(
    SQL_AUTHORING_CONTEXT_REQUEST,
    (parameters) => resolveDocumentContext((parameters as { uri: string }).uri, connections, index),
  );
  client.onRequest(
    SQL_AUTHORING_SYNTAX_REQUEST,
    async ({ uri, source }: { uri: string; source: string }): Promise<SqlAuthoringSyntaxResult> => {
      const parser = await index.syntaxParser();
      const syntax = await parser.parse({
        language: "sql",
        source,
        uri,
        maxNodes: 2_000,
        namedOnly: true,
      });
      return { hasError: syntax.hasError };
    },
  );

  const dropProvider = vscode.languages.registerDocumentDropEditProvider(
    [...SQL_DOCUMENT_SELECTOR] satisfies vscode.DocumentSelector,
    {
      async provideDocumentDropEdits(document, position, transfer, token) {
        const item = transfer.get(SQL_AUTHORING_OBJECT_MIME);
        if (!item) return undefined;
        const payload = parseSqlAuthoringDrag(await item.asString());
        if (!payload || token.isCancellationRequested) return undefined;
        let request: SqlAuthoringComposeRequest = {
          uri: document.uri.toString(),
          text: document.getText(),
          offset: document.offsetAt(position),
          payload,
        };
        let result = await client.sendRequest<SqlAuthoringComposeResult>(
          SQL_AUTHORING_COMPOSE_REQUEST,
          request,
          token,
        );
        if (token.isCancellationRequested) return undefined;
        if (result.status === "ambiguous") {
          const current = resolveDocumentContext(document.uri.toString(), connections, index);
          if (!sqlAuthoringContextMatchesToken(current, result.snapshot)) {
            void vscode.window.showWarningMessage(
              "The Workbench Index changed while composing SQL. Retry the drop on the fresh snapshot.",
            );
            return unchangedDropEdit("Leave stale SQL composition unchanged");
          }
          const selected = await vscode.window.showQuickPick(
            result.choices.map((choice) => ({ ...choice, detail: choice.description })),
            {
              title: "Choose the foreign key for this JOIN",
              placeHolder: "No JOIN is added until you choose",
            },
          );
          if (!selected) return unchangedDropEdit("Leave SQL unchanged");
          request = { ...request, relationChoice: selected.index };
          result = await client.sendRequest<SqlAuthoringComposeResult>(
            SQL_AUTHORING_COMPOSE_REQUEST,
            request,
            token,
          );
        }
        if (result.status === "rejected") {
          void vscode.window.showWarningMessage(result.message);
          return unchangedDropEdit("Leave unsupported SQL unchanged");
        }
        if (result.status !== "edit") return unchangedDropEdit("Leave SQL unchanged");
        const current = resolveDocumentContext(document.uri.toString(), connections, index);
        if (!sqlAuthoringEditStillApplies(result, current, request.text, document.getText())) {
          void vscode.window.showWarningMessage(
            "The Workbench Index or SQL document changed while composing. Retry the drop.",
          );
          return unchangedDropEdit("Leave changed SQL unchanged");
        }
        const edit = new vscode.DocumentDropEdit("", result.title);
        edit.additionalEdit = new vscode.WorkspaceEdit();
        edit.additionalEdit.replace(
          document.uri,
          new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
          result.text,
        );
        return edit;
      },
    },
    { dropMimeTypes: [SQL_AUTHORING_OBJECT_MIME] },
  );

  return vscode.Disposable.from(dropProvider, { dispose: () => void client.stop() });
}

function unchangedDropEdit(title: string): vscode.DocumentDropEdit {
  return new vscode.DocumentDropEdit("", title);
}

export function resolveDocumentContext(
  uri: string,
  connections: Pick<ConnectionManager, "activeServer" | "isConnected" | "servers">,
  index: Pick<WorkbenchIndexController, "sqlAuthoringSnapshot">,
): SqlAuthoringDocumentContext {
  const notebook = vscode.workspace.notebookDocuments.find((candidate) =>
    candidate.getCells().some((cell) => cell.document.uri.toString() === uri),
  );
  const isNotebookCell = vscode.Uri.parse(uri).scheme === "vscode-notebook-cell";
  if (notebook || isNotebookCell) {
    if (!notebook) {
      return {
        status: "unavailable",
        message: "This notebook cell is not attached to a PostgreSQL Workbench Scratchpad.",
      };
    }
    if (notebook.notebookType !== SQL_NOTEBOOK_TYPE) {
      return {
        status: "unavailable",
        message: "SQL authoring for notebook cells is limited to PostgreSQL Workbench Scratchpads.",
      };
    }
    const association = resolveScratchpadAssociation(
      sqlNotebookMetadata(notebook.metadata),
      connections.servers,
    );
    if (association.status === "unassociated") {
      return { status: "unassociated", message: "This Scratchpad has no Association." };
    }
    if (association.status === "unavailable") {
      return {
        status: "unavailable",
        message: "This Scratchpad Association is no longer available.",
      };
    }
    return indexedContext(
      index,
      association.snapshot.serverId,
      association.snapshot.database,
      "Scratchpad Association",
    );
  }

  const active = connections.activeServer;
  if (!active || !connections.isConnected) {
    return { status: "unavailable", message: "No active DatabaseContext is connected." };
  }
  return indexedContext(index, active.id, active.database, "active DatabaseContext");
}

function indexedContext(
  index: Pick<WorkbenchIndexController, "sqlAuthoringSnapshot">,
  serverId: string,
  database: string,
  label: string,
): SqlAuthoringDocumentContext {
  const snapshot = index.sqlAuthoringSnapshot({ serverId, database });
  return snapshot
    ? { status: "available", snapshot }
    : { status: "not-indexed", message: `The ${label} is not indexed.` };
}

function sqlNotebookMetadata(value: unknown): SqlNotebookMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const metadata = value as Record<string, unknown>;
  return {
    serverId: typeof metadata.serverId === "string" ? metadata.serverId : undefined,
    serverName: typeof metadata.serverName === "string" ? metadata.serverName : undefined,
    database: typeof metadata.database === "string" ? metadata.database : undefined,
    executionMode: metadata.executionMode === "manual" ? "manual" : "auto",
  };
}
