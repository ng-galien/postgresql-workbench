import { byteToCharOffsets } from "../query/analysis.js";
import type { SyntaxNode, SyntaxTree } from "./syntaxTree.js";

/**
 * What a statement is made of, read from the parse rather than from a second grammar.
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
export const SQL_LEXICAL_TOKEN_TYPES = [
  "keyword",
  "string",
  "number",
  "comment",
  "operator",
  "punctuation",
] as const;

export type SqlLexicalTokenType = (typeof SQL_LEXICAL_TOKEN_TYPES)[number];

/** One piece of a statement, placed as the language server counts: zero-based, in UTF-16 units. */
export interface SqlLexicalToken {
  line: number;
  character: number;
  length: number;
  type: SqlLexicalTokenType;
}

/**
 * Node kinds whose whole span is one piece, whatever they contain. A dollar-quoted body is a
 * string even though a PL/pgSQL parse would find statements inside it.
 */
const BY_KIND = new Map<string, SqlLexicalTokenType>([
  ["comment", "comment"],
  ["string_literal", "string"],
  ["dollar_quoted_string", "string"],
  ["bit_string_literal", "string"],
  ["integer_literal", "number"],
  ["float_literal", "number"],
]);

/**
 * Where a keyword stands for a name rather than for itself. PostgreSQL lets most of its words be
 * used as identifiers, and the parser still lexes them as the keywords they are — so the tree is
 * asked where the word sits, not what it is spelled.
 */
const NAME_POSITIONS = new Set([
  "ColId",
  "ColLabel",
  "attr_name",
  "qualified_name",
  "name",
  "type_function_name",
]);

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
): SqlLexicalTokenType | undefined {
  const known = BY_KIND.get(node.kind);
  if (known) return known;
  if (node.kind.startsWith("kw_")) {
    return ancestors.some((kind) => NAME_POSITIONS.has(kind)) ? undefined : "keyword";
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
  if (BY_KIND.has(node.kind) || node.children.length === 0) {
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
  type: SqlLexicalTokenType,
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
