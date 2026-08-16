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
  SQL_AUTHORING_SEMANTIC_TOKENS_CHANGED,
  SQL_AUTHORING_SETTINGS_REQUEST,
  SQL_AUTHORING_SYNTAX_REQUEST,
  type SqlAuthoringComposeRequest,
  type SqlAuthoringComposeResult,
  type SqlAuthoringDocumentContext,
  type SqlAuthoringSettings,
  type SqlAuthoringSyntaxResult,
} from "./protocol.js";
import { postgresSemanticTokens, SQL_SEMANTIC_TOKEN_TYPES } from "./semanticTokens.js";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

connection.onInitialize(() => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    documentFormattingProvider: true,
    completionProvider: { triggerCharacters: ["."] },
    semanticTokensProvider: {
      full: true,
      legend: {
        tokenTypes: [...SQL_SEMANTIC_TOKEN_TYPES],
        tokenModifiers: ["declaration", "readonly"],
      },
    },
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
  if (syntax.hasError || syntax.truncated) return [];
  const settings = await documentSettings(document.uri);
  const formatted = formatPostgresSql(source, settings.tabSize);
  if (formatted === source) return [];
  return [TextEdit.replace(fullDocumentRange(document), formatted)];
});

connection.languages.semanticTokens.on(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return { data: [] };
  const context = await documentContext(params.textDocument.uri);
  if (context.status !== "available" || context.snapshot.status !== "available") {
    return { data: [] };
  }
  return postgresSemanticTokens(document, context.snapshot);
});

connection.onNotification(SQL_AUTHORING_SEMANTIC_TOKENS_CHANGED, () => {
  void connection.languages.semanticTokens.refresh();
});

connection.onRequest(
  SQL_AUTHORING_COMPOSE_REQUEST,
  async (request: SqlAuthoringComposeRequest): Promise<SqlAuthoringComposeResult> => {
    const settings = await documentSettings(request.uri);
    return composeSqlAuthoringRequest(
      request,
      () => documentContext(request.uri),
      (source) =>
        connection.sendRequest<SqlAuthoringSyntaxResult>(SQL_AUTHORING_SYNTAX_REQUEST, {
          uri: request.uri,
          source,
        }),
      settings,
    );
  },
);

async function documentContext(uri: string): Promise<SqlAuthoringDocumentContext> {
  return connection.sendRequest(SQL_AUTHORING_CONTEXT_REQUEST, { uri });
}

async function documentSettings(uri: string): Promise<SqlAuthoringSettings> {
  return connection.sendRequest(SQL_AUTHORING_SETTINGS_REQUEST, { uri });
}

function fullDocumentRange(document: TextDocument) {
  return {
    start: document.positionAt(0),
    end: document.positionAt(document.getText().length),
  };
}

documents.listen(connection);
connection.listen();
