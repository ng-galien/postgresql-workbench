import { byteToCharOffsets } from "../query/analysis.js";
import {
  SQL_KEYWORD_PREFIX,
  SQL_LEXICAL_KINDS,
  SQL_NAME_POSITIONS,
  type SqlLexicalKind,
} from "./postgresGrammar.js";
import type { SyntaxNode, SyntaxTree } from "./syntaxTree.js";

/**
 * Placing what a statement is made of, read from the parse rather than from a second grammar.
 *
 * Colouring SQL takes two answers: what each piece *is* — a keyword, a literal, a comment — and
 * what each name *means*, which needs the catalog. The second was always the server's. The first
 * was a TextMate grammar running inside the webview, so the same text was read twice, by two
 * things that could disagree, and one of them could not be reached outside a bundled view.
 *
 * They come from one parse now. It is also the better reader: a grammar matching words sees
 * `SELECT name FROM t` and paints `name` as a keyword, because in PostgreSQL's grammar it is one.
 * The tree knows it stands where a column name stands and says so.
 */
/** One piece of a statement, placed as the language server counts: zero-based, in UTF-16 units. */
export interface SqlLexicalToken {
  line: number;
  character: number;
  length: number;
  type: SqlLexicalKind;
}

const PUNCTUATION = /^[(),;.[\]{}]$/u;

/** Every piece of a parsed statement, in the order a reader reads them. */
export function sqlLexicalTokens(tree: SyntaxTree, source: string): SqlLexicalToken[] {
  const character = byteToCharOffsets(source);
  const lineStarts = startsOfLines(source);
  const tokens: SqlLexicalToken[] = [];
  walk(tree.root, [], (node, ancestors) => {
    const start = character(node.byteRange[0]);
    const end = character(node.byteRange[1]);
    if (end <= start) return;
    const type = typeOf(node, ancestors, source.slice(start, end));
    if (type) tokens.push(...placed(start, end, type, lineStarts));
  });
  return tokens.sort((a, b) => a.line - b.line || a.character - b.character);
}

/**
 * What a node is, or nothing when it is not a piece worth colouring. An identifier is left alone:
 * what a name means is the other answer, and painting it here would only be overwritten.
 *
 * The written form is taken from the source rather than from the node, which carries none: asking
 * the parser for the text of every node would send the whole document back a second time, spelled
 * one word per line.
 */
function typeOf(
  node: SyntaxNode,
  ancestors: readonly string[],
  written: string,
): SqlLexicalKind | undefined {
  const known = SQL_LEXICAL_KINDS.get(node.kind);
  if (known) return known;
  if (node.kind.startsWith(SQL_KEYWORD_PREFIX)) {
    return ancestors.some((kind) => SQL_NAME_POSITIONS.has(kind)) ? undefined : "keyword";
  }
  if (node.named) return undefined;
  return PUNCTUATION.test(written) ? "punctuation" : "operator";
}

/**
 * Walks to the pieces: a node that maps to a piece is one whole, and nothing inside it is read
 * again — a comment holds no keywords and a dollar-quoted body is a string, not a statement.
 */
function walk(
  node: SyntaxNode,
  ancestors: string[],
  visit: (node: SyntaxNode, ancestors: readonly string[]) => void,
): void {
  if (SQL_LEXICAL_KINDS.has(node.kind) || node.children.length === 0) {
    visit(node, ancestors);
    return;
  }
  ancestors.push(node.kind);
  for (const child of node.children) walk(child, ancestors, visit);
  ancestors.pop();
}

/**
 * One token per line the piece covers. A comment or a dollar-quoted body can run over several, and
 * the protocol places every token on a single line.
 */
function placed(
  start: number,
  end: number,
  type: SqlLexicalKind,
  lineStarts: readonly number[],
): SqlLexicalToken[] {
  const tokens: SqlLexicalToken[] = [];
  let line = lineAt(start, lineStarts);
  let from = start;
  while (from < end) {
    const lineEnd = lineStarts[line + 1] ?? end + 1;
    const to = Math.min(end, lineEnd - 1);
    if (to > from) {
      tokens.push({
        line,
        character: from - (lineStarts[line] ?? 0),
        length: to - from,
        type,
      });
    }
    from = lineEnd;
    line += 1;
  }
  return tokens;
}

/** Where each line begins, so a character offset can be placed on one. */
function startsOfLines(source: string): number[] {
  const starts = [0];
  for (let index = source.indexOf("\n"); index >= 0; index = source.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

function lineAt(offset: number, lineStarts: readonly number[]): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((lineStarts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}
