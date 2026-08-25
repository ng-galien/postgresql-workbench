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
import type { SqlAuthoringSettings } from "../snapshot.js";
import { formatPostgresSql } from "../text/format.js";
import { sqlStatementAtOffset } from "../text/sqlLexing.js";
import { composeSqlAuthoringRequest } from "./composeRequest.js";
import { postgresCompletions } from "./features/completion.js";
import {
  postgresSemanticTokens,
  SQL_SEMANTIC_TOKEN_MODIFIERS,
  SQL_SEMANTIC_TOKEN_TYPES,
} from "./features/semanticTokens.js";
import { formatSkippedMessage, wantsPlpgsqlSemanticTokens } from "./policy.js";
import {
  SQL_AUTHORING_COMPOSE_REQUEST,
  SQL_AUTHORING_CONTEXT_REQUEST,
  SQL_AUTHORING_PLPGSQL_TOKENS_REQUEST,
  SQL_AUTHORING_SEMANTIC_TOKENS_CHANGED,
  SQL_AUTHORING_SETTINGS_REQUEST,
  SQL_AUTHORING_SYNTAX_REQUEST,
  type SqlAuthoringComposeRequest,
  type SqlAuthoringComposeResult,
  type SqlAuthoringDocumentContext,
  type SqlAuthoringPlpgsqlTokensResult,
  type SqlAuthoringSemanticToken,
  type SqlAuthoringSyntaxResult,
} from "./protocol.js";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const formatWarnings = new Map<string, number>();

connection.onInitialize(() => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    documentFormattingProvider: true,
    completionProvider: { triggerCharacters: ["."] },
    semanticTokensProvider: {
      full: true,
      legend: {
        tokenTypes: [...SQL_SEMANTIC_TOKEN_TYPES],
        tokenModifiers: [...SQL_SEMANTIC_TOKEN_MODIFIERS],
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
  const source = document.getText();
  const offset = document.offsetAt(params.position);
  // The Extension Host parses with a placeholder at the caret, so an unfinished statement still
  // yields its relations; completion never scans the text itself.
  const statement = sqlStatementAtOffset(source, offset);
  const syntax = await connection.sendRequest<SqlAuthoringSyntaxResult>(
    SQL_AUTHORING_SYNTAX_REQUEST,
    {
      uri: params.textDocument.uri,
      source: statement.text,
      caret: offset - statement.start,
    },
  );
  return postgresCompletions(
    source,
    offset,
    context.snapshot,
    syntax.relations ?? [],
    syntax.caretRole,
    syntax.shape,
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
  const skipped = formatSkippedMessage(syntax);
  if (skipped) {
    if (formatWarnings.get(document.uri) !== document.version) {
      formatWarnings.set(document.uri, document.version);
      void connection.window.showWarningMessage(skipped);
    }
    return [];
  }
  const settings = await documentSettings(document.uri);
  const formatted = formatPostgresSql(source, settings.tabSize);
  if (formatted === source) return [];
  return [TextEdit.replace(fullDocumentRange(document), formatted)];
});

documents.onDidClose(({ document }) => formatWarnings.delete(document.uri));

connection.languages.semanticTokens.on(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return { data: [] };
  const plpgsqlTokens = wantsPlpgsqlSemanticTokens(document.uri, document.languageId)
    ? await plpgsqlSemanticTokens(document.uri)
    : [];
  const context = await documentContext(params.textDocument.uri);
  const snapshot =
    context.status === "available" && context.snapshot.status === "available"
      ? context.snapshot
      : undefined;

  // Relations are read from the syntax tree by the Extension Host, never scanned from the text.
  const syntax = await connection.sendRequest<SqlAuthoringSyntaxResult>(
    SQL_AUTHORING_SYNTAX_REQUEST,
    { uri: params.textDocument.uri, source: document.getText(), lexical: true },
  );
  return postgresSemanticTokens(
    document,
    snapshot,
    plpgsqlTokens,
    syntax.relations ?? [],
    syntax.lexical ?? [],
  );
});

connection.onNotification(SQL_AUTHORING_SEMANTIC_TOKENS_CHANGED, () => {
  void connection.languages.semanticTokens.refresh();
});

connection.onRequest<SqlAuthoringComposeResult, void>(
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

async function plpgsqlSemanticTokens(uri: string): Promise<SqlAuthoringSemanticToken[]> {
  try {
    const result = await connection.sendRequest<SqlAuthoringPlpgsqlTokensResult>(
      SQL_AUTHORING_PLPGSQL_TOKENS_REQUEST,
      { uri },
    );
    return result?.tokens ?? [];
  } catch {
    return [];
  }
}

function fullDocumentRange(document: TextDocument) {
  return {
    start: document.positionAt(0),
    end: document.positionAt(document.getText().length),
  };
}

documents.listen(connection);
connection.listen();
