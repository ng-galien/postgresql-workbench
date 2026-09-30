import {
  assertUsableSyntaxTree,
  directSyntaxChild,
  UnusableSyntaxTreeError,
} from "../../sql/src/analysis/syntaxNodes.js";
import type { SyntaxNode, SyntaxParser } from "../../sql/src/analysis/syntaxTree.js";

export async function postgresStatementTrees(
  source: string,
  parser: SyntaxParser,
  kinds: readonly string[],
): Promise<Array<{ source: string; root: SyntaxNode; offset: number }>> {
  const outline = await parser.parse({
    language: "sql",
    source,
    maxDepth: 3,
    maxNodes: 20_000,
    namedOnly: false,
  });
  if (outline.hasError) {
    throw new UnusableSyntaxTreeError("SQL source contains syntax errors", "syntax-error");
  }
  const sourceBytes = Buffer.from(source);
  const statements = postgresStatementDeclarations(sourceBytes, outline.root).filter((node) =>
    kinds.includes(node.kind),
  );
  const trees = [];
  for (const statement of statements) {
    const offset = statement.byteRange[0];
    const tableSource = sourceBytes.subarray(offset, statement.byteRange[1]).toString("utf8");
    const tree = await parser.parse({ language: "sql", source: tableSource });
    assertUsableSyntaxTree(tree, "SQL table declaration");
    trees.push({ source: tableSource, root: tree.root, offset });
  }
  return trees;
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
