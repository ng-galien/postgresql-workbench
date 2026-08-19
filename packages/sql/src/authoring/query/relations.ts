import { directSyntaxChild, findSyntaxNode, findSyntaxNodes } from "../../analysis/syntaxNodes.js";
import type { SyntaxNode, SyntaxParser } from "../../analysis/syntaxTree.js";
import {
  canonicalSqlIdentifier,
  splitSqlQualifiedIdentifier,
  unquoteSqlIdentifier,
} from "../identifiers.js";
import type { SqlAuthoringObject } from "../snapshot.js";
import { postgresPlpgsqlRanges } from "../sqlLexing.js";
import { byteToCharOffsets, type SqlQueryAnalysis } from "./analysis.js";

export interface DocumentRelationsOptions {
  uri: string;
  maxDepth: number;
  maxNodes: number;
  /** Offset being typed: a placeholder is inserted there so an unfinished statement parses. */
  caret?: number;
}

/**
 * Every relation a document names, including inside the PL/pgSQL body of a `DO` block — which the
 * SQL grammar sees as a dollar-quoted string, so it is parsed on its own. The single way any
 * feature learns what relations a document uses.
 */
/** What the caret is naming: a relation (after FROM, JOIN, INTO, USING) or an expression. */
export type SqlCaretRole = "relation" | "expression";

export interface DocumentMentions {
  source: string;
  relations: SqlRelationMention[];
  columns: SqlColumnMention[];
  routines: SqlRoutineMention[];
  /** Set when a caret was given: what the placeholder stands in for, read from the tree. */
  caretRole?: SqlCaretRole;
}

/** Role of the node the placeholder landed in, from its ancestors — never from the text before it. */
function caretRoleOf(
  root: SyntaxNode,
  text: string,
  charOffset: (byte: number) => number,
): SqlCaretRole | undefined {
  const placeholder = text.indexOf(CARET_PLACEHOLDER);
  if (placeholder < 0) return undefined;
  let role: SqlCaretRole | undefined;
  const visit = (node: SyntaxNode, ancestors: readonly SyntaxNode[]) => {
    const start = charOffset(node.byteRange[0]);
    const end = charOffset(node.byteRange[1]);
    if (start > placeholder || end < placeholder + CARET_PLACEHOLDER.length) return;
    if (node.children.length === 0) {
      const path = [...ancestors, node];
      role = path.some(
        (candidate) =>
          candidate.kind === "relation_expr" ||
          candidate.kind === "relation_expr_opt_alias" ||
          candidate.kind === "insert_target",
      )
        ? "relation"
        : "expression";
      return;
    }
    for (const child of node.children) visit(child, [...ancestors, node]);
  };
  visit(root, []);
  return role;
}

export async function documentRelations(
  parser: SyntaxParser,
  source: string,
  options: DocumentRelationsOptions,
): Promise<DocumentMentions> {
  const { caret, uri, maxDepth, maxNodes } = options;
  const parsed =
    caret === undefined
      ? source
      : `${source.slice(0, caret)}${CARET_PLACEHOLDER}${source.slice(caret)}`;
  const budget = { uri, maxDepth, maxNodes, namedOnly: true } as const;
  const tree = await parser.parse({ language: "sql", source: parsed, ...budget });
  if (tree.truncated) return { source: parsed, relations: [], columns: [], routines: [] };
  // Even a partially recovered tree names the relations of the statements that do parse.
  const offsets = byteToCharOffsets(parsed);
  const relations = relationMentions(tree.root, parsed, offsets);
  const columns = columnMentions(tree.root, parsed, offsets);
  const routines = routineMentions(tree.root, parsed, offsets);
  const caretRole = caret === undefined ? undefined : caretRoleOf(tree.root, parsed, offsets);
  for (const range of postgresPlpgsqlRanges(parsed)) {
    const body = parsed.slice(range.start, range.end);
    const bodyTree = await parser.parse({ language: "plpgsql", source: body, ...budget });
    if (bodyTree.truncated) continue;
    // PL/pgSQL keeps embedded SQL opaque, in `sql_expression` nodes: each is parsed as SQL.
    const bodyOffset = byteToCharOffsets(body);
    for (const expression of findSyntaxNodes(bodyTree.root, "sql_expression")) {
      const start = bodyOffset(expression.byteRange[0]);
      const statement = body.slice(start, bodyOffset(expression.byteRange[1]));
      const statementTree = await parser.parse({ language: "sql", source: statement, ...budget });
      if (statementTree.truncated) continue;
      const base = range.start + start;
      const statementOffsets = byteToCharOffsets(statement);
      relations.push(
        ...shiftRelationMentions(
          relationMentions(statementTree.root, statement, statementOffsets),
          base,
        ),
      );
      columns.push(
        ...shiftMentions(columnMentions(statementTree.root, statement, statementOffsets), base),
      );
      routines.push(
        ...shiftMentions(routineMentions(statementTree.root, statement, statementOffsets), base),
      );
    }
  }
  return {
    source: parsed,
    relations,
    columns,
    routines,
    ...(caretRole === undefined ? {} : { caretRole }),
  };
}

/** Any mention, with its name range shifted by `base`. */
function shiftMentions<T extends { nameRange: { start: number; end: number } }>(
  mentions: readonly T[],
  base: number,
): T[] {
  return mentions.map((mention) => ({
    ...mention,
    nameRange: { start: mention.nameRange.start + base, end: mention.nameRange.end + base },
  }));
}

/** The same mentions, with every offset shifted by `base`. */
export function shiftRelationMentions(
  mentions: readonly SqlRelationMention[],
  base: number,
): SqlRelationMention[] {
  return mentions.map((mention) => ({
    ...mention,
    nameRange: { start: mention.nameRange.start + base, end: mention.nameRange.end + base },
    ...(mention.aliasRange
      ? {
          aliasRange: {
            start: mention.aliasRange.start + base,
            end: mention.aliasRange.end + base,
          },
        }
      : {}),
  }));
}

/** Identifier inserted where the user is typing, so an unfinished statement still parses. */
export const CARET_PLACEHOLDER = "sql_authoring_caret";

/** A relation named by a statement, wherever it appears: FROM, JOIN, USING, UPDATE, INSERT INTO. */
export interface SqlRelationMention {
  schema?: string;
  name: string;
  alias?: string;
  /** How columns qualify it, as written: its alias, or its name. */
  reference: string;
  /** The qualified name as written, and its character range. */
  qualifiedText: string;
  nameRange: { start: number; end: number };
  /** Character range of the alias, when one is written. */
  aliasRange?: { start: number; end: number };
}

/** A column reference written in a statement, with its optional qualifier. */
export interface SqlColumnMention {
  qualifier?: string;
  name: string;
  nameRange: { start: number; end: number };
}

/** A routine called in a statement. */
export interface SqlRoutineMention {
  schema?: string;
  name: string;
  nameRange: { start: number; end: number };
}

/** Column references of a tree, from `columnref` nodes — never from the text. */
export function columnMentions(
  root: SyntaxNode,
  text: string,
  charOffset: (byte: number) => number,
): SqlColumnMention[] {
  const columns: SqlColumnMention[] = [];
  for (const reference of findSyntaxNodes(root, "columnref")) {
    const start = charOffset(reference.byteRange[0]);
    const written = text.slice(start, charOffset(reference.byteRange[1]));
    const parts = splitSqlQualifiedIdentifier(written.trim());
    const last = parts[parts.length - 1];
    if (last === undefined || last === "*") continue;
    const nameStart = start + written.lastIndexOf(last);
    columns.push({
      ...(parts.length > 1
        ? { qualifier: unquoteSqlIdentifier(parts[parts.length - 2] ?? "") }
        : {}),
      name: unquoteSqlIdentifier(last),
      nameRange: { start: nameStart, end: nameStart + last.length },
    });
  }
  return columns;
}

/** Routine calls of a tree, from `func_application` nodes. */
export function routineMentions(
  root: SyntaxNode,
  text: string,
  charOffset: (byte: number) => number,
): SqlRoutineMention[] {
  const routines: SqlRoutineMention[] = [];
  for (const call of findSyntaxNodes(root, "func_application")) {
    const nameNode = findSyntaxNode(call, "func_name");
    if (!nameNode) continue;
    const start = charOffset(nameNode.byteRange[0]);
    const written = text.slice(start, charOffset(nameNode.byteRange[1]));
    const parts = splitSqlQualifiedIdentifier(written.trim());
    const last = parts[parts.length - 1];
    if (last === undefined) continue;
    const nameStart = start + written.lastIndexOf(last);
    routines.push({
      ...(parts.length > 1 ? { schema: unquoteSqlIdentifier(parts[parts.length - 2] ?? "") } : {}),
      name: unquoteSqlIdentifier(last),
      nameRange: { start: nameStart, end: nameStart + last.length },
    });
  }
  return routines;
}

/**
 * Every relation a statement names, read from the syntax tree. Works on any statement kind —
 * SELECT, UPDATE, DELETE, INSERT — because they all carry `relation_expr` or `insert_target`.
 */
export function relationMentions(
  root: SyntaxNode,
  text: string,
  charOffset: (byte: number) => number,
): SqlRelationMention[] {
  const mentions: SqlRelationMention[] = [];
  const slice = (node: SyntaxNode) =>
    text.slice(charOffset(node.byteRange[0]), charOffset(node.byteRange[1]));
  const visit = (node: SyntaxNode, parent: SyntaxNode | undefined) => {
    if (node.kind === "relation_expr" || node.kind === "insert_target") {
      const qualified = findSyntaxNode(node, "qualified_name");
      if (qualified) {
        const written = splitSqlQualifiedIdentifier(slice(qualified).trim()).map((part) =>
          part.trim(),
        );
        const parts = written.map((part) => unquoteSqlIdentifier(part));
        const name = parts[parts.length - 1] ?? "";
        const alias = aliasOf(node, parent, slice);
        const aliasNode = aliasNodeOf(node, parent);
        mentions.push({
          ...(parts.length > 1 ? { schema: parts[parts.length - 2] } : {}),
          name,
          ...(alias === undefined ? {} : { alias: unquoteSqlIdentifier(alias) }),
          reference: alias ?? written[written.length - 1] ?? name,
          qualifiedText: text.slice(
            charOffset(qualified.byteRange[0]),
            charOffset(qualified.byteRange[1]),
          ),
          nameRange: {
            start: charOffset(qualified.byteRange[0]),
            end: charOffset(qualified.byteRange[1]),
          },
          ...(aliasNode
            ? {
                aliasRange: {
                  start: charOffset(aliasNode.byteRange[0]),
                  end: charOffset(aliasNode.byteRange[1]),
                },
              }
            : {}),
        });
      }
    }
    for (const child of node.children) visit(child, node);
  };
  visit(root, undefined);
  return mentions;
}

/** The alias clause written after a relation, on the relation itself or on the clause owning it. */
function aliasNodeOf(relation: SyntaxNode, parent: SyntaxNode | undefined): SyntaxNode | undefined {
  for (const owner of [relation, parent]) {
    if (!owner) continue;
    const clause =
      directSyntaxChild(owner, "opt_alias_clause") ?? directSyntaxChild(owner, "alias_clause");
    if (clause) return findSyntaxNode(clause, "ColId") ?? clause;
  }
  // UPDATE and DELETE targets carry their alias as a plain identifier beside the relation.
  if (parent?.kind === "relation_expr_opt_alias") return directSyntaxChild(parent, "ColId");
  return undefined;
}

/** The alias written after a relation, without its optional `AS`. */
function aliasOf(
  relation: SyntaxNode,
  parent: SyntaxNode | undefined,
  slice: (node: SyntaxNode) => string,
): string | undefined {
  const node = aliasNodeOf(relation, parent);
  return node
    ? slice(node)
        .trim()
        .replace(/^AS\s+/iu, "")
        .trim()
    : undefined;
}

/** An indexed relation of the query, with the name expressions must use to qualify its columns. */
export interface TableReference {
  correlationName: string;
  nullExtended: boolean;
  object: SqlAuthoringObject;
  reference: string;
}

/**
 * The relations of a query, resolved against the Workbench Index from the syntax tree. A relation
 * the index does not know, or knows twice, is left out: composing on it could not be checked.
 */
export function relationsFromAnalysis(
  analysis: SqlQueryAnalysis,
  objects: readonly SqlAuthoringObject[],
): TableReference[] {
  const references: TableReference[] = [];
  for (const relation of analysis.relations) {
    // A RIGHT or FULL join makes every relation already collected nullable.
    if (relation.join && /\b(?:RIGHT|FULL)\b/u.test(relation.join.type)) {
      for (const reference of references) reference.nullExtended = true;
    }
    if (relation.schema === undefined) continue;
    const schema = canonicalSqlIdentifier(relation.schema);
    const name = canonicalSqlIdentifier(relation.name);
    const candidates = objects.filter(
      (candidate) =>
        candidate.schema === schema &&
        candidate.name === name &&
        (candidate.kind === "table" || candidate.kind === "view"),
    );
    const object = candidates.length === 1 ? candidates[0] : undefined;
    if (!object) continue;
    const reference = relation.reference;
    references.push({
      correlationName: canonicalSqlIdentifier(reference),
      nullExtended: relation.join !== undefined && /\b(?:LEFT|FULL)\b/u.test(relation.join.type),
      object,
      reference,
    });
  }
  return references;
}
