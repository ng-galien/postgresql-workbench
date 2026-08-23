import type { DataViewSqlToken } from "../../../rows/src/dataView/dataViewProtocol.js";
import type { HighlightedPostgresSource, PostgresSourceToken } from "./highlight.js";

/**
 * One name the language server recognised in the source. The kinds are the server's own —
 * `sqlTable`, `sqlColumn`, `sqlAlias` — and the view knows them only as the class it paints with.
 * It is the shape the hosts already send: a view renders what the packages around it produce, and
 * does not restate what one of them has already named.
 */
export type PostgresSemanticToken = DataViewSqlToken;

/**
 * The grammar says what a statement is made of; the language server says what its names are.
 *
 * A highlighter reading text alone cannot tell `brand` the table from `brand` the alias from
 * `brand` the column: it colours every identifier the same. The server has the Workbench Index and
 * knows which is which, so its tokens are laid over the syntactic ones — the same two layers the
 * editor itself paints, in the same order, so a statement reads the same in the view as in a tab.
 *
 * Tokens that fall outside the text are ignored rather than trusted: they were read from a
 * statement, and a statement can have moved on since.
 */
export function withSemanticTokens(
  source: HighlightedPostgresSource,
  tokens: readonly PostgresSemanticToken[],
): HighlightedPostgresSource {
  if (tokens.length === 0) return source;
  const byLine = new Map<number, PostgresSemanticToken[]>();
  for (const token of tokens) {
    const line = token.line + 1;
    const named = byLine.get(line);
    if (named) named.push(token);
    else byLine.set(line, [token]);
  }
  return {
    ...source,
    lines: source.lines.map((line) => {
      const named = byLine.get(line.number);
      return named ? { ...line, tokens: paint(line.tokens, named) } : line;
    }),
  };
}

/**
 * Splits the syntactic tokens of one line wherever a name starts or ends, and marks the piece the
 * name covers. Names do not overlap each other, so taking them one after another cuts each piece
 * at most once per name and leaves what no name covers exactly as the grammar coloured it.
 */
function paint(
  tokens: readonly PostgresSourceToken[],
  named: readonly PostgresSemanticToken[],
): PostgresSourceToken[] {
  let pieces = [...tokens];
  for (const name of named) pieces = pieces.flatMap((piece) => cut(piece, name));
  return pieces;
}

/** One token against one name: itself, or up to three pieces with the covered one marked. */
function cut(token: PostgresSourceToken, name: PostgresSemanticToken): PostgresSourceToken[] {
  const start = token.offset;
  const end = start + token.text.length;
  const from = Math.max(start, name.character);
  const to = Math.min(end, name.character + name.length);
  if (from >= to) return [token];
  return [
    piece(token, start, from),
    { ...piece(token, from, to), className: `postgres-token-${name.type}` },
    piece(token, to, end),
  ].filter((part) => part.text.length > 0);
}

function piece(token: PostgresSourceToken, from: number, to: number): PostgresSourceToken {
  return { ...token, offset: from, text: token.text.slice(from - token.offset, to - token.offset) };
}
