import { spawn } from "node:child_process";
import {
  createProtocolConnection,
  DidChangeTextDocumentNotification,
  DidOpenTextDocumentNotification,
  ExitNotification,
  InitializedNotification,
  InitializeRequest,
  type InitializeResult,
  type ProtocolConnection,
  ShutdownRequest,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-languageserver-protocol/node";
import { analyzePlpgsqlSource } from "../../sql/src/analysis/plpgsqlDocument.js";
import type { SyntaxParser } from "../../sql/src/analysis/syntaxTree.js";
import {
  answerSyntaxRequest,
  type SqlAuthoringSyntaxRequest,
} from "../../sql/src/languageServer/answerSyntax.js";
import {
  createSqlAuthoringClient,
  type SqlAuthoringClient,
} from "../../sql/src/languageServer/client.js";
import {
  SQL_AUTHORING_CONTEXT_REQUEST,
  SQL_AUTHORING_PLPGSQL_TOKENS_REQUEST,
  SQL_AUTHORING_SETTINGS_REQUEST,
  SQL_AUTHORING_SYNTAX_REQUEST,
  type SqlAuthoringPlpgsqlTokensResult,
} from "../../sql/src/languageServer/protocol.js";
import { plpgsqlSemanticTokens } from "../../sql/src/routines/semanticTokens.js";
import {
  DEFAULT_SQL_AUTHORING_SETTINGS,
  type SqlAuthoringSnapshot,
} from "../../sql/src/snapshot.js";

/**
 * The SQL authoring language server, run and spoken to without VS Code.
 *
 * It is a Node process over stdio, and this is the shape a host that is not VS Code takes: the
 * process is started here, the protocol library carries the requests, and the answers are read by
 * the one client every surface asks. What VS Code supplies is a client of the same protocol; it is
 * one host of this server, not the condition for having one.
 *
 * The server has no parser of its own, so it asks its host back for the syntax of every document —
 * answered here with the same function the extension answers with.
 */
export interface SqlLanguageServer extends SqlAuthoringClient {
  dispose(): Promise<void>;
}

export async function startSqlLanguageServer(options: {
  /** The bundled server to run. */
  serverPath: string;
  parser: SyntaxParser;
  snapshot: () => SqlAuthoringSnapshot;
}): Promise<SqlLanguageServer> {
  const child = spawn(process.execPath, [options.serverPath, "--stdio"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const connection: ProtocolConnection = createProtocolConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );

  /** The text of every document this host has put in front of the server, by URI. */
  const held = new Map<string, string>();
  let version = 0;

  connection.onRequest(SQL_AUTHORING_CONTEXT_REQUEST, () => ({
    status: "available" as const,
    snapshot: options.snapshot(),
  }));
  connection.onRequest(SQL_AUTHORING_SETTINGS_REQUEST, () => DEFAULT_SQL_AUTHORING_SETTINGS);
  connection.onRequest(SQL_AUTHORING_SYNTAX_REQUEST, (request: SqlAuthoringSyntaxRequest) =>
    answerSyntaxRequest(request, options.parser, DEFAULT_SQL_AUTHORING_SETTINGS),
  );
  connection.onRequest(
    SQL_AUTHORING_PLPGSQL_TOKENS_REQUEST,
    async ({ uri }: { uri: string }): Promise<SqlAuthoringPlpgsqlTokensResult> => {
      const source = held.get(uri);
      if (source === undefined) return { tokens: [] };
      const routines = await analyzePlpgsqlSource(source, options.parser);
      return { tokens: plpgsqlSemanticTokens(source, routines) };
    },
  );

  connection.listen();
  const initialized: InitializeResult = await connection.sendRequest(InitializeRequest.type, {
    processId: process.pid,
    rootUri: null,
    capabilities: {
      textDocument: {
        completion: { completionItem: { snippetSupport: false } },
        semanticTokens: {
          requests: { full: true },
          tokenTypes: [],
          tokenModifiers: [],
          formats: [],
        },
      },
    },
  });
  await connection.sendNotification(InitializedNotification.type, {});
  const legend = initialized.capabilities.semanticTokensProvider?.legend.tokenTypes ?? [];

  const client = createSqlAuthoringClient({
    connection,
    legend: () => legend,
    async sync(uri, text, languageId = "sql") {
      version += 1;
      const opened = held.has(uri);
      held.set(uri, text);
      if (opened) {
        await connection.sendNotification(DidChangeTextDocumentNotification.type, {
          textDocument: { uri, version },
          contentChanges: [{ text }],
        });
        return;
      }
      await connection.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri, languageId, version, text },
      });
    },
  });

  return {
    complete: client.complete,
    semanticTokens: client.semanticTokens,
    async dispose() {
      await connection.sendRequest(ShutdownRequest.type, undefined).catch(() => {});
      await connection.sendNotification(ExitNotification.type).catch(() => {});
      connection.dispose();
      child.kill();
    },
  };
}
