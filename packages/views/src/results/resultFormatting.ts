import type { DebugResultCell } from "../../../dap/src/debugger/launch/index.js";
import { countLabel } from "../../../rows/src/countLabel.js";
import type { ResultTable } from "../../../rows/src/resultPayload.js";

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
  return sortedResultRowOrder(rows, sort).map((index) => rows[index] ?? []);
}

/** Original row indices in the order the loaded grid presents them. */
export function sortedResultRowOrder(
  rows: readonly DebugResultCell[][],
  sort: ResultSort | undefined,
): number[] {
  if (!sort) return rows.map((_row, index) => index);
  const direction = sort.direction === "ascending" ? 1 : -1;
  return rows
    .map((row, originalIndex) => ({ originalIndex, row }))
    .sort((left, right) => {
      const compared = compareCells(left.row[sort.columnIndex], right.row[sort.columnIndex]);
      return compared === 0 ? left.originalIndex - right.originalIndex : compared * direction;
    })
    .map(({ originalIndex }) => originalIndex);
}

export type ResultTruncationReason = ResultTable["truncationReasons"][number];

/** Why a result is incomplete, named short enough to list inside a sentence. */
export function truncationReasonLabel(reason: ResultTruncationReason): string {
  if (reason === "rows") return "row limit";
  if (reason === "cell") return "truncated cell values";
  return "payload limit";
}

/** Why a result is incomplete, spelled out with its counts: one notice per reason. */
export function truncationNotices(result: ResultTable): string[] {
  return result.truncationReasons.map((reason) => {
    if (reason === "rows") {
      return `${result.capturedRowCount} of ${result.rowCount} rows captured. Additional rows are not displayed or exported.`;
    }
    if (reason === "cell") {
      const hardLimitReached = result.rows.some((row) =>
        row.some((cell) => cell.retainedTruncated),
      );
      return "resultId" in result
        ? hardLimitReached
          ? "One or more cells reached the configured retained-value limit. Change Results: Max Cell Bytes in Settings."
          : "One or more cells were shortened in the grid. Inspect a cell to read its full retained value."
        : "One or more cells reached the 64 KiB captured-result limit. Truncated cells have an amber edge.";
    }
    return `The 1 MiB result payload limit was reached. Only ${result.capturedRowCount} rows are available.`;
  });
}

/** How many rows the reader is looking at, and out of how many. */
export function resultRowSummary(payload: ResultTable): string {
  const navigation = payload.navigation;
  if (!navigation) {
    const count = payload.rowCount ?? payload.capturedRowCount;
    if (payload.truncated && payload.rowCount !== undefined && payload.capturedRowCount < count) {
      return `${payload.capturedRowCount} of ${count} rows`;
    }
    return countLabel(count, "row");
  }
  if (navigation.pageEnd === 0) return "0 rows";
  if (payload.rowCount !== undefined) {
    if (navigation.pageStart === 1 && navigation.pageEnd === payload.rowCount) {
      return countLabel(payload.rowCount, "row");
    }
    return `Rows ${navigation.pageStart}–${navigation.pageEnd} of ${payload.rowCount}`;
  }
  return `Rows ${navigation.pageStart}–${navigation.pageEnd}`;
}

/**
 * Where the reader is in the result, in as few characters as it can be said: the rows on screen
 * over the rows there are. It goes between the two arrows that page through them, and those arrows
 * must not move as a reader uses them — so the shape is always the same, whichever page they are
 * on, and the sentence explaining it is left to `resultRowSummary` and a title.
 */
export function resultRowRange(payload: ResultTable): string {
  const navigation = payload.navigation;
  const total = payload.rowCount;
  if (!navigation) {
    const count = total ?? payload.capturedRowCount;
    return payload.truncated && total !== undefined && payload.capturedRowCount < count
      ? `${payload.capturedRowCount} / ${count}`
      : `${count}`;
  }
  if (navigation.pageEnd === 0) return "0";
  // One page holding everything is not a range: there is nowhere else to be.
  if (total !== undefined && navigation.pageStart === 1 && navigation.pageEnd === total) {
    return `${total}`;
  }
  // A question mark rather than an ellipsis: the total is not yet known, not cut off.
  return `${navigation.pageStart}–${navigation.pageEnd} / ${total ?? "?"}`;
}

export function resultSortNotice(payload: ResultTable): string | undefined {
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
