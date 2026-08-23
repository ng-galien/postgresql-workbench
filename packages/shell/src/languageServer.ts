import { spawn } from "node:child_process";
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type { DataViewCompletion } from "../../rows/src/dataView/dataView.js";
import type { DataViewSqlToken } from "../../rows/src/dataView/dataViewProtocol.js";
import type { SyntaxParser } from "../../sql/src/analysis/syntaxTree.js";
import {
  answerSyntaxRequest,
  type SqlAuthoringSyntaxRequest,
} from "../../sql/src/languageServer/answerSyntax.js";
import {
  namedSemanticTokens,
  SQL_AUTHORING_CONTEXT_REQUEST,
  SQL_AUTHORING_SETTINGS_REQUEST,
  SQL_AUTHORING_SYNTAX_REQUEST,
} from "../../sql/src/languageServer/protocol.js";
import {
  DEFAULT_SQL_AUTHORING_SETTINGS,
  type SqlAuthoringSnapshot,
} from "../../sql/src/snapshot.js";
import {
  offsetAtPosition,
  positionAtOffset,
  type TextPosition,
} from "../../sql/src/text/positions.js";

/**
 * The SQL authoring language server, spoken to directly. It is a Node process over stdio and needs
 * no VS Code — what VS Code supplies is the client, and this is one. It has no parser of its own,
 * so it asks its host back for the syntax of every document, which the shell answers with the same
 * function the extension answers with.
 */
export interface SqlLanguageServer {
  /** What the server proposes at `offset` of `text`, as the WHERE input shows proposals. */
  complete(uri: string, text: string, offset: number): Promise<DataViewCompletion[]>;
  /** What the server makes of the names in `text`: the tokens the SQL panel is coloured with. */
  semanticTokens(uri: string, text: string): Promise<DataViewSqlToken[]>;
  dispose(): Promise<void>;
}

interface CompletionItem {
  label: string | { label: string };
  insertText?: string;
  detail?: string;
  kind?: number;
  textEdit?: { range: { start: TextPosition; end: TextPosition } };
}

interface InitializeResult {
  capabilities?: { semanticTokensProvider?: { legend?: { tokenTypes?: string[] } } };
}

const COMPLETION_KINDS = [
  "Text",
  "Method",
  "Function",
  "Constructor",
  "Field",
  "Variable",
  "Class",
  "Interface",
  "Module",
  "Property",
  "Unit",
  "Value",
  "Enum",
  "Keyword",
  "Snippet",
  "Color",
  "File",
  "Reference",
  "Folder",
  "EnumMember",
  "Constant",
  "Struct",
  "Event",
  "Operator",
  "TypeParameter",
];

export async function startSqlLanguageServer(options: {
  /** The bundled server to run. */
  serverPath: string;
  parser: SyntaxParser;
  snapshot: () => SqlAuthoringSnapshot;
}): Promise<SqlLanguageServer> {
  const child = spawn(process.execPath, [options.serverPath, "--stdio"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const connection: MessageConnection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );

  // The three questions the server sends back to whoever hosts it.
  connection.onRequest(SQL_AUTHORING_CONTEXT_REQUEST, () => ({
    status: "available" as const,
    snapshot: options.snapshot(),
  }));
  connection.onRequest(SQL_AUTHORING_SETTINGS_REQUEST, () => DEFAULT_SQL_AUTHORING_SETTINGS);
  connection.onRequest(SQL_AUTHORING_SYNTAX_REQUEST, (request: SqlAuthoringSyntaxRequest) =>
    answerSyntaxRequest(request, options.parser, DEFAULT_SQL_AUTHORING_SETTINGS),
  );

  connection.listen();
  const initialized = await connection.sendRequest<InitializeResult>("initialize", {
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
  await connection.sendNotification("initialized", {});
  const legend = initialized.capabilities?.semanticTokensProvider?.legend?.tokenTypes ?? [];

  const open = new Set<string>();
  let version = 0;

  const sync = async (uri: string, text: string) => {
    version += 1;
    if (open.has(uri)) {
      await connection.sendNotification("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
      return;
    }
    await connection.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "sql", version, text },
    });
    open.add(uri);
  };

  return {
    async complete(uri, text, offset) {
      await sync(uri, text);
      const items = await connection.sendRequest<CompletionItem[] | { items: CompletionItem[] }>(
        "textDocument/completion",
        { textDocument: { uri }, position: positionAtOffset(text, offset) },
      );
      const list = Array.isArray(items) ? items : (items?.items ?? []);
      return list.map((item) => proposal(item, text, offset));
    },
    async semanticTokens(uri, text) {
      await sync(uri, text);
      const answer = await connection.sendRequest<{ data: number[] } | null>(
        "textDocument/semanticTokens/full",
        { textDocument: { uri } },
      );
      return namedSemanticTokens(answer?.data, legend);
    },
    async dispose() {
      await connection.sendRequest("shutdown").catch(() => {});
      connection.dispose();
      child.kill();
    },
  };
}

function proposal(item: CompletionItem, text: string, offset: number): DataViewCompletion {
  const label = typeof item.label === "string" ? item.label : item.label.label;
  return {
    label,
    insertText: item.insertText ?? label,
    ...(item.detail ? { detail: item.detail } : {}),
    ...(item.kind ? { kind: COMPLETION_KINDS[item.kind - 1] ?? "Text" } : {}),
    replaceLength: replacedLength(item, text, offset),
  };
}

/** How much of what is typed a proposal replaces: what the server says, or the word at the caret. */
function replacedLength(item: CompletionItem, text: string, offset: number): number {
  const start = item.textEdit?.range.start;
  if (start) return Math.max(0, offset - offsetAtPosition(text, start));
  return /[\w$"]*$/u.exec(text.slice(0, offset))?.[0].length ?? 0;
}
