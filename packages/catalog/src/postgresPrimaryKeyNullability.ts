import {
  decodeSqlIdentifier,
  directSyntaxChild,
  findSyntaxNodes,
  syntaxNodeText,
} from "../../sql/src/analysis/syntaxNodes.js";
import type { SyntaxNode, SyntaxParser } from "../../sql/src/analysis/syntaxTree.js";
import { postgresStatementTrees } from "./postgresSyntaxStatements.js";

/** PostgreSQL materializes PRIMARY KEY columns as NOT NULL in its catalog. */
export async function explicitPrimaryKeyNullability(
  source: string,
  parser: SyntaxParser,
): Promise<string> {
  const statements = await postgresStatementTrees(source, parser, [
    "CreateStmt",
    "CreateSchemaStmt",
  ]);
  let bytes = Buffer.from(source);
  for (const statement of statements.reverse()) {
    const normalized = primaryKeyStatement(statement.source, statement.root);
    bytes = Buffer.concat([
      bytes.subarray(0, statement.offset),
      Buffer.from(normalized),
      bytes.subarray(statement.offset + Buffer.byteLength(statement.source)),
    ]);
  }
  return bytes.toString("utf8");
}

function primaryKeyStatement(source: string, root: SyntaxNode): string {
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
      const notNull = constraints.some((node) => hasKeywords(node, "kw_not", "kw_null"));
      if (!notNull && (primary || (name && primaryColumns.has(columnName(source, name))))) {
        insertions.add(column.byteRange[1]);
      }
    }
  }
  let bytes = Buffer.from(source);
  for (const offset of [...insertions].sort((left, right) => right - left)) {
    bytes = Buffer.concat([
      bytes.subarray(0, offset),
      Buffer.from("\nNOT NULL"),
      bytes.subarray(offset),
    ]);
  }
  return bytes.toString("utf8");
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
