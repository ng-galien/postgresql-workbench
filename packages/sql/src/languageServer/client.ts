import {
  type CompletionItem,
  CompletionItemKind,
  type CompletionList,
  CompletionRequest,
  InsertTextFormat,
  type ProtocolRequestType,
  type SemanticTokens,
  SemanticTokensRequest,
} from "vscode-languageserver-protocol";
import { offsetAtPosition, positionAtOffset } from "../text/positions.js";
import { type NamedSqlToken, namedSemanticTokens } from "./protocol.js";

/**
 * Asking the SQL authoring server, from wherever the asking happens.
 *
 * The server is the one authority on what a name in a statement is and on what may follow the
 * caret, and every surface of the Workbench reaches it through here: the SQL panel of a Data View,
 * its WHERE input, and whatever editor is eventually embedded in a view. A host supplies only what
 * is particular to it — how a document is put in front of the server, and which connection carries
 * the request — because those are the two things that genuinely differ between running inside
 * VS Code and running on its own.
 *
 * Asking VS Code instead of asking the server is not the same question. VS Code answers with every
 * provider registered for the language, so a second SQL extension installed beside this one lands
 * its proposals in a Workbench view, wearing this one's vocabulary. And under a host that is not
 * VS Code there is nothing to ask at all.
 */

/**
 * One request as the protocol declares it. The partial-result and registration slots are the
 * protocol's own and no caller here names them, so they are left open rather than pinned to a
 * shape a request would then fail to match.
 */
type SqlAuthoringRequest<P, R, E> = ProtocolRequestType<P, R, any, E, any>;

/** What carries a request to the server: a protocol connection, or a host's own client. */
export interface SqlAuthoringConnection {
  sendRequest<P, R, E>(type: SqlAuthoringRequest<P, R, E>, params: P): Promise<R>;
}

/** One proposal the server makes, in the words a surface shows it with. */
export interface SqlAuthoringProposal {
  label: string;
  insertText: string;
  detail?: string;
  /** The kind the server gave it, named rather than numbered. */
  kind?: string;
  /** Characters before the caret that the insertion replaces. */
  replaceLength: number;
}

export interface SqlAuthoringClientOptions {
  connection: SqlAuthoringConnection;
  /**
   * Puts this text in front of the server under this URI, whichever way the host synchronises
   * documents: notifications it sends itself, or a document its own client already watches. The
   * language id says what the document is — the server's PL/pgSQL layer is gated on it, so a
   * routine source opened as plain `sql` loses its body's own names.
   */
  sync(uri: string, text: string, languageId?: string): Promise<void>;
  /** The token kinds the server numbers against, as the initialize handshake declared them. */
  legend(): readonly string[] | Promise<readonly string[]>;
}

export interface SqlAuthoringClient {
  /** What the server proposes at `offset` of `text`. */
  complete(uri: string, text: string, offset: number): Promise<SqlAuthoringProposal[]>;
  /** What the server makes of the names in `text`, each kind named rather than numbered. */
  semanticTokens(uri: string, text: string, languageId?: string): Promise<NamedSqlToken[]>;
}

export function createSqlAuthoringClient(options: SqlAuthoringClientOptions): SqlAuthoringClient {
  return {
    async complete(uri, text, offset) {
      await options.sync(uri, text);
      const answer = await options.connection.sendRequest(CompletionRequest.type, {
        textDocument: { uri },
        position: positionAtOffset(text, offset),
      });
      return itemsOf(answer).map((item) => proposal(item, text, offset));
    },
    async semanticTokens(uri, text, languageId) {
      await options.sync(uri, text, languageId);
      const answer = await options.connection.sendRequest(SemanticTokensRequest.type, {
        textDocument: { uri },
      });
      return namedSemanticTokens(tokenDataOf(answer), await options.legend());
    },
  };
}

/** The server may answer a bare list or a list that says whether it is complete. */
function itemsOf(answer: CompletionItem[] | CompletionList | null): CompletionItem[] {
  if (!answer) return [];
  return Array.isArray(answer) ? answer : answer.items;
}

function tokenDataOf(answer: SemanticTokens | null): number[] {
  return answer?.data ?? [];
}

/**
 * The kinds by their number, read from the protocol's own declaration rather than listed again
 * here: a list written out by hand is a list that can fall behind the one it copies.
 */
const KIND_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(CompletionItemKind).map(([name, value]) => [value as number, name]),
);

function proposal(item: CompletionItem, text: string, offset: number): SqlAuthoringProposal {
  const label = typeof item.label === "string" ? item.label : String(item.label);
  const kind = item.kind === undefined ? undefined : KIND_NAMES.get(item.kind);
  return {
    label,
    insertText: insertionOf(item, label),
    ...(item.detail ? { detail: item.detail } : {}),
    ...(kind ? { kind } : {}),
    replaceLength: replacedLength(item, text, offset),
  };
}

/**
 * What a proposal puts in place of what is typed. A snippet's placeholders are dropped rather than
 * inserted: the surfaces that show these proposals are plain inputs, with nowhere to put a tab stop
 * and no way for a reader to leave one behind — and a placeholder's name is a parameter's name, not
 * a value, so writing it out would insert an identifier that resolves to nothing.
 *
 * Both spellings are dropped. The braced one is what this server writes; the bare one is what the
 * protocol also allows, and a pattern that reads it as "a digit and everything after it" swallows
 * the rest of the insertion — `f($1, $2)` became `f(`.
 */
function insertionOf(item: CompletionItem, label: string): string {
  const text = item.textEdit ? item.textEdit.newText : (item.insertText ?? item.label ?? label);
  const plain = typeof text === "string" ? text : label;
  return item.insertTextFormat === InsertTextFormat.Snippet
    ? plain.replace(/\$\{\d+[^}]*\}|\$\d+/gu, "")
    : plain;
}

/** How much of what is typed a proposal replaces: what the server says, or the word at the caret. */
function replacedLength(item: CompletionItem, text: string, offset: number): number {
  const edit = item.textEdit;
  const start = edit && ("range" in edit ? edit.range.start : edit.replace.start);
  if (start) return Math.max(0, offset - offsetAtPosition(text, start));
  return /[\w$"]*$/u.exec(text.slice(0, offset))?.[0].length ?? 0;
}
