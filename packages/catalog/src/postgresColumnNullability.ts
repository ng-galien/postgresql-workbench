import {
  decodeSqlIdentifier,
  directSyntaxChild,
  findSyntaxNodes,
  syntaxNodeText,
} from "../../sql/src/analysis/syntaxNodes.js";
import type { SyntaxNode, SyntaxParser } from "../../sql/src/analysis/syntaxTree.js";
import { postgresStatementTrees } from "./postgresSyntaxStatements.js";

/**
 * PostgreSQL materializes PRIMARY KEY and IDENTITY columns as NOT NULL.
 * The provider owns statement boundaries, including quoted bodies and comments;
 * a shallow projection avoids serializing every routine's AST.
 */
export async function explicitColumnNullability(
  source: string,
  parser: SyntaxParser,
): Promise<string> {
  const sourceBytes = Buffer.from(source);
  const { trees: statements } = await postgresStatementTrees(source, parser, [
    "CreateStmt",
    "CreateSchemaStmt",
  ]);
  const insertions = new Set<number>();
  for (const statement of statements) {
    for (const insertion of implicitNotNullInsertions(statement.source, statement.root)) {
      insertions.add(statement.offset + insertion);
    }
  }
  let bytes = sourceBytes;
  for (const offset of [...insertions].sort((left, right) => right - left)) {
    bytes = Buffer.concat([
      bytes.subarray(0, offset),
      Buffer.from("\nNOT NULL"),
      bytes.subarray(offset),
    ]);
  }
  return bytes.toString("utf8");
}

function implicitNotNullInsertions(source: string, root: SyntaxNode): Set<number> {
  const insertions = new Set<number>();
  for (const table of findSyntaxNodes(root, "CreateStmt")) {
    const columns = findSyntaxNodes(table, "columnDef");
    const primaryColumns = new Set<string>();
    for (const constraint of findSyntaxNodes(table, "ConstraintElem")) {
      if (!hasKeywords(constraint, "kw_primary", "kw_key")) continue;
      const list = directSyntaxChild(constraint, "columnList");
      if (!list) continue;
      for (const column of findSyntaxNodes(list, "columnElem")) {
        const name = directSyntaxChild(column, "ColId");
        if (name) primaryColumns.add(columnName(source, name));
      }
    }
    for (const column of columns) {
      const name = directSyntaxChild(column, "ColId");
      const constraints = findSyntaxNodes(column, "ColConstraintElem");
      const primary = constraints.some((node) => hasKeywords(node, "kw_primary", "kw_key"));
      const identity = constraints.some((node) => hasKeywords(node, "kw_generated", "kw_identity"));
      const notNull = constraints.some((node) => hasKeywords(node, "kw_not", "kw_null"));
      if (
        !notNull &&
        (primary || identity || (name && primaryColumns.has(columnName(source, name))))
      ) {
        insertions.add(column.byteRange[1]);
      }
    }
  }
  return insertions;
}

function columnName(source: string, node: SyntaxNode): string {
  const text = syntaxNodeText(source, node).trim();
  return text.startsWith('"')
    ? decodeSqlIdentifier(text)
    : text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function hasKeywords(node: SyntaxNode, first: string, second: string): boolean {
  return (
    directSyntaxChild(node, first) !== undefined && directSyntaxChild(node, second) !== undefined
  );
}
