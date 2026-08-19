import type { DebugResultCell } from "../../../dap/src/debugger/launch/index.js";
import type { SqlNotebookResultPayload } from "./payload.js";

export type ResultSortDirection = "ascending" | "descending";

export interface ResultSort {
  columnIndex: number;
  direction: ResultSortDirection;
}

const RESULT_COLLATOR = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

const MIN_COLUMN_CH = 6;
const MAX_COLUMN_CH = 48;
const WIDTH_SAMPLE_ROWS = 200;
/** Cell padding plus the sort indicator, in characters. */
const COLUMN_CHROME_CH = 4;

/**
 * Column widths in `ch`, sized to the header and a sample of the values so narrow columns stay
 * narrow and wide values are capped instead of stretching the whole grid.
 */
export function columnWidthsCh(
  columns: readonly { name: string; typeName?: string }[],
  rows: readonly (readonly DebugResultCell[])[],
): number[] {
  const widths = columns.map((column) =>
    Math.max(column.name.length, (column.typeName ?? "").length),
  );
  const sample = rows.length > WIDTH_SAMPLE_ROWS ? rows.slice(0, WIDTH_SAMPLE_ROWS) : rows;
  for (const row of sample) {
    row.forEach((cell, index) => {
      const length = cell.value === null ? 4 : firstLineLength(cell.value);
      if (length > (widths[index] ?? 0)) widths[index] = length;
    });
  }
  return widths.map((width) =>
    Math.min(MAX_COLUMN_CH, Math.max(MIN_COLUMN_CH, width + COLUMN_CHROME_CH)),
  );
}

function firstLineLength(value: string): number {
  const newline = value.indexOf("\n");
  return newline === -1 ? value.length : newline + 1;
}

export function formattedCellValue(cell: DebugResultCell): string {
  if (cell.value === null) return "NULL";
  if (cell.kind !== "json") return cell.value;
  try {
    return JSON.stringify(JSON.parse(cell.value), null, 2);
  } catch {
    return cell.value;
  }
}

export function resultAsTsv(payload: SqlNotebookResultPayload): string {
  const lines = [payload.columns.map((column) => escapeTsv(column.name)).join("\t")];
  for (const row of payload.rows) {
    lines.push(row.map((cell) => escapeTsv(cell.value ?? "\\N")).join("\t"));
  }
  return lines.join("\n");
}

export function nextResultSort(
  current: ResultSort | undefined,
  columnIndex: number,
): ResultSort | undefined {
  if (!current || current.columnIndex !== columnIndex) {
    return { columnIndex, direction: "ascending" };
  }
  if (current.direction === "ascending") {
    return { columnIndex, direction: "descending" };
  }
  return undefined;
}

export function sortedResultRows(
  rows: DebugResultCell[][],
  sort: ResultSort | undefined,
): DebugResultCell[][] {
  if (!sort) return rows;
  const direction = sort.direction === "ascending" ? 1 : -1;
  return rows
    .map((row, originalIndex) => ({ originalIndex, row }))
    .sort((left, right) => {
      const compared = compareCells(left.row[sort.columnIndex], right.row[sort.columnIndex]);
      return compared === 0 ? left.originalIndex - right.originalIndex : compared * direction;
    })
    .map(({ row }) => row);
}

export function resultSortNotice(payload: SqlNotebookResultPayload): string | undefined {
  if (payload.navigation?.mode === "paged") {
    const qualifier = payload.truncationReasons.includes("cell")
      ? " using truncated display values"
      : "";
    return `Sorting rows ${payload.navigation.pageStart}–${payload.navigation.pageEnd}${qualifier}.`;
  }
  const rowsIncomplete =
    payload.truncationReasons.includes("rows") || payload.truncationReasons.includes("payload");
  const cellsIncomplete = payload.truncationReasons.includes("cell");
  if (rowsIncomplete && cellsIncomplete) {
    return `Sorting the ${payload.capturedRowCount} captured rows using truncated display values.`;
  }
  if (rowsIncomplete) return `Sorting the ${payload.capturedRowCount} captured rows only.`;
  if (cellsIncomplete) return "Sorting uses truncated display values.";
  return undefined;
}

function compareCells(
  left: DebugResultCell | undefined,
  right: DebugResultCell | undefined,
): number {
  const leftValue = left?.value;
  const rightValue = right?.value;
  if (leftValue === null || leftValue === undefined) {
    return rightValue === null || rightValue === undefined ? 0 : 1;
  }
  if (rightValue === null || rightValue === undefined) return -1;
  if (left?.kind === "number" && right?.kind === "number") {
    const compared = compareExactNumbers(leftValue, rightValue);
    if (compared !== undefined) return compared;
  }
  return RESULT_COLLATOR.compare(leftValue, rightValue);
}

interface ExactDecimal {
  sign: -1 | 0 | 1;
  digits: string;
  power: number;
}

interface ExactNumber {
  rank: 0 | 1 | 2 | 3;
  decimal?: ExactDecimal;
}

function compareExactNumbers(left: string, right: string): number | undefined {
  const parsedLeft = parseExactNumber(left);
  const parsedRight = parseExactNumber(right);
  if (!parsedLeft || !parsedRight) return undefined;
  if (parsedLeft.rank !== parsedRight.rank) return parsedLeft.rank - parsedRight.rank;
  if (parsedLeft.rank !== 1) return 0;
  return compareExactDecimals(parsedLeft.decimal!, parsedRight.decimal!);
}

function compareExactDecimals(parsedLeft: ExactDecimal, parsedRight: ExactDecimal): number {
  if (parsedLeft.sign !== parsedRight.sign) return parsedLeft.sign - parsedRight.sign;
  if (parsedLeft.sign === 0) return 0;
  const magnitude = compareDecimalMagnitude(parsedLeft, parsedRight);
  return parsedLeft.sign === 1 ? magnitude : -magnitude;
}

function parseExactNumber(value: string): ExactNumber | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "-infinity") return { rank: 0 };
  if (normalized === "infinity" || normalized === "+infinity") return { rank: 2 };
  if (normalized === "nan") return { rank: 3 };
  const decimal = parseExactDecimal(value);
  return decimal ? { rank: 1, decimal } : undefined;
}

function parseExactDecimal(value: string): ExactDecimal | undefined {
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/u.exec(value.trim());
  if (!match) return undefined;
  const integer = match[2] ?? "";
  const fraction = match[3] ?? match[4] ?? "";
  const digits = `${integer}${fraction}`.replace(/^0+/u, "");
  if (!digits) return { sign: 0, digits: "0", power: 0 };
  const exponent = Number(match[5] ?? 0);
  if (!Number.isSafeInteger(exponent)) return undefined;
  return {
    sign: match[1] === "-" ? -1 : 1,
    digits,
    power: exponent - fraction.length,
  };
}

function compareDecimalMagnitude(left: ExactDecimal, right: ExactDecimal): number {
  const leftMagnitude = left.digits.length + left.power;
  const rightMagnitude = right.digits.length + right.power;
  if (leftMagnitude !== rightMagnitude) return leftMagnitude - rightMagnitude;
  const width = Math.max(left.digits.length, right.digits.length);
  const leftDigits = left.digits.padEnd(width, "0");
  const rightDigits = right.digits.padEnd(width, "0");
  return leftDigits < rightDigits ? -1 : leftDigits > rightDigits ? 1 : 0;
}

function escapeTsv(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /["\t\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
