import {
  type Connection,
  type DocumentFormattingParams,
  TextDocumentSyncKind,
  TextDocuments,
  TextEdit,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { PostgresSyntaxExpectationProvider } from "../analysis/syntaxExpectations.js";
import { postgresSyntaxExpectationProvider } from "../authoring/postgresSyntaxPredictor.js";
import { formatPostgresSql } from "../text/format.js";
import { planSqlAuthoringCompletionRequest } from "./completionRequest.js";
import { composeSqlAuthoringRequest } from "./composeRequest.js";
import {
  analysisOffsetOf,
  projectedSqlDocument,
  projectSemanticTokenData,
} from "./documentProjection.js";
import { postgresCompletionList } from "./features/completion.js";
import { postgresSemanticTokens } from "./features/semanticTokens.js";
import type { SqlAuthoringDisposable, SqlAuthoringHostServices } from "./hostServices.js";
import { SQL_SEMANTIC_TOKEN_MODIFIERS, SQL_SEMANTIC_TOKEN_TYPES } from "./legend.js";
import { formatSkippedMessage, postgresAuthoringDocumentLanguage } from "./policy.js";
import {
  SQL_AUTHORING_COMPOSE_REQUEST,
  SQL_AUTHORING_SEMANTIC_TOKENS_CHANGED,
  type SqlAuthoringComposeRequest,
  type SqlAuthoringComposeResult,
} from "./protocol.js";

/**
 * Starts one complete SQL authoring LSP session on an injected protocol connection. The caller
 * chooses stdio, WebSocket or another transport; all document state and language behavior remain
 * private to this instance.
 */
export function startSqlAuthoringServer(
  connection: Connection,
  host: SqlAuthoringHostServices,
  expectations: PostgresSyntaxExpectationProvider = postgresSyntaxExpectationProvider,
): SqlAuthoringDisposable {
  const documents = new TextDocuments(TextDocument);
  const formatWarnings = new Map<string, number>();
  let disposed = false;

  const refreshSemanticTokens = () => {
    if (disposed) return;
    void connection.languages.semanticTokens.refresh().catch((error: unknown) => {
      if (!disposed) connection.console.error(`Semantic-token refresh failed: ${String(error)}`);
    });
  };

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

  connection.onCompletion(async (params) => {
    const visible = documents.get(params.textDocument.uri);
    if (!visible) return { isIncomplete: false, items: [] };
    const context = await host.documentContext(params.textDocument.uri);
    if (context.status !== "available" || context.snapshot.status !== "available") {
      return { isIncomplete: false, items: [] };
    }
    const projected = projectedSqlDocument(visible, context.projection);
    const visibleOffset = visible.offsetAt(params.position);
    const analysisOffset = analysisOffsetOf(projected, visibleOffset);
    const analysisSource = projected.analysis.getText();
    const completion = await planSqlAuthoringCompletionRequest(
      {
        uri: params.textDocument.uri,
        source: analysisSource,
        language: postgresAuthoringDocumentLanguage(visible.languageId, visible.uri),
        offset: analysisOffset,
        snapshot: context.snapshot,
        limit: 200,
      },
      host,
      expectations,
    );
    return postgresCompletionList(completion, projected);
  });

  connection.onDocumentFormatting(async (params: DocumentFormattingParams) => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];
    const context = await host.documentContext(document.uri);
    // Formatting an embedded condition is withheld until edits can be projected without touching
    // its host-owned prefix or suffix.
    if (context.status === "available" && context.projection) return [];
    const source = document.getText();
    const syntax = await host.syntax({
      uri: document.uri,
      source,
      language: postgresAuthoringDocumentLanguage(document.languageId, document.uri),
    });
    const skipped = formatSkippedMessage(syntax);
    if (skipped) {
      if (formatWarnings.get(document.uri) !== document.version) {
        formatWarnings.set(document.uri, document.version);
        void connection.window.showWarningMessage(skipped);
      }
      return [];
    }
    const settings = await host.documentSettings(document.uri);
    const formatted = formatPostgresSql(source, settings.tabSize);
    if (formatted === source) return [];
    return [TextEdit.replace(fullDocumentRange(document), formatted)];
  });

  documents.onDidClose(({ document }) => formatWarnings.delete(document.uri));

  connection.languages.semanticTokens.on(async (params) => {
    const visible = documents.get(params.textDocument.uri);
    if (!visible) return { data: [] };
    const context = await host.documentContext(params.textDocument.uri);
    const projected = projectedSqlDocument(
      visible,
      context.status === "available" ? context.projection : undefined,
    );
    const analysis = projected.analysis;
    const snapshot =
      context.status === "available" && context.snapshot.status === "available"
        ? context.snapshot
        : undefined;
    const syntax = await host.syntax({
      uri: visible.uri,
      source: analysis.getText(),
      language: postgresAuthoringDocumentLanguage(visible.languageId, visible.uri),
    });
    const semantic = postgresSemanticTokens(
      analysis,
      snapshot,
      syntax.facts?.names ?? [],
      syntax.facts?.lexical ?? [],
    );
    return { data: projectSemanticTokenData(projected, semantic.data) };
  });

  connection.onNotification(SQL_AUTHORING_SEMANTIC_TOKENS_CHANGED, () => {
    refreshSemanticTokens();
  });

  const contextChanges = host.onDidChangeContext?.(() => {
    refreshSemanticTokens();
  });
  const documentListener = documents.listen(connection);
  const disposeSession = () => {
    if (disposed) return;
    disposed = true;
    contextChanges?.dispose();
    documentListener.dispose();
  };
  connection.onShutdown(disposeSession);

  connection.onRequest<SqlAuthoringComposeResult, void>(
    SQL_AUTHORING_COMPOSE_REQUEST,
    async (request: SqlAuthoringComposeRequest): Promise<SqlAuthoringComposeResult> => {
      const settings = await host.documentSettings(request.uri);
      return composeSqlAuthoringRequest(
        request,
        () => host.documentContext(request.uri),
        (source) => host.syntax({ uri: request.uri, source }),
        settings,
      );
    },
  );

  connection.listen();
  return { dispose: disposeSession };
}

function fullDocumentRange(document: TextDocument) {
  return {
    start: document.positionAt(0),
    end: document.positionAt(document.getText().length),
  };
}
