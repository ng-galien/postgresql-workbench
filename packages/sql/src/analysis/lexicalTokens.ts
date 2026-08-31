import {
  anonymousKind,
  postgresLexicalKind,
  SQL_KEYWORD_PREFIX,
  SQL_NAME_POSITIONS,
  type SqlLexicalKind,
} from "./postgresGrammar.js";
import type { SyntaxLanguage, SyntaxNode, SyntaxTree } from "./syntaxTree.js";
import { byteToUtf16Offsets } from "./textOffsets.js";

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
 * A dollar-quoted body carries a parser-proven injected region and the reader descends into it.
 * Where the syntax port exposes no region, this layer leaves the gap visible; it never reparses a
 * hand-selected node or guesses another language from text.
 */

/** One piece of a statement, placed as the language server counts: zero-based, in UTF-16 units. */
export interface SqlLexicalToken {
  line: number;
  character: number;
  length: number;
  type: SqlLexicalKind;
}

/** Every piece of a parsed statement, in the order a reader reads them. */
export function sqlLexicalTokens(tree: SyntaxTree, source: string): SqlLexicalToken[] {
  const character = byteToUtf16Offsets(source);
  const lineStarts = startsOfLines(source);
  const tokens: SqlLexicalToken[] = [];
  const rootLanguage = syntaxLanguage(tree.language);

  const emit = (startByte: number, endByte: number, type: SqlLexicalKind) => {
    const start = character(startByte);
    const end = character(endByte);
    if (end > start) tokens.push(...placed(start, end, type, lineStarts));
  };

  const walk = (node: SyntaxNode, language: SyntaxLanguage, ancestors: string[]): void => {
    const nodeLanguage = node.languageRegion?.language ?? language;
    const from = node.byteRange[0];
    const to = node.byteRange[1];
    const mapped = postgresLexicalKind(nodeLanguage, node.kind);
    if (mapped !== undefined) {
      const injections = node.children.filter((child) => child.languageRegion !== undefined);
      let cursor = from;
      for (const injection of injections) {
        emit(cursor, injection.byteRange[0], mapped);
        walk(injection, nodeLanguage, ancestors);
        cursor = injection.byteRange[1];
      }
      emit(cursor, to, mapped);
      return;
    }
    if (node.children.length === 0) {
      const type = leafKind(nodeLanguage, node, ancestors);
      if (type) emit(from, to, type);
      return;
    }
    ancestors.push(node.kind);
    for (const child of node.children) walk(child, nodeLanguage, ancestors);
    ancestors.pop();
  };

  walk(tree.root, rootLanguage, []);
  return tokens.sort((a, b) => a.line - b.line || a.character - b.character);
}

/**
 * What a leaf is, by its kind alone. A keyword standing where a name stands is left to the names
 * layer, an identifier is always the names layer's, and an anonymous kind is the split's.
 */
function leafKind(
  language: SyntaxLanguage,
  node: SyntaxNode,
  ancestors: readonly string[],
): SqlLexicalKind | undefined {
  if (node.kind.startsWith(SQL_KEYWORD_PREFIX)) {
    return language === "sql" && ancestors.some((kind) => SQL_NAME_POSITIONS.has(kind))
      ? undefined
      : "keyword";
  }
  if (node.named) return undefined;
  return anonymousKind(node.kind);
}

function syntaxLanguage(language: string): SyntaxLanguage {
  if (language === "sql" || language === "plpgsql") return language;
  throw new Error(`Unsupported PostgreSQL document language: ${language}`);
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
