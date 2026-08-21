import { Buffer } from "node:buffer";
import { directSyntaxChild, findSyntaxNode, findSyntaxNodes } from "../analysis/syntaxNodes.js";
import type { SyntaxNode, SyntaxParser } from "../analysis/syntaxTree.js";
import { formatPostgresSql } from "../text/format.js";
import {
  canonicalSqlIdentifier,
  quoteSqlIdentifierIfNeeded,
  splitSqlQualifiedIdentifier,
  unquoteSqlIdentifier,
} from "../text/identifiers.js";
import { type SqlQueryShape, sqlQueryShape } from "./shape.js";

/** Removes trailing statement terminators so the SQL can be used as a subquery. */
export function stripStatementTerminator(sql: string): string {
  return sql.trim().replace(/[\s;]+$/u, "");
}

/** Where NULLs go within a criterion; absent means wherever PostgreSQL puts them. */
export type SqlNullsOrder = "first" | "last";

/** One ORDER BY criterion expressed on a projected column. */
export interface SqlQuerySort {
  column: string;
  direction: "ascending" | "descending";
  /** Written out only when it differs from what PostgreSQL would do on its own. */
  nulls?: SqlNullsOrder;
}

/** Character range in the query text. */
export interface TextRange {
  start: number;
  end: number;
}

export interface SqlQueryTarget extends TextRange {
  /** Full target text, e.g. `m.reason AS why`. */
  text: string;
  /** Expression without the alias. */
  expression: string;
  /** Output name PostgreSQL will report: alias, or the last identifier of a column reference. */
  label: string;
  alias?: string;
  isStar: boolean;
  /** The expression calls a function (aggregate or not): projecting beside it is not safe. */
  callsFunction: boolean;
  /** Relations this target names, from its column references (never from its text). */
  qualifiers: string[];
}

export interface SqlQuerySortItem {
  expression: string;
  direction: "ascending" | "descending";
  /** The NULLS ordering as written; absent when the criterion leaves it to PostgreSQL. */
  nulls?: SqlNullsOrder;
  /** Full item text as written (expression, direction, NULLS ordering). */
  text: string;
  /** Relations this criterion names, from its column references. */
  qualifiers: string[];
}

/** A relation of the FROM clause and, when it was joined, the JOIN segment that brought it. */
export interface SqlQueryRelation {
  schema?: string;
  name: string;
  /**
   * The name and schema as PostgreSQL stores them: what was quoted keeps its case, what was not is
   * folded. Computed from the text as written, so it must never be canonicalised a second time.
   */
  catalogName: string;
  catalogSchema?: string;
  alias?: string;
  /** The `table_ref` text range (relation and alias). */
  ref: TextRange;
  /**
   * How expressions qualify this relation, as written: its alias, or its name. Quoting is kept,
   * so the value can be used directly to build a qualified column reference.
   */
  reference: string;
  /** Set when the relation is the right side of a JOIN: the whole joined_table and its left part. */
  join?: {
    range: TextRange;
    left: TextRange;
    /** Relations the ON condition names, from its column references. */
    qualifiers: string[];
    /** Join type as written (`LEFT`, `RIGHT OUTER`, …); empty for a plain JOIN. */
    type: string;
  };
}

export interface SqlQueryAnalysis {
  /** The single top-level statement, without terminator. */
  statement: TextRange;
  relations: SqlQueryRelation[];
  /** The `from_list` range: base relation and every JOIN segment. */
  fromList?: TextRange;
  targetList: TextRange;
  targets: SqlQueryTarget[];
  where?: TextRange & { expressionStart: number; qualifiers: string[] };
  sort?: TextRange;
  sortItems: SqlQuerySortItem[];
  /** Set when the projection is DISTINCT; `on` distinguishes `DISTINCT ON (…)`. */
  distinct?: { on: boolean };
  /** GROUP BY or HAVING: the projection is constrained and must not gain columns. */
  grouped: boolean;
  /** Offset where a WHERE or ORDER BY clause can be inserted (end of FROM / WHERE). */
  fromEnd: number;
  hasStar: boolean;
}

/** Why a statement cannot be analyzed; the consumer words it for its own surface. */
export type SqlQueryRejection =
  | "empty"
  | "multiple-statements"
  | "syntax-error"
  | "syntax-budget"
  | "not-select"
  | "no-from";

export type SqlQueryAnalysisResult =
  | { status: "ok"; analysis: SqlQueryAnalysis; shape: SqlQueryShape }
  | { status: "rejected"; reason: SqlQueryRejection; message: string; shape?: SqlQueryShape };

const REJECTION_MESSAGES: Record<SqlQueryRejection, string> = {
  empty: "The query is empty.",
  "multiple-statements": "The grid shows exactly one SELECT statement.",
  "syntax-error": "The query has a syntax error.",
  "syntax-budget": "The query is too large to analyze.",
  "not-select": "The grid needs a plain SELECT statement.",
  "no-from": "The query needs a SELECT list and a FROM clause.",
};

function rejected(reason: SqlQueryRejection, shape?: SqlQueryShape): SqlQueryAnalysisResult {
  return {
    status: "rejected",
    reason,
    message: REJECTION_MESSAGES[reason],
    ...(shape === undefined ? {} : { shape }),
  };
}

/** Budget of one analysis; defaults to the SQL authoring contract. */
export interface SqlQueryAnalysisBudget {
  maxDepth: number;
  maxNodes: number;
  /** Parsed document; the parser keys on it, so a real document URI is preferable. */
  uri: string;
}

const DEFAULT_BUDGET: SqlQueryAnalysisBudget = {
  maxDepth: 1_024,
  maxNodes: 100_000,
  uri: "sql-query.sql",
};

/**
 * Locates the projection, WHERE, and ORDER BY of a SELECT statement through the Code Moniker
 * syntax tree, so a consumer rewrites exactly those ranges and keeps the rest of the text.
 */
export async function analyzeSqlQuery(
  text: string,
  parser: SyntaxParser,
  budget: Partial<SqlQueryAnalysisBudget> = {},
): Promise<SqlQueryAnalysisResult> {
  const { maxDepth, maxNodes, uri } = { ...DEFAULT_BUDGET, ...budget };
  const tree = await parser.parse({ source: text, language: "sql", uri, maxDepth, maxNodes });
  // A clipped tree yields ranges computed from a partial parse: rewriting on it would corrupt SQL.
  if (tree.truncated) return rejected("syntax-budget");
  const shape = sqlQueryShape(tree.root);
  const offset = byteToCharOffsets(text);
  const range = (node: SyntaxNode): TextRange => ({
    start: offset(node.byteRange[0]),
    end: offset(node.byteRange[1]),
  });
  const slice = (node: SyntaxNode) =>
    text.slice(offset(node.byteRange[0]), offset(node.byteRange[1]));
  /**
   * Relations named by the column references of a subtree. Reading `columnref` nodes is what
   * separates a real reference from an identifier that merely occurs in a literal or a comment.
   */
  const qualifiersIn = (node: SyntaxNode | undefined): string[] => {
    if (!node) return [];
    const found = new Set<string>();
    for (const reference of findSyntaxNodes(node, "columnref")) {
      const parts = splitSqlQualifiedIdentifier(slice(reference).trim());
      for (const part of parts.slice(0, -1)) found.add(unquoteSqlIdentifier(part.trim()));
    }
    return [...found];
  };
  const statements = tree.root.children.filter((child) => child.kind === "toplevel_stmt");
  if (statements.length !== 1 || !statements[0]) {
    return rejected(statements.length === 0 ? "empty" : "multiple-statements", shape);
  }
  const statement = statements[0];
  if (tree.hasError || findSyntaxNode(statement, "ERROR")) {
    return rejected("syntax-error", shape);
  }
  const select = directSyntaxChild(directSyntaxChild(statement, "stmt") ?? statement, "SelectStmt");
  const selectBody = select ? directSyntaxChild(select, "select_no_parens") : undefined;
  // Without ORDER BY the grammar nests simple_select directly under select_no_parens.
  const selectClause = selectBody ? directSyntaxChild(selectBody, "select_clause") : undefined;
  const simple =
    (selectBody ? directSyntaxChild(selectBody, "simple_select") : undefined) ??
    (selectClause ? directSyntaxChild(selectClause, "simple_select") : undefined);
  if (!select || !selectBody || !simple) {
    return rejected("not-select", shape);
  }
  // With DISTINCT the grammar puts target_list directly under simple_select.
  const targetListNode =
    directSyntaxChild(simple, "opt_target_list") ?? directSyntaxChild(simple, "target_list");
  const distinctNode = directSyntaxChild(simple, "distinct_clause");
  const grouped =
    directSyntaxChild(simple, "group_clause") !== undefined ||
    directSyntaxChild(simple, "having_clause") !== undefined;
  const fromClause = directSyntaxChild(simple, "from_clause");
  if (!targetListNode || !fromClause) {
    return rejected("no-from", shape);
  }
  const targets = collectItems(targetListNode, "target_list", "target_el").map(
    (node): SqlQueryTarget => {
      const label = directSyntaxChild(node, "ColLabel");
      const expression = node.children.find((child) => child.kind === "a_expr");
      const expressionText = expression ? slice(expression).trim() : slice(node).trim();
      const alias = label ? unquoteSqlIdentifier(slice(label).trim()) : undefined;
      return {
        ...range(node),
        text: slice(node).trim(),
        expression: expressionText,
        label: alias ?? outputLabel(expressionText),
        ...(alias !== undefined ? { alias } : {}),
        isStar: /^(?:[\w"$.]+\.)?\*$/u.test(expressionText),
        qualifiers: qualifiersIn(expression ?? node),
        callsFunction:
          expression !== undefined && findSyntaxNodes(expression, "func_application").length > 0,
      };
    },
  );
  const relations: SqlQueryRelation[] = [];
  const relationOf = (tableRef: SyntaxNode, join?: SqlQueryRelation["join"]) => {
    const relationExpr = directSyntaxChild(tableRef, "relation_expr");
    const qualified = relationExpr ? findSyntaxNode(relationExpr, "qualified_name") : undefined;
    if (!qualified) return;
    const written = splitSqlQualifiedIdentifier(slice(qualified).trim()).map((part) => part.trim());
    const parts = written.map((part) => unquoteSqlIdentifier(part));
    const catalogParts = written.map((part) => canonicalSqlIdentifier(part));
    const aliasNode = directSyntaxChild(tableRef, "opt_alias_clause");
    const writtenAlias = aliasNode
      ? slice(aliasNode)
          .trim()
          .replace(/^AS\s+/iu, "")
          .trim()
      : undefined;
    const alias = writtenAlias ? unquoteSqlIdentifier(writtenAlias) : undefined;
    const name = parts[parts.length - 1] ?? "";
    relations.push({
      ...(parts.length > 1 ? { schema: parts[parts.length - 2] } : {}),
      name,
      catalogName: catalogParts[catalogParts.length - 1] ?? "",
      ...(catalogParts.length > 1 ? { catalogSchema: catalogParts[catalogParts.length - 2] } : {}),
      ...(alias ? { alias } : {}),
      ref: range(tableRef),
      reference: writtenAlias || (written[written.length - 1] ?? name),
      ...(join ? { join } : {}),
    });
  };
  const walkTableRef = (tableRef: SyntaxNode) => {
    const joined = directSyntaxChild(tableRef, "joined_table");
    if (!joined) {
      relationOf(tableRef);
      return;
    }
    const refs = joined.children.filter((child) => child.kind === "table_ref");
    const left = refs[0];
    const right = refs[refs.length - 1];
    if (!left || !right || left === right) return;
    walkTableRef(left);
    // The right side is a plain relation (a parenthesized sub-join is not a supported shape).
    if (directSyntaxChild(right, "relation_expr")) {
      const qual = directSyntaxChild(joined, "join_qual");
      const joinType = directSyntaxChild(joined, "join_type");
      relationOf(right, {
        range: range(joined),
        left: range(left),
        qualifiers: qualifiersIn(qual),
        type: joinType ? slice(joinType).trim().toUpperCase() : "",
      });
    } else {
      walkTableRef(right);
    }
  };
  const fromList = directSyntaxChild(fromClause, "from_list");
  for (const child of fromList?.children ?? []) {
    if (child.kind === "table_ref") walkTableRef(child);
  }
  const whereNode = directSyntaxChild(simple, "where_clause");
  const whereExpression = whereNode?.children.find((child) => child.kind === "a_expr");
  const sortNode = directSyntaxChild(selectBody, "sort_clause");
  const sortItems = sortNode
    ? collectItems(sortNode, "sortby_list", "sortby").map((node): SqlQuerySortItem => {
        const expression = node.children.find((child) => child.kind === "a_expr");
        const direction = directSyntaxChild(node, "opt_asc_desc");
        const nulls = directSyntaxChild(node, "opt_nulls_order");
        const written = nulls ? slice(nulls) : "";
        return {
          expression: expression ? slice(expression).trim() : slice(node).trim(),
          direction: direction && /desc/iu.test(slice(direction)) ? "descending" : "ascending",
          ...(/first/iu.test(written)
            ? { nulls: "first" as const }
            : /last/iu.test(written)
              ? { nulls: "last" as const }
              : {}),
          text: slice(node).trim(),
          qualifiers: qualifiersIn(expression ?? node),
        };
      })
    : [];
  const statementRange = range(statement);
  const statementText = text.slice(statementRange.start, statementRange.end);
  const terminator = /[\s;]+$/u.exec(statementText)?.[0].length ?? 0;
  return {
    status: "ok",
    shape,
    analysis: {
      statement: { start: statementRange.start, end: statementRange.end - terminator },
      relations,
      ...(fromList ? { fromList: range(fromList) } : {}),
      targetList: range(targetListNode),
      targets,
      ...(whereNode && whereExpression
        ? {
            where: {
              ...range(whereNode),
              expressionStart: range(whereExpression).start,
              qualifiers: qualifiersIn(whereExpression),
            },
          }
        : {}),
      ...(sortNode ? { sort: range(sortNode) } : {}),
      sortItems,
      ...(distinctNode ? { distinct: { on: /\bON\b/iu.test(slice(distinctNode)) } } : {}),
      grouped,
      fromEnd: whereNode ? range(whereNode).end : range(fromClause).end,
      hasStar: targets.some((target) => target.isStar),
    },
  };
}

/**
 * How the removed relations can be named in a column reference: their alias, or their name when
 * unaliased. Folded like PostgreSQL folds an unquoted identifier.
 */
function removedNames(removed: ReadonlySet<SqlQueryRelation>): Set<string> {
  return new Set([...removed].map((relation) => (relation.alias ?? relation.name).toLowerCase()));
}

/** Byte offset to character offset in one pass, so every node range is an O(1) lookup. */
export function byteToCharOffsets(text: string): (byte: number) => number {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes === text.length) return (byte) => byte;
  const characters = new Uint32Array(bytes + 1);
  let byte = 0;
  let index = 0;
  // By code point: a character outside the BMP is two UTF-16 units but one UTF-8 sequence.
  for (const character of text) {
    const width = Buffer.byteLength(character, "utf8");
    for (let step = 0; step < width; step += 1) characters[byte + step] = index;
    byte += width;
    index += character.length;
  }
  characters[bytes] = text.length;
  return (position) => characters[Math.max(0, Math.min(bytes, position))] ?? text.length;
}

/** Items of a left-recursive list node, without descending into nested expressions. */
function collectItems(node: SyntaxNode, listKind: string, itemKind: string): SyntaxNode[] {
  const items: SyntaxNode[] = [];
  const visit = (current: SyntaxNode) => {
    for (const child of current.children) {
      if (child.kind === itemKind) items.push(child);
      else if (child.kind === listKind) visit(child);
    }
  };
  if (node.kind === itemKind) return [node];
  visit(node);
  return items;
}

function outputLabel(expression: string): string {
  if (/^[\w$]+\s*\(/u.test(expression)) return /^([\w$]+)/u.exec(expression)?.[1] ?? "?column?";
  const parts = splitSqlQualifiedIdentifier(expression);
  return unquoteSqlIdentifier(parts[parts.length - 1] ?? expression);
}

function replaceRange(text: string, range: TextRange, replacement: string): string {
  return `${text.slice(0, range.start)}${replacement}${text.slice(range.end)}`;
}

/** Rewrites the SELECT list in the given target order (indexes into `analysis.targets`). */
export function reorderTargets(
  text: string,
  analysis: SqlQueryAnalysis,
  order: readonly number[],
): string {
  const parts = order.map((index) => analysis.targets[index]?.text ?? "").filter(Boolean);
  return replaceRange(text, analysis.targetList, parts.join(", "));
}

/** Replaces the ORDER BY with the given grid-column sorts, in order (empty removes it). */
export function setSort(
  text: string,
  analysis: SqlQueryAnalysis,
  sorts: readonly SqlQuerySort[],
): string {
  const items = sorts.flatMap((sort) => {
    const target = analysis.targets.find((candidate) => candidate.label === sort.column);
    if (!target) return [];
    const expression = target.alias ? quoteSqlIdentifierIfNeeded(target.alias) : target.expression;
    /*
     * A NULLS ordering is written when the criterion carries one, and not otherwise. Whether one
     * is worth writing — whether it differs from what PostgreSQL would do anyway — is not this
     * function's to judge: it composes what it is handed.
     */
    const direction = sort.direction === "descending" ? "DESC" : "ASC";
    const nulls = sort.nulls ? ` NULLS ${sort.nulls.toUpperCase()}` : "";
    return [`${expression} ${direction}${nulls}`];
  });
  const clause = items.length > 0 ? `ORDER BY ${items.join(", ")}` : "";
  if (analysis.sort) {
    const before = text.slice(0, analysis.sort.start).replace(/\s+$/u, "");
    const after = text.slice(analysis.sort.end);
    return clause ? `${before}\n${clause}${after}` : `${before}${after}`;
  }
  if (!clause) return text;
  return `${text.slice(0, analysis.fromEnd)}\n${clause}${text.slice(analysis.fromEnd)}`;
}

/** Sets, replaces, or removes the WHERE clause (an empty expression removes it). */
export function setWhere(text: string, analysis: SqlQueryAnalysis, expression: string): string {
  const condition = expression.trim();
  if (analysis.where) {
    const before = text.slice(0, analysis.where.start).replace(/\s+$/u, "");
    const after = text.slice(analysis.where.end);
    return condition ? `${before}\nWHERE ${condition}${after}` : `${before}${after}`;
  }
  if (!condition) return text;
  return `${text.slice(0, analysis.fromEnd)}\nWHERE ${condition}${text.slice(analysis.fromEnd)}`;
}

/** Formats a rewritten query with the SQL authoring formatter, without a trailing terminator. */
export function formatSqlQuery(text: string, tabSize = 2): string {
  return stripStatementTerminator(formatPostgresSql(text, tabSize));
}

export type RelationRemoval =
  | { status: "removed"; text: string; alsoRemoved: string[] }
  | { status: "empty" }
  | { status: "rejected"; message: string };

/**
 * Removes one relation from the query with everything that depended on it: its JOIN segment,
 * the JOINs whose condition referenced it (cascade), the projected columns, ORDER BY items and
 * WHERE that referenced any of them. Removing the base relation promotes the first joined one in
 * its place, and a query left carrying nothing is empty.
 */
export function removeRelation(
  text: string,
  analysis: SqlQueryAnalysis,
  relation: SqlQueryRelation,
  ownedOrdinals: readonly number[],
): RelationRemoval {
  if (!relation.join && analysis.relations.length === 1) return { status: "empty" };
  if (!analysis.fromList)
    return { status: "rejected", message: "The FROM clause cannot be rewritten." };
  /**
   * Removing the base relation promotes the first joined one in its place. Which relation the FROM
   * clause happens to start with is an artefact of the order they were composed, not something the
   * reader chose, so it cannot be the one relation they may never remove. The promoted relation
   * loses its ON condition — it had joined what is going away — and keeps whatever joined to it.
   */
  const promoted = relation.join
    ? undefined
    : analysis.relations.find((candidate) => candidate.join !== undefined);
  const referencesAny = (qualifiers: readonly string[], names: ReadonlySet<string>) =>
    qualifiers.some((qualifier) => names.has(qualifier.toLowerCase()));
  // Cascade: a joined relation whose ON condition references a removed relation goes too.
  const removed = new Set<SqlQueryRelation>([relation]);
  let grew = true;
  while (grew) {
    grew = false;
    const names = removedNames(removed);
    for (const candidate of analysis.relations) {
      if (candidate === promoted || removed.has(candidate) || !candidate.join) continue;
      if (referencesAny(candidate.join.qualifiers, names)) {
        removed.add(candidate);
        grew = true;
      }
    }
  }
  const owned = new Set(ownedOrdinals);
  const reference = (candidate: SqlQueryRelation) => candidate.reference.toLowerCase();
  /**
   * A relation no column, filter or sort names is only in the query to carry a JOIN — the mapping
   * table the engine crossed to reach something the reader asked for. It has no badge, so a reader
   * can neither see it nor take it away: it must leave with the last relation that leant on it,
   * or the query keeps a table nobody asked for and nothing can remove. What is load-bearing is
   * therefore grown outwards from what the query still shows, never guessed from the FROM order.
   */
  if (!analysis.hasStar) {
    const gone = removedNames(removed);
    const carried = new Set<string>();
    /** What a clause still names, once the relations going away are discounted. */
    const carry = (qualifiers: readonly string[]) => {
      if (referencesAny(qualifiers, gone)) return;
      for (const qualifier of qualifiers) carried.add(qualifier.toLowerCase());
    };
    analysis.targets.forEach((target, ordinal) => {
      if (!owned.has(ordinal)) carry(target.qualifiers);
    });
    for (const item of analysis.sortItems) carry(item.qualifiers);
    if (analysis.where) carry(analysis.where.qualifiers);
    const load = new Set(
      analysis.relations.filter(
        (candidate) => !removed.has(candidate) && carried.has(reference(candidate)),
      ),
    );
    // Iterating a Set visits what is appended while iterating, so this single pass grows the
    // load-bearing set to its own closure.
    for (const candidate of load) {
      for (const qualifier of candidate.join?.qualifiers ?? []) {
        const carrier = analysis.relations.find(
          (other) => !removed.has(other) && reference(other) === qualifier.toLowerCase(),
        );
        if (carrier) load.add(carrier);
      }
    }
    for (const candidate of analysis.relations) {
      if (!load.has(candidate)) removed.add(candidate);
    }
  }
  const kept = analysis.relations.filter((candidate) => !removed.has(candidate));
  // Nothing the query showed survives the removal: the reader is back to an empty query.
  if (kept.length === 0) return { status: "empty" };
  const names = removedNames(removed);
  const keptTargets = analysis.targets.filter(
    (target, ordinal) => !owned.has(ordinal) && !referencesAny(target.qualifiers, names),
  );
  const keptSort = analysis.sortItems.filter((item) => !referencesAny(item.qualifiers, names));
  const [base, ...joined] = kept as [SqlQueryRelation, ...SqlQueryRelation[]];
  const fromList = `${text.slice(base.ref.start, base.ref.end)}${joined
    .map((candidate) =>
      candidate.join ? text.slice(candidate.join.left.end, candidate.join.range.end) : "",
    )
    .join("")}`;
  const edits: Array<{ range: TextRange; replacement: string }> = [
    { range: analysis.fromList, replacement: fromList },
    {
      range: analysis.targetList,
      replacement:
        keptTargets.length > 0 ? keptTargets.map((target) => target.text).join(", ") : "*",
    },
  ];
  if (analysis.sort && keptSort.length !== analysis.sortItems.length) {
    edits.push({
      range: analysis.sort,
      replacement:
        keptSort.length > 0 ? `ORDER BY ${keptSort.map((item) => item.text).join(", ")}` : "",
    });
  }
  if (analysis.where && referencesAny(analysis.where.qualifiers, names)) {
    edits.push({ range: analysis.where, replacement: "" });
  }
  let result = text;
  for (const edit of edits.sort((a, b) => b.range.start - a.range.start)) {
    result = replaceRange(result, edit.range, edit.replacement);
  }
  return {
    status: "removed",
    text: result,
    alsoRemoved: [...removed].filter((candidate) => candidate !== relation).map((c) => c.name),
  };
}
