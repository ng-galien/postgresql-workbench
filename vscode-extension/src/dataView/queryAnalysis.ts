import { Buffer } from "node:buffer";
import { directSyntaxChild, findSyntaxNode } from "../../../src/analysis/syntaxNodes.js";
import type { SyntaxNode, SyntaxParser } from "../../../src/analysis/syntaxTree.js";
import { quoteIdentifier } from "../sqlAuthoring/completion.js";
import { formatPostgresSql } from "../sqlAuthoring/format.js";
import { splitSqlQualifiedIdentifier, unquoteSqlIdentifier } from "../sqlAuthoring/identifiers.js";
import type { DataViewSort } from "./protocol.js";

/** Character range in the query text. */
export interface TextRange {
  start: number;
  end: number;
}

export interface DataViewTarget extends TextRange {
  /** Full target text, e.g. `m.reason AS why`. */
  text: string;
  /** Expression without the alias. */
  expression: string;
  /** Output name PostgreSQL will report: alias, or the last identifier of a column reference. */
  label: string;
  alias?: string;
  isStar: boolean;
}

export interface DataViewSortItem {
  expression: string;
  direction: "ascending" | "descending";
  /** Full item text as written (expression, direction, NULLS ordering). */
  text: string;
}

/** A relation of the FROM clause and, when it was joined, the JOIN segment that brought it. */
export interface DataViewRelation {
  schema?: string;
  name: string;
  alias?: string;
  /** The `table_ref` text range (relation and alias). */
  ref: TextRange;
  /** Set when the relation is the right side of a JOIN: the whole joined_table and its left part. */
  join?: { range: TextRange; left: TextRange; qualifier: string };
}

export interface DataViewQueryAnalysis {
  /** The single top-level statement, without terminator. */
  statement: TextRange;
  relations: DataViewRelation[];
  /** The `from_list` range: base relation and every JOIN segment. */
  fromList?: TextRange;
  targetList: TextRange;
  targets: DataViewTarget[];
  where?: TextRange & { expressionStart: number };
  sort?: TextRange;
  sortItems: DataViewSortItem[];
  /** Offset where a WHERE or ORDER BY clause can be inserted (end of FROM / WHERE). */
  fromEnd: number;
  hasStar: boolean;
}

export type DataViewQueryAnalysisResult =
  | { status: "ok"; analysis: DataViewQueryAnalysis }
  | { status: "rejected"; message: string };

/**
 * Locates the projection, WHERE, and ORDER BY of the Data View query through the Code Moniker
 * syntax tree so grid interactions rewrite exactly those ranges and keep the rest of the text.
 */
export async function analyzeDataViewQuery(
  text: string,
  parser: SyntaxParser,
): Promise<DataViewQueryAnalysisResult> {
  const tree = await parser.parse({
    source: text,
    language: "sql",
    uri: "data-view.sql",
    maxDepth: 64,
    maxNodes: 20_000,
  });
  const bytes = Buffer.from(text, "utf8");
  const offset = (byte: number) => bytes.subarray(0, byte).toString("utf8").length;
  const range = (node: SyntaxNode): TextRange => ({
    start: offset(node.byteRange[0]),
    end: offset(node.byteRange[1]),
  });
  const slice = (node: SyntaxNode) =>
    text.slice(offset(node.byteRange[0]), offset(node.byteRange[1]));
  const statements = tree.root.children.filter((child) => child.kind === "toplevel_stmt");
  if (statements.length !== 1 || !statements[0]) {
    return {
      status: "rejected",
      message:
        statements.length === 0
          ? "The Data View query is empty."
          : "A Data View shows exactly one SELECT statement.",
    };
  }
  const statement = statements[0];
  if (tree.hasError || findSyntaxNode(statement, "ERROR")) {
    return { status: "rejected", message: "The Data View query has a syntax error." };
  }
  const select = directSyntaxChild(directSyntaxChild(statement, "stmt") ?? statement, "SelectStmt");
  const selectBody = select ? directSyntaxChild(select, "select_no_parens") : undefined;
  // Without ORDER BY the grammar nests simple_select directly under select_no_parens.
  const selectClause = selectBody ? directSyntaxChild(selectBody, "select_clause") : undefined;
  const simple =
    (selectBody ? directSyntaxChild(selectBody, "simple_select") : undefined) ??
    (selectClause ? directSyntaxChild(selectClause, "simple_select") : undefined);
  if (!select || !selectBody || !simple) {
    return { status: "rejected", message: "A Data View query must be a plain SELECT statement." };
  }
  const targetListNode = directSyntaxChild(simple, "opt_target_list");
  const fromClause = directSyntaxChild(simple, "from_clause");
  if (!targetListNode || !fromClause) {
    return {
      status: "rejected",
      message: "A Data View query needs a SELECT list and a FROM clause.",
    };
  }
  const targets = collectItems(targetListNode, "target_list", "target_el").map(
    (node): DataViewTarget => {
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
      };
    },
  );
  const relations: DataViewRelation[] = [];
  const relationOf = (tableRef: SyntaxNode, join?: DataViewRelation["join"]) => {
    const relationExpr = directSyntaxChild(tableRef, "relation_expr");
    const qualified = relationExpr ? findSyntaxNode(relationExpr, "qualified_name") : undefined;
    if (!qualified) return;
    const parts = splitSqlQualifiedIdentifier(slice(qualified).trim()).map((part) =>
      unquoteSqlIdentifier(part.trim()),
    );
    const aliasNode = directSyntaxChild(tableRef, "opt_alias_clause");
    const alias = aliasNode
      ? unquoteSqlIdentifier(
          slice(aliasNode)
            .trim()
            .replace(/^AS\s+/iu, "")
            .trim(),
        )
      : undefined;
    const name = parts[parts.length - 1] ?? "";
    relations.push({
      ...(parts.length > 1 ? { schema: parts[parts.length - 2] } : {}),
      name,
      ...(alias ? { alias } : {}),
      ref: range(tableRef),
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
    // The right side is a plain relation (a parenthesized sub-join is not a Data View shape).
    if (directSyntaxChild(right, "relation_expr")) {
      const qual = directSyntaxChild(joined, "join_qual");
      relationOf(right, {
        range: range(joined),
        left: range(left),
        qualifier: qual ? slice(qual) : "",
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
    ? collectItems(sortNode, "sortby_list", "sortby").map((node): DataViewSortItem => {
        const expression = node.children.find((child) => child.kind === "a_expr");
        const direction = directSyntaxChild(node, "opt_asc_desc");
        return {
          expression: expression ? slice(expression).trim() : slice(node).trim(),
          direction: direction && /desc/iu.test(slice(direction)) ? "descending" : "ascending",
          text: slice(node).trim(),
        };
      })
    : [];
  const statementRange = range(statement);
  const statementText = text.slice(statementRange.start, statementRange.end);
  const terminator = /[\s;]+$/u.exec(statementText)?.[0].length ?? 0;
  return {
    status: "ok",
    analysis: {
      statement: { start: statementRange.start, end: statementRange.end - terminator },
      relations,
      ...(fromList ? { fromList: range(fromList) } : {}),
      targetList: range(targetListNode),
      targets,
      ...(whereNode && whereExpression
        ? { where: { ...range(whereNode), expressionStart: range(whereExpression).start } }
        : {}),
      ...(sortNode ? { sort: range(sortNode) } : {}),
      sortItems,
      fromEnd: whereNode ? range(whereNode).end : range(fromClause).end,
      hasStar: targets.some((target) => target.isStar),
    },
  };
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
  analysis: DataViewQueryAnalysis,
  order: readonly number[],
): string {
  const parts = order.map((index) => analysis.targets[index]?.text ?? "").filter(Boolean);
  return replaceRange(text, analysis.targetList, parts.join(", "));
}

/** Replaces the ORDER BY with the given grid-column sorts, in order (empty removes it). */
export function setSort(
  text: string,
  analysis: DataViewQueryAnalysis,
  sorts: readonly DataViewSort[],
): string {
  const items = sorts.flatMap((sort) => {
    const target = analysis.targets.find((candidate) => candidate.label === sort.column);
    if (!target) return [];
    const expression = target.alias ? quoteIdentifier(target.alias) : target.expression;
    return [
      `${expression} ${sort.direction === "descending" ? "DESC NULLS LAST" : "ASC NULLS FIRST"}`,
    ];
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
export function setWhere(
  text: string,
  analysis: DataViewQueryAnalysis,
  expression: string,
): string {
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
export function formatDataViewQuery(text: string, tabSize = 2): string {
  return formatPostgresSql(text, tabSize).replace(/;\s*$/u, "").trimEnd();
}

export type RelationRemoval =
  | { status: "removed"; text: string; alsoRemoved: string[] }
  | { status: "empty" }
  | { status: "rejected"; message: string };

/**
 * Removes one relation from the query with everything that depended on it: its JOIN segment,
 * the JOINs whose condition referenced it (cascade), the projected columns, ORDER BY items and
 * WHERE that referenced any of them. Removing the last relation empties the query; removing the
 * base relation while others are joined is refused.
 */
export function removeRelation(
  text: string,
  analysis: DataViewQueryAnalysis,
  relation: DataViewRelation,
  ownedOrdinals: readonly number[],
): RelationRemoval {
  if (!relation.join) {
    if (analysis.relations.length > 1) {
      return {
        status: "rejected",
        message: `${relation.name} is the base relation of the query: remove the joined tables first.`,
      };
    }
    return { status: "empty" };
  }
  if (!analysis.fromList)
    return { status: "rejected", message: "The FROM clause cannot be rewritten." };
  const prefixesOf = (candidate: DataViewRelation) =>
    [candidate.alias, candidate.name]
      .filter((value): value is string => value !== undefined)
      .flatMap((value) => [`${value}.`, `${quoteIdentifier(value)}.`]);
  const referencesAny = (expression: string, prefixes: readonly string[]) =>
    prefixes.some(
      (prefix) =>
        expression.startsWith(prefix) ||
        expression.includes(` ${prefix}`) ||
        expression.includes(`(${prefix}`) ||
        expression.includes(`\n${prefix}`),
    );
  // Cascade: a joined relation whose ON condition mentions a removed relation goes too.
  const removed = new Set<DataViewRelation>([relation]);
  let grew = true;
  while (grew) {
    grew = false;
    const prefixes = [...removed].flatMap(prefixesOf);
    for (const candidate of analysis.relations) {
      if (removed.has(candidate) || !candidate.join) continue;
      if (referencesAny(candidate.join.qualifier, prefixes)) {
        removed.add(candidate);
        grew = true;
      }
    }
  }
  const prefixes = [...removed].flatMap(prefixesOf);
  const owned = new Set(ownedOrdinals);
  const keptTargets = analysis.targets.filter(
    (target, ordinal) => !owned.has(ordinal) && !referencesAny(target.expression, prefixes),
  );
  const keptSort = analysis.sortItems.filter((item) => !referencesAny(item.expression, prefixes));
  const base = analysis.relations.find((candidate) => !candidate.join);
  if (!base) return { status: "rejected", message: "The FROM clause cannot be rewritten." };
  const fromList = `${text.slice(base.ref.start, base.ref.end)}${analysis.relations
    .filter((candidate) => candidate.join && !removed.has(candidate))
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
  if (
    analysis.where &&
    referencesAny(text.slice(analysis.where.expressionStart, analysis.where.end), prefixes)
  ) {
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
