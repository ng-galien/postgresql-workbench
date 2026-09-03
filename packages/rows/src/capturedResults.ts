import { Buffer } from "node:buffer";
import {
  type DebugResult,
  type DebugResultCell,
  type DebugResultColumn,
  type DebugResultEntry,
  type DebugResultStatus,
  debugResultEntryStatus,
} from "../../dap/src/debugger/launch/index.js";
import type { DebugResultViewState, ResultBinding } from "../../rows/src/resultPayload.js";

/**
 * The captured debug results the Extension Host holds: the bounded history it keeps, what it
 * selects, and the delimited and JSON forms it exports. What a view renders of them is described
 * in packages/rows, next to the other result shapes.
 */
export const DEBUG_RESULT_NULL_EXPORT = "\\N";

function connectionLabelOf(binding: ResultBinding | undefined): { connection?: string } {
  return binding ? { connection: binding.connectionName } : {};
}

export class DebugResultStore {
  private readonly results: DebugResultEntry[] = [];
  private readonly bindings = new Map<string, ResultBinding>();
  private readonly listeners = new Set<() => void>();
  private selectedId: string | undefined;

  constructor(
    private readonly maxResults = 10,
    private readonly maxBytes = 5 * 1024 * 1024,
  ) {}

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  add(result: DebugResult, binding?: ResultBinding): void {
    this.update(result, binding);
  }

  addStatus(status: DebugResultStatus, binding?: ResultBinding): void {
    this.update(status, binding);
  }

  update(entry: DebugResultEntry, binding?: ResultBinding): void {
    const existing = this.results.findIndex((item) => item.id === entry.id);
    if (existing >= 0) this.results.splice(existing, 1);
    this.results.unshift(entry);
    if (binding !== undefined) this.bindings.set(entry.id, binding);
    this.selectedId = entry.id;
    this.trim();
    this.fire();
  }

  bindingOf(id: string): ResultBinding | undefined {
    return this.bindings.get(id);
  }

  entryOf(id: string): DebugResultEntry | undefined {
    return this.results.find((result) => result.id === id);
  }

  clear(): void {
    if (this.results.length === 0) return;
    this.results.length = 0;
    this.bindings.clear();
    this.selectedId = undefined;
    this.fire();
  }

  select(id: string): void {
    if (this.selectedId === id || !this.results.some((result) => result.id === id)) return;
    this.selectedId = id;
    this.fire();
  }

  get selectedEntry(): DebugResultEntry | undefined {
    return this.results.find((result) => result.id === this.selectedId) ?? this.results[0];
  }

  get selected(): DebugResult | undefined {
    const entry = this.selectedEntry;
    return entry && debugResultEntryStatus(entry) === "success"
      ? (entry as DebugResult)
      : undefined;
  }

  get size(): number {
    return this.results.length;
  }

  viewState(): DebugResultViewState {
    const selected = this.selectedEntry;
    const selectedBinding = selected && this.bindings.get(selected.id);
    return {
      results: this.results.map((result) => ({
        id: result.id,
        status: debugResultEntryStatus(result),
        label: result.label ?? ("command" in result ? result.command : "SQL result"),
        query: result.query ?? "",
        command: "command" in result ? result.command : "SQL",
        rowCount: "rowCount" in result ? result.rowCount : 0,
        columnCount: "columns" in result ? result.columns.length : 0,
        capturedRowCount: "capturedRowCount" in result ? result.capturedRowCount : 0,
        truncated: "truncated" in result ? result.truncated : false,
        durationMs: "durationMs" in result ? result.durationMs : 0,
        timestamp: result.timestamp,
        ...("message" in result ? { message: result.message } : {}),
        ...connectionLabelOf(this.bindings.get(result.id)),
      })),
      selected,
      ...(selectedBinding ? { selectedBinding } : {}),
    };
  }

  selectedAsTsv(): string | undefined {
    const result = this.selected;
    return result ? resultAsDelimited(result, "\t") : undefined;
  }

  selectedAsCsv(): string | undefined {
    const result = this.selected;
    return result ? resultAsDelimited(result, ",") : undefined;
  }

  selectedAsJson(): string | undefined {
    const result = this.selected;
    return result ? resultAsJson(result) : undefined;
  }

  private trim(): void {
    while (this.results.length > this.maxResults) this.results.pop();
    let total = this.results.reduce((sum, result) => sum + retainedBytes(result), 0);
    while (total > this.maxBytes && this.results.length > 1) {
      const removed = this.results.pop();
      total -= removed ? retainedBytes(removed) : 0;
    }
    const retained = new Set(this.results.map((result) => result.id));
    for (const id of [...this.bindings.keys()]) {
      if (!retained.has(id)) this.bindings.delete(id);
    }
  }

  private fire(): void {
    for (const listener of this.listeners) listener();
  }
}

function retainedBytes(entry: DebugResultEntry): number {
  return "payloadBytes" in entry
    ? entry.payloadBytes
    : Buffer.byteLength(JSON.stringify(entry), "utf8");
}

/** Rows for one export line: PostgreSQL NULL becomes `\N`, spreadsheet formulas are neutralized. */
export function delimitedRow(cells: readonly DebugResultCell[], delimiter: string): string {
  return cells
    .map((cell) => escapeDelimited(cell.value ?? DEBUG_RESULT_NULL_EXPORT, delimiter))
    .join(delimiter);
}

export function delimitedHeader(columns: readonly DebugResultColumn[], delimiter: string): string {
  return columns.map((column) => escapeDelimited(column.name, delimiter)).join(delimiter);
}

export function resultAsDelimited(
  result: Pick<DebugResult, "columns" | "rows">,
  delimiter: string,
): string {
  return [
    delimitedHeader(result.columns, delimiter),
    ...result.rows.map((row) => delimitedRow(row, delimiter)),
  ].join("\n");
}

export function resultAsJson(result: DebugResult): string {
  return JSON.stringify(
    {
      label: result.label ?? result.command,
      query: result.query ?? "",
      source: result.source,
      command: result.command,
      columns: result.columns,
      rows: result.rows.map((row) => row.map((cell) => cell.value)),
      rowCount: result.rowCount,
      capturedRowCount: result.capturedRowCount,
      truncated: result.truncated,
      truncationReasons: result.truncationReasons,
      cellTruncations: result.rows.flatMap((row, rowIndex) =>
        row.flatMap((cell, columnIndex) =>
          cell.truncated ? [{ row: rowIndex, column: columnIndex }] : [],
        ),
      ),
    },
    null,
    2,
  );
}

function escapeDelimited(value: string, delimiter: string): string {
  const spreadsheetSafe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (!spreadsheetSafe.includes(delimiter) && !/["\r\n]/.test(spreadsheetSafe)) {
    return spreadsheetSafe;
  }
  return `"${spreadsheetSafe.replace(/"/g, '""')}"`;
}
