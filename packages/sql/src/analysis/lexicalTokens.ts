import { byteToCharOffsets } from "../query/analysis.js";
import {
  anonymousKind,
  GRAMMAR_INJECTION_ROOT,
  PLPGSQL_EMBEDDED_SQL_KINDS,
  SQL_KEYWORD_PREFIX,
  SQL_LEXICAL_KINDS,
  SQL_NAME_POSITIONS,
  type SqlLexicalKind,
} from "./postgresGrammar.js";
import type { SyntaxNode, SyntaxTree } from "./syntaxTree.js";

/**
 * Placing what a statement is made of, read from the parse and from nothing else.
 *
 * Colouring SQL takes two answers: what each piece *is* — a keyword, a literal, a comment — and
 * what each name *means*, which needs the catalog. The second was always the server's; this is
 * the first, and it is a total function over the syntax tree. Every node is decided by its kind:
 * the kinds come generated from the grammars, the keyword prefix and the injection root are the
 * grammars' own conventions, and the one split the grammars leave open — which anonymous kind
 * separates and which computes — is a single named decision. Nothing here reads the text to decide
 * what the text is.
 *
 * Where a grammar stops, the reading does not: a dollar-quoted body carries an injected PL/pgSQL
 * tree and the reader descends into it, and the PL/pgSQL grammar keeps its embedded SQL opaque —
 * a body's UPDATE is one leaf to it — so those slices are handed back to the SQL grammar and the
 * answer is walked the same way, however deep the nesting goes.
 */

/** One piece of a statement, placed as the language server counts: zero-based, in UTF-16 units. */
export interface SqlLexicalToken {
  line: number;
  character: number;
  length: number;
  type: SqlLexicalKind;
}

/** Parses one embedded slice with the SQL grammar; the host's parser, handed in by the caller. */
export type EmbeddedSqlParse = (source: string) => Promise<SyntaxTree>;

/** Every piece of a parsed statement, in the order a reader reads them. */
export async function sqlLexicalTokens(
  tree: SyntaxTree,
  source: string,
  parseEmbedded?: EmbeddedSqlParse,
): Promise<SqlLexicalToken[]> {
  const character = byteToCharOffsets(source);
  const lineStarts = startsOfLines(source);
  const tokens: SqlLexicalToken[] = [];

  const emit = (startByte: number, endByte: number, type: SqlLexicalKind) => {
    const start = character(startByte);
    const end = character(endByte);
    if (end > start) tokens.push(...placed(start, end, type, lineStarts));
  };

  // `shift` places a reparsed slice back where it was cut from: an embedded parse counts its
  // bytes from its own start, and every piece it yields belongs at the slice's place in the whole.
  const walk = async (node: SyntaxNode, ancestors: string[], shift: number): Promise<void> => {
    const from = node.byteRange[0] + shift;
    const to = node.byteRange[1] + shift;
    const mapped = SQL_LEXICAL_KINDS.get(node.kind);
    if (mapped !== undefined) {
      const injections = node.children.filter((child) => child.kind === GRAMMAR_INJECTION_ROOT);
      let cursor = from;
      for (const injection of injections) {
        emit(cursor, injection.byteRange[0] + shift, mapped);
        await walk(injection, ancestors, shift);
        cursor = injection.byteRange[1] + shift;
      }
      emit(cursor, to, mapped);
      return;
    }
    if (PLPGSQL_EMBEDDED_SQL_KINDS.has(node.kind) && parseEmbedded && to > from) {
      const embedded = await parseEmbedded(sliceByBytes(source, from, to));
      await walk(embedded.root, [], from);
      return;
    }
    if (node.children.length === 0) {
      const type = leafKind(node, ancestors);
      if (type) emit(from, to, type);
      return;
    }
    ancestors.push(node.kind);
    for (const child of node.children) await walk(child, ancestors, shift);
    ancestors.pop();
  };

  await walk(tree.root, [], 0);
  return tokens.sort((a, b) => a.line - b.line || a.character - b.character);
}

/**
 * What a leaf is, by its kind alone. A keyword standing where a name stands is left to the names
 * layer, an identifier is always the names layer's, and an anonymous kind is the split's.
 */
function leafKind(node: SyntaxNode, ancestors: readonly string[]): SqlLexicalKind | undefined {
  if (node.kind.startsWith(SQL_KEYWORD_PREFIX)) {
    return ancestors.some((kind) => SQL_NAME_POSITIONS.has(kind)) ? undefined : "keyword";
  }
  if (node.named) return undefined;
  return anonymousKind(node.kind);
}

/** The characters whose bytes span `[from, to)` of the source's UTF-8 form. */
function sliceByBytes(source: string, from: number, to: number): string {
  return Buffer.from(source, "utf8").subarray(from, to).toString("utf8");
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
