import { Buffer } from "node:buffer";
import {
  type DebugResult,
  type DebugResultEntry,
  type DebugResultStatus,
  debugResultEntryStatus,
} from "../../src/debugger/launch/index.js";

export const DEBUG_RESULT_NULL_EXPORT = "\\N";

export interface DebugResultSummary {
  id: string;
  status: "pending" | "success" | "error";
  label: string;
  query: string;
  command: string;
  rowCount: number;
  columnCount: number;
  capturedRowCount: number;
  truncated: boolean;
  durationMs: number;
  timestamp: string;
  message?: string;
  connection?: string;
}

export interface DebugResultViewState {
  results: DebugResultSummary[];
  selected?: DebugResultEntry;
}

export class DebugResultStore {
  private readonly results: DebugResultEntry[] = [];
  private readonly connections = new Map<string, string>();
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

  add(result: DebugResult, connection?: string): void {
    this.update(result, connection);
  }

  addStatus(status: DebugResultStatus, connection?: string): void {
    this.update(status, connection);
  }

  update(entry: DebugResultEntry, connection?: string): void {
    const existing = this.results.findIndex((item) => item.id === entry.id);
    if (existing >= 0) this.results.splice(existing, 1);
    this.results.unshift(entry);
    if (connection !== undefined) this.connections.set(entry.id, connection);
    this.selectedId = entry.id;
    this.trim();
    this.fire();
  }

  connectionOf(id: string): string | undefined {
    return this.connections.get(id);
  }

  clear(): void {
    if (this.results.length === 0) return;
    this.results.length = 0;
    this.connections.clear();
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
        ...(this.connections.has(result.id) ? { connection: this.connections.get(result.id) } : {}),
      })),
      selected: this.selectedEntry,
    };
  }

  selectedAsTsv(): string | undefined {
    const result = this.selected;
    if (!result) return undefined;
    const lines = [result.columns.map((column) => escapeDelimited(column.name, "\t")).join("\t")];
    for (const row of result.rows) {
      lines.push(
        row.map((cell) => escapeDelimited(cell.value ?? DEBUG_RESULT_NULL_EXPORT, "\t")).join("\t"),
      );
    }
    return lines.join("\n");
  }

  selectedAsCsv(): string | undefined {
    const result = this.selected;
    if (!result) return undefined;
    const lines = [result.columns.map((column) => escapeDelimited(column.name, ",")).join(",")];
    for (const row of result.rows) {
      lines.push(
        row.map((cell) => escapeDelimited(cell.value ?? DEBUG_RESULT_NULL_EXPORT, ",")).join(","),
      );
    }
    return lines.join("\n");
  }

  selectedAsJson(): string | undefined {
    const result = this.selected;
    if (!result) return undefined;
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

  private trim(): void {
    while (this.results.length > this.maxResults) this.results.pop();
    let total = this.results.reduce((sum, result) => sum + retainedBytes(result), 0);
    while (total > this.maxBytes && this.results.length > 1) {
      const removed = this.results.pop();
      total -= removed ? retainedBytes(removed) : 0;
    }
    const retained = new Set(this.results.map((result) => result.id));
    for (const id of [...this.connections.keys()]) {
      if (!retained.has(id)) this.connections.delete(id);
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

function escapeDelimited(value: string, delimiter: string): string {
  const spreadsheetSafe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (!spreadsheetSafe.includes(delimiter) && !/["\r\n]/.test(spreadsheetSafe)) {
    return spreadsheetSafe;
  }
  return `"${spreadsheetSafe.replace(/"/g, '""')}"`;
}
