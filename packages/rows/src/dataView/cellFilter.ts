import { quoteSqlIdentifierIfNeeded } from "../../../sql/src/text/identifiers.js";
import { quoteSqlLiteral } from "../../../sql/src/text/literals.js";
import type { DataViewProjection } from "./dataView.js";
import { baseTypeName, valueEditorForType } from "./editability.js";

/**
 * Types PostgreSQL has no equality for, or none worth offering: comparing them would fail, or
 * would compare something other than what the reader pointed at. `jsonb` is not among them — it
 * has an equality operator, and `json` does not.
 */
const NOT_COMPARED = new Set([
  "json",
  "xml",
  "bytea",
  "point",
  "line",
  "lseg",
  "box",
  "path",
  "polygon",
  "circle",
]);

/**
 * A relation of the query, as far as this needs it: what it is in the catalogue, and how the
 * query's own expressions name it. Both the analysis and the syntax mentions say this much.
 */
export interface NamedRelation {
  catalogSchema?: string;
  catalogName: string;
  reference: string;
}

export interface CellColumn {
  name: string;
  typeName?: string;
  /** Index in the projection's tables, or undefined for a value the query computes. */
  tableIndex: number | undefined;
}

/**
 * The condition a reader means when they point at a cell and ask to filter on its value.
 *
 * It is written the way they would have written it: the relation named as the query names it, the
 * column as PostgreSQL spells it, the value as a literal — and `IS NULL` for a NULL, because
 * `= NULL` is never true and a reader asking for the empty cells means the empty ones.
 *
 * Where the value cannot stand for itself the answer is a refusal with its reason, not a condition
 * that would fail against the database: the reader is told before the query is run, not after.
 */
/**
 * Why a cell's value cannot be filtered on, when it cannot — for a menu to say instead of offering
 * the action and letting the answer come back as a refusal. Only what the view can see for itself:
 * whether the query still names the table is the host's to know.
 */
export function whyNotFiltered(column: CellColumn): string | undefined {
  if (column.tableIndex === undefined) return COMPUTED;
  if (NOT_COMPARED.has(baseTypeName(column.typeName ?? ""))) {
    return `A ${column.typeName} value is not compared here.`;
  }
  return undefined;
}

const COMPUTED = "This value is computed; it does not come from one stored column.";

export function conditionFromCell(options: {
  column: CellColumn;
  projection: DataViewProjection;
  relations: readonly NamedRelation[];
  value: string | null;
  negate: boolean;
}): { condition: string } | { refused: string } {
  const { column, projection, relations, value, negate } = options;
  const refused = whyNotFiltered(column);
  if (refused !== undefined) return { refused };
  const table = projection.tables[column.tableIndex ?? -1];
  if (!table) return { refused: COMPUTED };
  const reference = relations.find(
    (relation) => relation.catalogSchema === table.schema && relation.catalogName === table.name,
  )?.reference;
  if (reference === undefined) return { refused: "The query no longer names that table." };
  const named = `${quoteSqlIdentifierIfNeeded(reference)}.${quoteSqlIdentifierIfNeeded(column.name)}`;
  if (value === null) return { condition: `${named} IS ${negate ? "NOT " : ""}NULL` };
  return { condition: `${named} ${negate ? "<>" : "="} ${written(value, column.typeName)}` };
}

/** Adds a condition to one already in the WHERE, which is what a second filter means. */
export function withCondition(where: string, condition: string): string {
  return where.trim() ? `${where.trim()}\n  AND ${condition}` : condition;
}

/** A number and a boolean stand for themselves; everything else is written as a literal. */
function written(value: string, typeName: string | undefined): string {
  const editor = valueEditorForType(typeName ?? "");
  return editor === "number" || editor === "boolean" ? value : quoteSqlLiteral(value);
}

/**
 * The condition a cell of a loaded result stands for: what both hosts answer a reader's `Filter`
 * with. They differ in how they hold the result and the query; what a cell means does not.
 */
export function conditionForCell(options: {
  columns: readonly { name: string; typeName?: string }[] | undefined;
  projection: DataViewProjection;
  relations: readonly NamedRelation[] | undefined;
  ordinal: number;
  value: string | null;
  negate: boolean;
}): { condition: string } | { refused: string } {
  const column = options.columns?.[options.ordinal];
  if (!column || !options.relations) return { refused: "The rows are no longer loaded." };
  return conditionFromCell({
    column: {
      name: column.name,
      ...(column.typeName === undefined ? {} : { typeName: column.typeName }),
      tableIndex: options.projection.columnTable[options.ordinal],
    },
    projection: options.projection,
    relations: options.relations,
    value: options.value,
    negate: options.negate,
  });
}
