import {
  type CompletionItem,
  createConnection,
  type DocumentFormattingParams,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
  TextEdit,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { postgresCompletions } from "./completion.js";
import { composeSqlAuthoringRequest } from "./composeRequest.js";
import { formatPostgresSql } from "./format.js";
import {
  SQL_AUTHORING_COMPOSE_REQUEST,
  SQL_AUTHORING_CONTEXT_REQUEST,
  SQL_AUTHORING_SYNTAX_REQUEST,
  type SqlAuthoringComposeRequest,
  type SqlAuthoringComposeResult,
  type SqlAuthoringDocumentContext,
  type SqlAuthoringSyntaxResult,
} from "./protocol.js";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

connection.onInitialize(() => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    documentFormattingProvider: true,
    completionProvider: { triggerCharacters: ["."] },
  },
  serverInfo: { name: "PostgreSQL Workbench SQL Authoring", version: "1" },
}));

connection.onCompletion(async (params): Promise<CompletionItem[]> => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  const context = await documentContext(params.textDocument.uri);
  if (context.status !== "available" || context.snapshot.status !== "available") return [];
  return postgresCompletions(
    document.getText(),
    document.offsetAt(params.position),
    context.snapshot,
  );
});

connection.onDocumentFormatting(async (params: DocumentFormattingParams) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return [];
  const source = document.getText();
  const syntax = await connection.sendRequest<SqlAuthoringSyntaxResult>(
    SQL_AUTHORING_SYNTAX_REQUEST,
    { uri: document.uri, source },
  );
  if (syntax.hasError) return [];
  const formatted = formatPostgresSql(source);
  if (formatted === source) return [];
  return [TextEdit.replace(fullDocumentRange(document), formatted)];
});

connection.onRequest(
  SQL_AUTHORING_COMPOSE_REQUEST,
  async (request: SqlAuthoringComposeRequest): Promise<SqlAuthoringComposeResult> => {
    return composeSqlAuthoringRequest(
      request,
      () => documentContext(request.uri),
      (source) =>
        connection.sendRequest<SqlAuthoringSyntaxResult>(SQL_AUTHORING_SYNTAX_REQUEST, {
          uri: request.uri,
          source,
        }),
    );
  },
);

async function documentContext(uri: string): Promise<SqlAuthoringDocumentContext> {
  return connection.sendRequest(SQL_AUTHORING_CONTEXT_REQUEST, { uri });
}

function fullDocumentRange(document: TextDocument) {
  return {
    start: document.positionAt(0),
    end: document.positionAt(document.getText().length),
  };
}

documents.listen(connection);
connection.listen();
