import {
  assertUsableSyntaxTree,
  directSyntaxChild,
  UnusableSyntaxTreeError,
} from "../../sql/src/analysis/syntaxNodes.js";
import type { SyntaxNode, SyntaxParser } from "../../sql/src/analysis/syntaxTree.js";
import { scanPostgresSql } from "../../sql/src/text/sqlLexing.js";

// Code Moniker's stateless syntax endpoint accepts this many bytes per request.
const SYNTAX_REQUEST_BYTES = 1024 * 1024;

interface PostgresStatementOutline {
  source: string;
  byteOffset: number;
  declarations: SyntaxNode[];
}

export async function postgresStatementTrees(
  source: string,
  parser: SyntaxParser,
  kinds: readonly string[],
) {
  const outlines = await readOutlines(source, parser);
  const trees = [];
  for (const outline of outlines) {
    const bytes = Buffer.from(outline.source);
    for (const statement of outline.declarations) {
      if (!kinds.includes(statement.kind)) continue;
      const [start, end] = statement.byteRange;
      const tableSource = bytes.subarray(start, end).toString("utf8");
      const tree = await parser.parse({ language: "sql", source: tableSource });
      assertUsableSyntaxTree(tree, "SQL table declaration");
      trees.push({ source: tableSource, root: tree.root, offset: outline.byteOffset + start });
    }
  }
  return { outlines, trees };
}

async function readOutlines(
  source: string,
  parser: SyntaxParser,
): Promise<PostgresStatementOutline[]> {
  const outlines: PostgresStatementOutline[] = [];
  const totalBytes = Buffer.byteLength(source);
  let cuts: number[] = [];
  if (totalBytes > SYNTAX_REQUEST_BYTES) {
    cuts = scanPostgresSql(source).statementSeparators.map((separator) => separator + 1);
  }
  let offset = 0;
  let byteOffset = 0;
  while (offset < source.length) {
    const end =
      totalBytes - byteOffset <= SYNTAX_REQUEST_BYTES
        ? source.length
        : requestEnd(source, offset, cuts);
    if (end <= offset) {
      throw new UnusableSyntaxTreeError(
        `No complete SQL statement fits in a syntax request at byte ${byteOffset}`,
        "truncated",
      );
    }
    const outline = await readOutlinePrefix(source.slice(offset, end), parser, end < source.length);
    outlines.push({ ...outline, byteOffset });
    offset += outline.source.length;
    byteOffset += Buffer.byteLength(outline.source);
  }
  return outlines;
}

function requestEnd(source: string, start: number, cuts: readonly number[]): number {
  let low = 0;
  let high = cuts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const end = cuts[middle];
    const fits =
      end <= start ||
      (end - start <= SYNTAX_REQUEST_BYTES &&
        Buffer.byteLength(source.slice(start, end)) <= SYNTAX_REQUEST_BYTES);
    if (fits) low = middle + 1;
    else high = middle;
  }
  return cuts[low - 1] ?? start;
}

async function readOutlinePrefix(source: string, parser: SyntaxParser, partialSource: boolean) {
  const outline = await parseOutline(source, parser);
  const bytes = Buffer.from(source);
  try {
    return { source, declarations: checkOutline(bytes, outline) };
  } catch (error) {
    if (!partialSource && outline.hasError) throw error;
    // A lexical separator is only a candidate. Back up to a separator emitted at
    // the top level by the grammar and require an intact parse of the prefix.
    const ends = outline.root.children
      .filter((node) => node.kind === ";")
      .map((node) => node.byteRange[1])
      .filter((end) => end > 0 && end < bytes.length);
    for (let index = ends.length - 1; index >= 0; index = Math.ceil(index / 2) - 1) {
      const end = ends[index];
      const prefix = bytes.subarray(0, end);
      const text = prefix.toString("utf8");
      const parsed = await parseOutline(text, parser);
      try {
        return { source: text, declarations: checkOutline(prefix, parsed) };
      } catch (prefixError) {
        if (!(prefixError instanceof UnusableSyntaxTreeError)) throw prefixError;
      }
    }
    throw error;
  }
}

async function parseOutline(source: string, parser: SyntaxParser) {
  for (let maxNodes = DEFAULT_SYNTAX_MAX_NODES; ; maxNodes = Math.floor(maxNodes / 2)) {
    try {
      return await parser.parse({
        language: "sql",
        source,
        maxDepth: 3,
        namedOnly: false,
        ...(maxNodes === DEFAULT_SYNTAX_MAX_NODES ? {} : { maxNodes }),
      });
    } catch (error) {
      if (maxNodes <= 1 || !isSyntaxResponseTooLarge(error)) throw error;
    }
  }
}

export function isSyntaxResponseTooLarge(error: unknown): boolean {
  // The Node client currently forwards jsonrpsee's oversized-response message.
  return (
    error instanceof Error &&
    error.name === "DaemonRpcError" &&
    error.message === "Response is too big"
  );
}

function checkOutline(source: Buffer, outline: Awaited<ReturnType<typeof parseOutline>>) {
  if (outline.hasError) {
    throw new UnusableSyntaxTreeError("SQL source contains syntax errors", "syntax-error");
  }
  return postgresStatementDeclarations(source, outline.root);
}

export function postgresStatementDeclarations(source: Buffer, root: SyntaxNode): SyntaxNode[] {
  const incomplete = () =>
    new UnusableSyntaxTreeError(
      "Code Moniker did not provide a complete SQL statement outline",
      "truncated",
    );
  if (root.kind !== "source_file") throw incomplete();
  const tables: SyntaxNode[] = [];
  let end = 0;
  for (const node of root.children) {
    const [start, nextEnd] = node.byteRange;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(nextEnd) ||
      start < end ||
      nextEnd <= start ||
      nextEnd > source.length ||
      source.subarray(end, start).toString("utf8").trim() !== ""
    )
      throw incomplete();
    end = nextEnd;
    if (node.kind === "comment" || node.kind === ";") continue;
    if (node.kind !== "toplevel_stmt") throw incomplete();
    const statement = directSyntaxChild(node, "stmt");
    const declarations = statement?.children.filter((child) => child.kind !== "comment");
    if (declarations?.length !== 1) throw incomplete();
    tables.push(declarations[0]);
  }
  if (source.subarray(end).toString("utf8").trim() !== "") throw incomplete();
  return tables;
}

import { DEFAULT_SYNTAX_MAX_NODES } from "../../sql/src/analysis/codeMonikerSyntax.js";
