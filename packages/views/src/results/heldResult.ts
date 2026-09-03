/**
 * Answering inspect, preview and export for rows a host already holds. The hosts speak different
 * transports — notebook renderer messaging, a webview panel — so what a request means against
 * retained rows, and the response it earns, are decided here, once.
 */
import type { DebugResultCell } from "../../../dap/src/debugger/launch/index.js";
import { dataViewExportText, type ExportColumn } from "../../../rows/src/export.js";
import {
  isSqlResultExportFormat,
  type SqlNotebookRendererRequest,
  type SqlResultExportRequest,
  type SqlResultInspectedResponse,
  type SqlResultInspectRequest,
  type SqlResultPreviewedResponse,
  type SqlResultPreviewRequest,
} from "./payload.js";
import { sortedResultRowOrder } from "./resultFormatting.js";

/** The rows a host retains for one result: full-width values, and the display projection. */
export interface HeldResult {
  loadedResult(): {
    columns: readonly { name: string; typeName?: string }[];
    rows: readonly (readonly DebugResultCell[])[];
  };
  displayedRows(start: number, length: number): Parameters<typeof sortedResultRowOrder>[0];
}

type HeldRequest = Pick<SqlResultExportRequest, "scope" | "page" | "selection" | "sort">;

/**
 * The rows a scope covers: the selection as displayed, or every retained row. A column sort is
 * local to the result, so it orders the retained set; the entire-query scope re-runs the
 * statement elsewhere and never reaches these rows.
 */
export function heldValuesForScope(
  held: HeldResult,
  request: HeldRequest,
): { columns: ExportColumn[]; rows: (string | null)[][] } {
  return request.scope === "selection"
    ? heldValues(held, request)
    : allHeldValues(held, retainedSortFor(request));
}

/** The retained value behind one displayed cell, in the order the reader put the page in. */
export function inspectedCellValue(
  held: HeldResult,
  request: SqlResultInspectRequest,
): DebugResultCell | undefined {
  const retained = held.loadedResult();
  const first = Math.max(0, request.page.start - 1);
  let rows = retained.rows.slice(first, first + request.page.length);
  if (request.sort) {
    const order = sortedResultRowOrder(
      held.displayedRows(first, request.page.length),
      request.sort,
    );
    rows = order.map((index) => rows[index] ?? []);
  }
  return rows[request.row]?.[request.ordinal];
}

/** The first rows of the export exactly as the file writer would write them. */
export function heldPreviewText(held: HeldResult, request: SqlResultPreviewRequest): string {
  const values = heldValuesForScope(held, request);
  return dataViewExportText(values.columns, values.rows.slice(0, 12), {
    ...request.choice,
    finalNewline: false,
  });
}

/** The answer to one inspect request: the retained cell, or nothing when the result is gone. */
export function inspectedResponse(
  held: HeldResult | undefined,
  request: SqlResultInspectRequest,
): SqlResultInspectedResponse {
  return {
    type: "sql-result/inspected",
    requestId: request.requestId,
    resultId: request.resultId,
    cell: held ? inspectedCellValue(held, request) : undefined,
  };
}

/** The answer to one preview request, errors included: what failed is said in the preview pane. */
export function previewedResponse(
  held: HeldResult | undefined,
  request: SqlResultPreviewRequest,
  missingMessage: string,
): SqlResultPreviewedResponse {
  const answer = (text: string, error?: true): SqlResultPreviewedResponse => ({
    type: "sql-result/previewed",
    requestId: request.requestId,
    resultId: request.resultId,
    text,
    ...(error ? { error } : {}),
  });
  if (!held) return answer(missingMessage, true);
  try {
    return answer(heldPreviewText(held, request));
  } catch (error) {
    return answer(error instanceof Error ? error.message : String(error), true);
  }
}

/**
 * The sort a scope carries into the retained rows. Sorting a column is local to the result, so the
 * rows loaded answer in the order the reader put them in. The entire query does not: it runs the
 * statement again, and a re-run carries no local sort, so promising one would describe another file.
 */
function retainedSortFor(request: HeldRequest): HeldRequest["sort"] {
  return request.scope === "loaded" ? request.sort : undefined;
}

/**
 * Every retained row, in the order the reader put them in. A column sort is local to the result,
 * so it orders the whole retained set here and not only the page it was applied on.
 */
function allHeldValues(
  held: HeldResult,
  sort: HeldRequest["sort"],
): {
  columns: ExportColumn[];
  rows: (string | null)[][];
} {
  const retained = held.loadedResult();
  let rows: readonly (readonly DebugResultCell[])[] = retained.rows;
  if (sort) {
    if (sort.columnIndex >= retained.columns.length) {
      throw new Error("The result sort column is outside the retained columns.");
    }
    const order = sortedResultRowOrder(held.displayedRows(0, rows.length), sort);
    rows = order.map((index) => rows[index] ?? []);
  }
  return {
    columns: retained.columns.map((column) => ({
      name: column.name,
      ...(column.typeName ? { type: column.typeName } : {}),
    })),
    rows: rows.map((row) => row.map((cell) => cell.value)),
  };
}

function heldValues(
  held: HeldResult,
  request: HeldRequest,
): { columns: ExportColumn[]; rows: (string | null)[][] } {
  if (!request.page) throw new Error("The displayed result page is missing.");
  const retained = held.loadedResult();
  if (
    request.page.start < 1 ||
    request.page.start - 1 + request.page.length > retained.rows.length
  ) {
    throw new Error("The displayed result page is outside the retained rows.");
  }
  const first = request.page.start - 1;
  let rows = retained.rows.slice(first, first + request.page.length);
  if (request.sort) {
    if (request.sort.columnIndex >= retained.columns.length) {
      throw new Error("The result sort column is outside the retained columns.");
    }
    const order = sortedResultRowOrder(
      held.displayedRows(first, request.page.length),
      request.sort,
    );
    rows = order.map((index) => rows[index] ?? []);
  }
  const selection = request.scope === "selection" ? request.selection : undefined;
  if (request.scope === "selection" && !selection) {
    throw new Error("The selected result rows are missing.");
  }
  if (selection) {
    if (selection.to >= rows.length)
      throw new Error("The selected result rows are outside the page.");
    rows = rows.slice(selection.from, selection.to + 1);
  }
  const ordinals = selection?.ordinals ?? retained.columns.map((_column, ordinal) => ordinal);
  if (
    new Set(ordinals).size !== ordinals.length ||
    ordinals.some((ordinal) => ordinal >= retained.columns.length)
  ) {
    throw new Error("The selected result columns are invalid.");
  }
  const columns = ordinals.map((ordinal) => {
    const column = retained.columns[ordinal];
    if (!column) throw new Error("The selected result column is missing.");
    return { name: column.name, ...(column.typeName ? { type: column.typeName } : {}) };
  });
  return {
    columns,
    rows: rows.map((row) => ordinals.map((ordinal) => row[ordinal]?.value ?? null)),
  };
}

export function isSqlResultInspectRequest(value: unknown): value is SqlResultInspectRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Partial<SqlResultInspectRequest>;
  return (
    message.type === "sql-result/inspect" &&
    typeof message.requestId === "string" &&
    typeof message.resultId === "string" &&
    isExportPage(message.page) &&
    Number.isInteger(message.row) &&
    Number(message.row) >= 0 &&
    Number.isInteger(message.ordinal) &&
    Number(message.ordinal) >= 0 &&
    isOptionalSort(message.sort)
  );
}

export function isSqlResultExportRequest(value: unknown): value is SqlResultExportRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Partial<SqlResultExportRequest>;
  return (
    message.type === "sql-result/export" &&
    typeof message.resultId === "string" &&
    typeof message.title === "string" &&
    isExportChoice(message.choice) &&
    (message.scope === "selection" || message.scope === "loaded" || message.scope === "all") &&
    (message.scope === "all" || isExportPage(message.page)) &&
    (message.scope !== "selection" || isExportSelection(message.selection)) &&
    isOptionalSort(message.sort)
  );
}

export function isSqlResultPreviewRequest(value: unknown): value is SqlResultPreviewRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Partial<SqlResultPreviewRequest>;
  return (
    message.type === "sql-result/preview" &&
    Number.isInteger(message.requestId) &&
    typeof message.resultId === "string" &&
    isExportChoice(message.choice) &&
    (message.scope === "selection" || message.scope === "loaded" || message.scope === "all") &&
    (message.scope === "all" || isExportPage(message.page)) &&
    (message.scope !== "selection" || isExportSelection(message.selection)) &&
    isOptionalSort(message.sort)
  );
}

function isOptionalSort(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const sort = value as { columnIndex?: unknown; direction?: unknown };
  return (
    Number.isInteger(sort.columnIndex) &&
    Number(sort.columnIndex) >= 0 &&
    (sort.direction === "ascending" || sort.direction === "descending")
  );
}

function isExportChoice(value: unknown): value is SqlResultExportRequest["choice"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const choice = value as Partial<SqlResultExportRequest["choice"]>;
  return (
    isSqlResultExportFormat(choice.format) &&
    typeof choice.header === "boolean" &&
    (choice.nullAs === "empty" || choice.nullAs === "null" || choice.nullAs === "backslash-n") &&
    typeof choice.delimiter === "string" &&
    typeof choice.createTable === "boolean" &&
    typeof choice.spreadsheetSafe === "boolean" &&
    typeof choice.finalNewline === "boolean"
  );
}

function isExportPage(value: unknown): value is NonNullable<SqlResultExportRequest["page"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const page = value as { start?: unknown; length?: unknown };
  return (
    Number.isInteger(page.start) &&
    Number(page.start) >= 0 &&
    Number.isInteger(page.length) &&
    Number(page.length) >= 0
  );
}

function isExportSelection(
  value: unknown,
): value is NonNullable<SqlResultExportRequest["selection"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const selection = value as { from?: unknown; to?: unknown; ordinals?: unknown };
  return (
    Number.isInteger(selection.from) &&
    Number(selection.from) >= 0 &&
    Number.isInteger(selection.to) &&
    Number(selection.to) >= Number(selection.from) &&
    Array.isArray(selection.ordinals) &&
    selection.ordinals.every((ordinal) => Number.isInteger(ordinal) && ordinal >= 0)
  );
}

export function isSqlResultOpenSettingsRequest(value: unknown): boolean {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Partial<SqlNotebookRendererRequest>).type === "sql-error/open-analysis-settings"
  );
}

export function isSqlResultIncreaseTimeoutRequest(value: unknown): boolean {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Partial<SqlNotebookRendererRequest>).type === "sql-error/increase-scratchpad-timeout"
  );
}
