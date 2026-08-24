import { randomUUID } from "node:crypto";
import type { Client, FieldDef } from "pg";
import {
  boundedQueryResultCell,
  formatQueryResultRowRetained,
  queryResultColumns,
  unnamedTypeIds,
} from "../../dap/src/debugger/launch/boundedQueryResult.js";
import type { DebugResultTruncationReason } from "../../dap/src/debugger/launch/debugResult.js";
import { DEBUG_RESULT_LIMITS, type DebugResultCell } from "../../dap/src/debugger/launch/index.js";
import { clamp } from "./clamp.js";
import type { ScratchpadAssociationSnapshot, SqlNotebookResultPayload } from "./resultPayload.js";

const LOAD_ALL_PAGE_ROWS = 5_000;

export interface OffsetQueryTypes {
  getTypeParser(oid: number, format?: "text" | "binary"): (value: string) => unknown;
}

export interface OffsetQueryBatch {
  rows: unknown[][];
  fields: FieldDef[];
  command?: string;
  typeNames?: ReadonlyMap<number, string>;
}

/** One independently executed page. It must not retain a database transaction. */
export interface OffsetQuerySource {
  read(offset: number, limit: number): Promise<OffsetQueryBatch>;
  cancel(): Promise<void>;
}

export interface OffsetResultOptions {
  pageSize: number;
  binding: ScratchpadAssociationSnapshot;
  id?: string;
  now?: () => number;
  maxCellBytes?: number;
  maxRetainedCellBytes?: number;
  statement?: string;
}

/** The single LIMIT/OFFSET envelope shared by every paged result surface. */
export function offsetPageSql(sql: string, limit: number, offset: number): string {
  const source = sql.trim().replace(/;+\s*$/u, "");
  if (!source) throw new Error("A paged query cannot be empty.");
  const safeLimit = Math.max(0, Math.trunc(limit));
  const safeOffset = Math.max(0, Math.trunc(offset));
  return `SELECT * FROM (\n${source}\n) AS "postgresql_workbench_page" LIMIT ${safeLimit} OFFSET ${safeOffset}`;
}

/** Opens one connection for one page, executes it, and releases it unconditionally. */
export class PostgresOffsetQuerySource implements OffsetQuerySource {
  private activeClient: Client | undefined;
  private generation = 0;

  constructor(
    private readonly openClient: () => Promise<Client>,
    private readonly sql: string,
    private readonly options: {
      types?: OffsetQueryTypes;
      configure?: (client: Client) => Promise<void>;
    } = {},
  ) {}

  async read(offset: number, limit: number): Promise<OffsetQueryBatch> {
    const generation = this.generation;
    const client = await this.openClient();
    if (generation !== this.generation) {
      await client.end().catch(() => {});
      throw new Error("Result loading cancelled.");
    }
    this.activeClient = client;
    try {
      await this.options.configure?.(client);
      const result = await client.query<unknown[]>({
        text: offsetPageSql(this.sql, limit, offset),
        rowMode: "array",
        ...(this.options.types ? { types: this.options.types as never } : {}),
      });
      const typeNames = await namedTypes(client, result.fields);
      return {
        rows: result.rows,
        fields: result.fields,
        ...(result.command ? { command: result.command } : {}),
        ...(typeNames.size > 0 ? { typeNames } : {}),
      };
    } finally {
      if (this.activeClient === client) this.activeClient = undefined;
      await client.end().catch(() => {});
    }
  }

  async cancel(): Promise<void> {
    this.generation += 1;
    const client = this.activeClient;
    this.activeClient = undefined;
    await client?.end().catch(() => {});
  }
}

interface ResultPage {
  start: number;
  rows: DebugResultCell[][];
  hasNext: boolean;
}

/** In-memory navigation state. PostgreSQL state exists only during `source.read`. */
export class OffsetResultSession {
  readonly id: string;
  private readonly pageSize: number;
  private readonly maxCellBytes: number;
  private readonly maxRetainedCellBytes: number;
  private readonly binding: ScratchpadAssociationSnapshot;
  private readonly statement: string | undefined;
  private readonly now: () => number;
  private readonly reasons = new Set<DebugResultTruncationReason>();
  private readonly pages: ResultPage[] = [];
  private readonly loadedRows: DebugResultCell[][] = [];
  private pageIndex = 0;
  private fields: FieldDef[] = [];
  private typeNames: ReadonlyMap<number, string> | undefined;
  private command = "SELECT";
  private rowCount: number | undefined;
  private mode: "paged" | "all" = "paged";
  private durationMs = 0;
  private closed = false;

  private constructor(
    private readonly source: OffsetQuerySource,
    options: OffsetResultOptions,
  ) {
    this.id = options.id ?? `sql-result-${randomUUID()}`;
    this.binding = { ...options.binding };
    this.statement = options.statement;
    this.now = options.now ?? Date.now;
    this.pageSize = clamp(
      options.pageSize,
      DEBUG_RESULT_LIMITS.MIN_ROWS,
      DEBUG_RESULT_LIMITS.MAX_ROWS,
    );
    this.maxCellBytes = clamp(
      options.maxCellBytes ?? DEBUG_RESULT_LIMITS.MAX_CELL_BYTES,
      1,
      DEBUG_RESULT_LIMITS.MAX_CELL_BYTES,
    );
    this.maxRetainedCellBytes = Math.max(
      this.maxCellBytes,
      Math.trunc(options.maxRetainedCellBytes ?? 256 * 1024),
    );
  }

  static async open(source: OffsetQuerySource, options: OffsetResultOptions) {
    const result = new OffsetResultSession(source, options);
    await result.appendPage(0, result.pageSize);
    return result;
  }

  get fieldDefinitions(): readonly FieldDef[] {
    return this.fields;
  }

  snapshot(): SqlNotebookResultPayload {
    const page = this.pages[this.pageIndex] ?? { start: 0, rows: [], hasNext: false };
    const rows = page.rows.map((row) => this.displayRow(row));
    const reasons = new Set(this.reasons);
    if (rows.some((row) => row.some((cell) => cell.truncated))) reasons.add("cell");
    return {
      version: 2,
      resultId: this.id,
      binding: this.binding,
      ...(this.statement !== undefined ? { statement: this.statement } : {}),
      command: this.command,
      columns: queryResultColumns(this.fields, this.typeNames),
      rows,
      ...(this.rowCount !== undefined ? { rowCount: this.rowCount } : {}),
      capturedRowCount: page.rows.length,
      durationMs: this.durationMs,
      truncated: reasons.size > 0,
      truncationReasons: [...reasons],
      navigation: {
        sessionId: this.id,
        mode: this.mode,
        pageIndex: this.pageIndex,
        pageSize: this.pageSize,
        pageStart: page.rows.length === 0 ? 0 : page.start,
        pageEnd: page.rows.length === 0 ? 0 : page.start + page.rows.length - 1,
        loadedRowCount: this.loadedRows.length,
        hasPrevious: this.pageIndex > 0,
        hasNext: page.hasNext || this.pageIndex < this.pages.length - 1,
        canLoadAll: this.mode === "paged" && (page.hasNext || this.pages.length > 1),
      },
    };
  }

  previous(): SqlNotebookResultPayload {
    this.assertOpen();
    if (this.pageIndex > 0) this.pageIndex -= 1;
    return this.snapshot();
  }

  async next(): Promise<SqlNotebookResultPayload> {
    this.assertOpen();
    if (this.pageIndex < this.pages.length - 1) {
      this.pageIndex += 1;
    } else if (this.pages[this.pageIndex]?.hasNext) {
      await this.appendPage(this.loadedRows.length, this.pageSize);
      this.pageIndex = this.pages.length - 1;
    }
    return this.snapshot();
  }

  async loadAll(onProgress?: (loadedRowCount: number) => void): Promise<SqlNotebookResultPayload> {
    this.assertOpen();
    while (this.rowCount === undefined) {
      const before = this.loadedRows.length;
      await this.appendPage(before, LOAD_ALL_PAGE_ROWS);
      onProgress?.(this.loadedRows.length);
      if (this.loadedRows.length === before) break;
    }
    this.pages.splice(0, this.pages.length, {
      start: 1,
      rows: [...this.loadedRows],
      hasNext: false,
    });
    this.pageIndex = 0;
    this.mode = "all";
    return this.snapshot();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.source.cancel();
  }

  loadedResult() {
    return { columns: queryResultColumns(this.fields, this.typeNames), rows: this.loadedRows };
  }

  displayedRows(start: number, length: number): DebugResultCell[][] {
    return this.loadedRows.slice(start, start + length).map((row) => this.displayRow(row));
  }

  private async appendPage(offset: number, size: number): Promise<void> {
    const started = this.now();
    const batch = await this.source.read(offset, size + 1);
    this.assertOpen();
    this.durationMs = Math.max(0, this.now() - started);
    if (this.fields.length > 0 && !sameResultShape(this.fields, batch.fields)) {
      throw new Error("The result shape changed while loading pages. Run the query again.");
    }
    if (this.fields.length === 0 && batch.fields.length > 0) this.fields = batch.fields;
    if (!this.typeNames && batch.typeNames) this.typeNames = batch.typeNames;
    if (batch.command) this.command = batch.command;
    const rows = this.formatRows(batch.rows.slice(0, size));
    const hasNext = batch.rows.length > size;
    if (!hasNext) this.rowCount = offset + rows.length;
    this.pages.push({ start: rows.length === 0 ? 0 : offset + 1, rows, hasNext });
  }

  private formatRows(rows: readonly unknown[][]): DebugResultCell[][] {
    const formatted = rows.map((row) =>
      formatQueryResultRowRetained(row, this.fields, this.maxRetainedCellBytes),
    );
    if (formatted.some((row) => row.some((cell) => cell.truncated))) this.reasons.add("cell");
    this.loadedRows.push(...formatted);
    return formatted;
  }

  private displayRow(row: readonly DebugResultCell[]): DebugResultCell[] {
    return row.map((cell) => boundedQueryResultCell(cell, this.maxCellBytes));
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("This SQL result is closed.");
  }
}

export function sameResultShape(left: readonly FieldDef[], right: readonly FieldDef[]): boolean {
  return (
    left.length === right.length &&
    left.every((field, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        field.name === candidate.name &&
        field.tableID === candidate.tableID &&
        field.columnID === candidate.columnID &&
        field.dataTypeID === candidate.dataTypeID &&
        field.dataTypeSize === candidate.dataTypeSize &&
        field.dataTypeModifier === candidate.dataTypeModifier &&
        field.format === candidate.format
      );
    })
  );
}

async function namedTypes(
  client: Client,
  fields: readonly FieldDef[],
): Promise<Map<number, string>> {
  const unnamed = unnamedTypeIds(fields);
  const names = new Map<number, string>();
  if (unnamed.length === 0) return names;
  try {
    const result = await client.query<{ oid: string; name: string }>(
      "SELECT oid::text AS oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY($1::oid[])",
      [unnamed],
    );
    for (const row of result.rows) names.set(Number(row.oid), row.name);
  } catch {
    // Numeric PostgreSQL type ids remain available when a type name cannot be loaded.
  }
  return names;
}
