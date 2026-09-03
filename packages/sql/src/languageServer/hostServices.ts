import type { Connection } from "vscode-languageserver";
import type { SyntaxParser } from "../analysis/syntaxTree.js";
import type { SqlAuthoringSettings } from "../snapshot.js";
import { answerSyntaxRequest, type SqlAuthoringSyntaxRequest } from "./answerSyntax.js";
import {
  SQL_AUTHORING_CONTEXT_REQUEST,
  SQL_AUTHORING_SETTINGS_REQUEST,
  SQL_AUTHORING_SYNTAX_REQUEST,
  type SqlAuthoringDocumentContext,
  type SqlAuthoringSyntaxResult,
} from "./protocol.js";

export interface SqlAuthoringDisposable {
  dispose(): void;
}

/** Services the language server needs from the application that owns its documents and catalog. */
export interface SqlAuthoringHostServices {
  documentContext(uri: string): Promise<SqlAuthoringDocumentContext>;
  documentSettings(uri: string): Promise<SqlAuthoringSettings>;
  syntax(request: SqlAuthoringSyntaxRequest): Promise<SqlAuthoringSyntaxResult>;
  /** Catalog or insertion context changed without a visible document edit. */
  onDidChangeContext?(listener: () => void): SqlAuthoringDisposable;
}

/**
 * The stdio server asks its remote host for services over the existing protocol. This preserves
 * the VS Code process boundary without putting transport concerns in the server core.
 */
export function remoteSqlAuthoringHostServices(connection: Connection): SqlAuthoringHostServices {
  return {
    documentContext: (uri) => connection.sendRequest(SQL_AUTHORING_CONTEXT_REQUEST, { uri }),
    documentSettings: (uri) => connection.sendRequest(SQL_AUTHORING_SETTINGS_REQUEST, { uri }),
    syntax: (request) => connection.sendRequest(SQL_AUTHORING_SYNTAX_REQUEST, request),
  };
}

/** Inputs an autonomous host supplies without implementing SQL or PL/pgSQL language features. */
export interface LocalSqlAuthoringHostOptions {
  parser(): Promise<SyntaxParser>;
  documentContext(uri: string): SqlAuthoringDocumentContext | Promise<SqlAuthoringDocumentContext>;
  documentSettings(uri: string): SqlAuthoringSettings | Promise<SqlAuthoringSettings>;
  onDidChangeContext?(listener: () => void): SqlAuthoringDisposable;
}

/**
 * Local application services built from the same parser-backed functions as the remote host. The
 * shell supplies only parser, context and settings; language behavior stays in packages/sql.
 */
export function localSqlAuthoringHostServices(
  options: LocalSqlAuthoringHostOptions,
): SqlAuthoringHostServices {
  return {
    documentContext: async (uri) => options.documentContext(uri),
    documentSettings: async (uri) => options.documentSettings(uri),
    async syntax(request) {
      return answerSyntaxRequest(
        request,
        await options.parser(),
        await options.documentSettings(request.uri),
      );
    },
    ...(options.onDidChangeContext ? { onDidChangeContext: options.onDidChangeContext } : {}),
  };
}
