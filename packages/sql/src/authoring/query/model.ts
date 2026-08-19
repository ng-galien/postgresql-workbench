import type { SyntaxParser } from "../../analysis/syntaxTree.js";
import { quoteSqlIdentifierIfNeeded } from "../completion.js";
import { unquoteSqlIdentifier } from "../identifiers.js";
import {
  analyzeSqlQuery,
  formatSqlQuery,
  removeRelation,
  reorderTargets,
  type SqlQueryAnalysis,
  type SqlQueryAnalysisBudget,
  type SqlQuerySort,
  setSort,
  setWhere,
  stripStatementTerminator,
} from "./analysis.js";

export type QueryRewrite =
  | { status: "changed"; text: string }
  | { status: "unchanged" }
  | { status: "rejected"; message: string };

/** An empty query: nothing to run until a relation is added. */
export const EMPTY_QUERY_TEXT = "";

/**
 * One SELECT statement being edited: its text, its syntax analysis, and every rewrite a grid or
 * an editor can ask for. Rewrites return new text and never touch files, webviews, or PostgreSQL.
 */
export interface SqlQueryModelOptions {
  /** Alias given to the wrapped statement when `*` has to be expanded. */
  subqueryAlias?: string;
  /** Parse budget and document URI; defaults to the SQL authoring contract. */
  budget?: () => Partial<SqlQueryAnalysisBudget>;
}

export class SqlQueryModel {
  private currentText = "";
  private currentAnalysis: SqlQueryAnalysis | undefined;
  private currentProblem: string | undefined;
  private readonly subqueryAlias: string;

  constructor(
    private readonly parser: () => Promise<SyntaxParser>,
    private readonly options: SqlQueryModelOptions = {},
  ) {
    this.subqueryAlias = options.subqueryAlias ?? "subquery";
  }

  get text(): string {
    return this.currentText;
  }

  get analysis(): SqlQueryAnalysis | undefined {
    return this.currentAnalysis;
  }

  /** Why the query could not be analyzed; grid rewrites are unavailable while set. */
  get problem(): string | undefined {
    return this.currentProblem;
  }

  get isEmpty(): boolean {
    return this.currentText.trim().length === 0;
  }

  /** Replaces the text and re-analyzes it. */
  async setText(text: string): Promise<void> {
    this.currentText = text;
    if (this.isEmpty) {
      this.currentAnalysis = undefined;
      this.currentProblem = undefined;
      return;
    }
    const analyzed = await analyzeSqlQuery(text, await this.parser(), this.options.budget?.());
    if (analyzed.status === "ok") {
      this.currentAnalysis = analyzed.analysis;
      this.currentProblem = undefined;
    } else {
      this.currentAnalysis = undefined;
      this.currentProblem = analyzed.message;
    }
  }

  /** The single statement sent to PostgreSQL, without terminator or comments-only lines. */
  effectiveSql(): string {
    const analysis = this.currentAnalysis;
    return analysis
      ? this.currentText.slice(analysis.statement.start, analysis.statement.end)
      : stripStatementTerminator(this.currentText.replace(/^--.*$/gmu, ""));
  }

  /** Text of the WHERE expression, without the keyword. */
  whereText(): string | undefined {
    const analysis = this.currentAnalysis;
    return analysis?.where
      ? this.currentText.slice(analysis.where.expressionStart, analysis.where.end)
      : undefined;
  }

  /** ORDER BY criteria, each resolved to its projected column when it names one. */
  orderBy(): { text: string; direction: "ascending" | "descending"; column?: string }[] {
    const analysis = this.currentAnalysis;
    const sortColumn = (expression: string): string | undefined =>
      analysis?.targets.find(
        (target) =>
          target.expression === expression ||
          (target.alias !== undefined && target.alias === unquoteSqlIdentifier(expression)),
      )?.label;
    return (analysis?.sortItems ?? []).map((item) => {
      const column = sortColumn(item.expression);
      return { text: item.expression, direction: item.direction, ...(column ? { column } : {}) };
    });
  }

  sorted(sorts: readonly SqlQuerySort[], tabSize: number): QueryRewrite {
    return this.rewrite((text, analysis) => setSort(text, analysis, sorts), tabSize);
  }

  filtered(where: string, tabSize: number): QueryRewrite {
    return this.rewrite((text, analysis) => setWhere(text, analysis, where), tabSize);
  }

  /** Query with one projected column moved; `*` is first expanded into the given column names. */
  async reordered(
    from: number,
    to: number,
    projectedColumns: readonly string[],
    tabSize: number,
  ): Promise<QueryRewrite> {
    let analysis = this.currentAnalysis;
    let text = this.currentText;
    if (!analysis) return { status: "rejected", message: this.rejection() };
    if (analysis.hasStar) {
      if (projectedColumns.length === 0) return { status: "unchanged" };
      if (analysis.targets.length !== 1) {
        return {
          status: "rejected",
          message: "Expand `*` into explicit columns in the query before reordering.",
        };
      }
      const expanded = `SELECT ${projectedColumns.map(quoteSqlIdentifierIfNeeded).join(", ")}\nFROM (\n${text.slice(analysis.statement.start, analysis.statement.end)}\n) AS ${quoteSqlIdentifierIfNeeded(this.subqueryAlias)}`;
      text = `${text.slice(0, analysis.statement.start)}${expanded}${text.slice(analysis.statement.end)}`;
      const reanalyzed = await analyzeSqlQuery(text, await this.parser(), this.options.budget?.());
      if (reanalyzed.status !== "ok") return { status: "rejected", message: reanalyzed.message };
      analysis = reanalyzed.analysis;
    }
    const order = analysis.targets.map((_target, index) => index);
    if (from < 0 || from >= order.length || to < 0 || to >= order.length) {
      return { status: "unchanged" };
    }
    const [moved] = order.splice(from, 1);
    if (moved === undefined) return { status: "unchanged" };
    order.splice(to, 0, moved);
    return changed(text, formatSqlQuery(reorderTargets(text, analysis, order), tabSize));
  }

  /**
   * Query with the columns of one table moved as a block next to another table's columns.
   * `columnTable[ordinal]` is the table index of each projected column; other columns keep
   * their place, so an order the user arranged by hand survives the move.
   */
  tableBlockMoved(
    columnTable: readonly (number | undefined)[],
    from: number,
    to: number,
    tabSize: number,
  ): QueryRewrite {
    const analysis = this.currentAnalysis;
    if (!analysis || analysis.hasStar) {
      return {
        status: "rejected",
        message: "Reorder columns from the grid first: the query projects `*`.",
      };
    }
    if (columnTable.length !== analysis.targets.length) {
      return {
        status: "rejected",
        message: "The projection changed; refresh before moving tables.",
      };
    }
    if (from === to) return { status: "unchanged" };
    const moving = columnTable.flatMap((owner, ordinal) => (owner === from ? [ordinal] : []));
    const remaining = columnTable.flatMap((owner, ordinal) => (owner === from ? [] : [ordinal]));
    const anchors = remaining.filter((ordinal) => columnTable[ordinal] === to);
    if (moving.length === 0 || anchors.length === 0) return { status: "unchanged" };
    const insertAt =
      from < to
        ? remaining.indexOf(anchors[anchors.length - 1] ?? -1) + 1
        : remaining.indexOf(anchors[0] ?? -1);
    const order = [...remaining.slice(0, insertAt), ...moving, ...remaining.slice(insertAt)];
    return changed(
      this.currentText,
      formatSqlQuery(reorderTargets(this.currentText, analysis, order), tabSize),
    );
  }

  /**
   * Query without the given relation (schema + name, and its projected columns given by ordinal):
   * its JOIN, columns, ORDER BY items and WHERE go away. Removing the last relation empties the query.
   */
  relationRemoved(
    relation: { schema: string; name: string },
    ownedOrdinals: readonly number[],
    tabSize: number,
  ): QueryRewrite {
    const analysis = this.currentAnalysis;
    if (!analysis) return { status: "rejected", message: this.rejection() };
    const matches = analysis.relations.filter(
      (candidate) =>
        candidate.name === relation.name &&
        (candidate.schema === undefined || candidate.schema === relation.schema),
    );
    if (matches.length !== 1 || !matches[0]) {
      return {
        status: "rejected",
        message:
          matches.length === 0
            ? `${relation.schema}.${relation.name} is not a relation of the query.`
            : `${relation.name} appears several times in the query: edit the SQL to remove one.`,
      };
    }
    const removal = removeRelation(this.currentText, analysis, matches[0], ownedOrdinals);
    if (removal.status === "rejected") return removal;
    if (removal.status === "empty") return { status: "changed", text: EMPTY_QUERY_TEXT };
    return changed(this.currentText, formatSqlQuery(removal.text, tabSize));
  }

  private rewrite(
    apply: (text: string, analysis: SqlQueryAnalysis) => string,
    tabSize: number,
  ): QueryRewrite {
    const analysis = this.currentAnalysis;
    if (!analysis) return { status: "rejected", message: this.rejection() };
    return changed(this.currentText, formatSqlQuery(apply(this.currentText, analysis), tabSize));
  }

  private rejection(): string {
    return this.currentProblem ?? "The query cannot be rewritten from the grid.";
  }
}

function changed(previous: string, next: string): QueryRewrite {
  return next === previous ? { status: "unchanged" } : { status: "changed", text: next };
}
