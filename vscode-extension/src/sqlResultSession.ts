import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { Client, FieldDef, QueryResult } from "pg";
import Cursor from "pg-cursor";
import {
  formatQueryResultRow,
  queryResultColumns,
} from "../../src/debugger/launch/boundedQueryResult.js";
import type { DebugResultTruncationReason } from "../../src/debugger/launch/debugResult.js";
import { DEBUG_RESULT_LIMITS, type DebugResultCell } from "../../src/debugger/launch/index.js";
import type { NotebookBindingSnapshot, SqlNotebookResultPayload } from "./sqlNotebookModel.js";

const LOAD_ALL_BATCH_ROWS = 5_000;
const PAYLOAD_METADATA_RESERVE_BYTES = 64 * 1024;

export interface SqlCursorBatch {
  rows: unknown[][];
  fields: FieldDef[];
  command?: string;
}

export interface SqlCursorReader {
  read(maxRows: number): Promise<SqlCursorBatch>;
  close(): Promise<void>;
}

export interface SqlResultSessionOptions {
  pageSize: number;
  maxCachedRows: number;
  binding: NotebookBindingSnapshot;
  id?: string;
  timestamp?: string;
  now?: () => number;
  maxCellBytes?: number;
  maxPayloadBytes?: number;
}

interface ResultPage {
  start: number;
  rows: DebugResultCell[][];
}

export class PostgresCursorReader implements SqlCursorReader {
  private readonly cursor: Cursor<unknown[]>;
  private closed = false;

  constructor(
    private readonly client: Client,
    sql: string,
  ) {
    this.cursor = new Cursor<unknown[]>(sql, [], { rowMode: "array" });
    client.query(this.cursor as never);
  }

  read(maxRows: number): Promise<SqlCursorBatch> {
    if (this.closed) return Promise.resolve({ rows: [], fields: [] });
    return new Promise((resolve, reject) => {
      this.cursor.read(maxRows, (error, rows, result) => {
        if (error) {
          reject(error);
          return;
        }
        const queryResult = result as QueryResult<unknown[]>;
        resolve({
          rows,
          fields: queryResult.fields,
          ...(queryResult.command ? { command: queryResult.command } : {}),
        });
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.cursor.close();
    } finally {
      await this.client.end().catch(() => {});
    }
  }
}

export class SqlResultSession {
  readonly id: string;
  private readonly now: () => number;
  private readonly pageSize: number;
  private readonly maxCachedRows: number;
  private readonly maxCellBytes: number;
  private readonly maxPayloadBytes: number;
  private readonly binding: NotebookBindingSnapshot;
  private readonly truncationReasons = new Set<DebugResultTruncationReason>();
  private pages: ResultPage[] = [];
  private pendingRows: DebugResultCell[][] = [];
  private pageIndex = 0;
  private nextPageStart = 1;
  private fetchedRowCount = 0;
  private fields: FieldDef[] = [];
  private command = "SELECT";
  private exhausted = false;
  private readerClosed = false;
  private closed = false;
  private mode: "paged" | "all" = "paged";
  private durationMs = 0;

  private constructor(
    private readonly reader: SqlCursorReader,
    options: SqlResultSessionOptions,
  ) {
    this.id = options.id ?? `sql-session-${randomUUID()}`;
    this.binding = { ...options.binding };
    this.now = options.now ?? Date.now;
    this.pageSize = clamp(
      options.pageSize,
      DEBUG_RESULT_LIMITS.MIN_ROWS,
      DEBUG_RESULT_LIMITS.MAX_ROWS,
    );
    const requestedMaxCachedRows = Number.isFinite(options.maxCachedRows)
      ? Math.trunc(options.maxCachedRows)
      : this.pageSize;
    this.maxCachedRows = Math.max(this.pageSize, requestedMaxCachedRows);
    this.maxCellBytes = clamp(
      options.maxCellBytes ?? DEBUG_RESULT_LIMITS.MAX_CELL_BYTES,
      1,
      DEBUG_RESULT_LIMITS.MAX_CELL_BYTES,
    );
    this.maxPayloadBytes = clamp(
      options.maxPayloadBytes ?? DEBUG_RESULT_LIMITS.MAX_PAYLOAD_BYTES,
      1,
      DEBUG_RESULT_LIMITS.MAX_PAYLOAD_BYTES,
    );
  }

  static async open(
    reader: SqlCursorReader,
    options: SqlResultSessionOptions,
  ): Promise<SqlResultSession> {
    const session = new SqlResultSession(reader, options);
    await session.appendNextPage();
    return session;
  }

  snapshot(): SqlNotebookResultPayload {
    const page = this.pages[this.pageIndex] ?? { start: 0, rows: [] };
    const pageEnd = page.rows.length === 0 ? 0 : page.start + page.rows.length - 1;
    const hasCachedNext = this.pageIndex < this.pages.length - 1;
    const hasNext = hasCachedNext || this.pendingRows.length > 0 || !this.exhausted;
    const cacheStart = this.pages[0]?.start ?? 0;
    return {
      version: 2,
      binding: this.binding,
      command: this.command,
      columns: queryResultColumns(this.fields),
      rows: page.rows,
      ...(this.exhausted ? { rowCount: this.fetchedRowCount } : {}),
      capturedRowCount: page.rows.length,
      durationMs: this.durationMs,
      truncated: this.truncationReasons.size > 0,
      truncationReasons: [...this.truncationReasons],
      navigation: {
        sessionId: this.id,
        mode: this.mode,
        pageIndex: this.pageIndex,
        pageSize: this.pageSize,
        pageStart: page.rows.length === 0 ? 0 : page.start,
        pageEnd,
        loadedRowCount: this.fetchedRowCount,
        cacheStart,
        hasPrevious: this.pageIndex > 0,
        hasNext,
        canLoadAll: this.mode === "paged" && cacheStart === 1 && (this.pages.length > 1 || hasNext),
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
      return this.snapshot();
    }
    if (this.exhausted && this.pendingRows.length === 0) return this.snapshot();
    await this.appendNextPage();
    this.pageIndex = this.pages.length - 1;
    this.evictOldPages();
    return this.snapshot();
  }

  async loadAll(onProgress?: (loadedRowCount: number) => void): Promise<SqlNotebookResultPayload> {
    this.assertOpen();
    const cacheStart = this.pages[0]?.start ?? 1;
    const allRows = this.pages.flatMap((page) => page.rows);
    allRows.push(...this.pendingRows);
    this.pendingRows = [];

    while (!this.exhausted) {
      this.assertOpen();
      const batch = await this.read(LOAD_ALL_BATCH_ROWS);
      this.assertOpen();
      this.captureBatch(batch);
      allRows.push(...this.formatRows(batch.rows));
      if (batch.rows.length < LOAD_ALL_BATCH_ROWS) {
        this.exhausted = true;
        await this.closeReader();
      }
      onProgress?.(this.fetchedRowCount);
    }

    this.pages = [{ start: cacheStart, rows: allRows }];
    if (cacheStart > 1) this.truncationReasons.add("rows");
    this.pageIndex = 0;
    this.mode = "all";
    return this.snapshot();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.closeReader();
  }

  private async appendNextPage(): Promise<void> {
    if (!this.exhausted && this.pendingRows.length <= this.pageSize) {
      const requested = this.pageSize + 1 - this.pendingRows.length;
      const batch = await this.read(requested);
      this.captureBatch(batch);
      this.pendingRows.push(...this.formatRows(batch.rows));
      if (batch.rows.length < requested) {
        this.exhausted = true;
        await this.closeReader();
      }
    }

    if (this.pendingRows.length === 0) {
      if (this.pages.length === 0) this.pages.push({ start: 0, rows: [] });
      return;
    }

    const rows = takePayloadBoundedPage(this.pendingRows, this.pageSize, this.maxPayloadBytes);
    this.pages.push({ start: this.nextPageStart, rows });
    this.nextPageStart += rows.length;
  }

  private captureBatch(batch: SqlCursorBatch): void {
    this.fetchedRowCount += batch.rows.length;
    if (batch.fields.length > 0) this.fields = batch.fields;
    if (batch.command) this.command = batch.command;
  }

  private formatRows(rows: readonly unknown[][]): DebugResultCell[][] {
    return rows.map((row) => {
      const formatted = formatQueryResultRow(row, this.fields, this.maxCellBytes);
      if (formatted.some((cell) => cell.truncated)) this.truncationReasons.add("cell");
      return formatted;
    });
  }

  private evictOldPages(): void {
    let cachedRows = this.pages.reduce((total, page) => total + page.rows.length, 0);
    while (this.pages.length > 1 && cachedRows > this.maxCachedRows) {
      const removed = this.pages.shift();
      if (!removed) break;
      cachedRows -= removed.rows.length;
      this.pageIndex = Math.max(0, this.pageIndex - 1);
      this.truncationReasons.add("rows");
    }
  }

  private async read(maxRows: number): Promise<SqlCursorBatch> {
    const startedAt = this.now();
    try {
      return await this.reader.read(maxRows);
    } finally {
      this.durationMs += Math.max(0, this.now() - startedAt);
    }
  }

  private async closeReader(): Promise<void> {
    if (this.readerClosed) return;
    this.readerClosed = true;
    await this.reader.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("This SQL result session is closed.");
  }
}

function takePayloadBoundedPage(
  pendingRows: DebugResultCell[][],
  pageSize: number,
  maxPayloadBytes: number,
): DebugResultCell[][] {
  const rows: DebugResultCell[][] = [];
  const availableBytes = Math.max(1, maxPayloadBytes - PAYLOAD_METADATA_RESERVE_BYTES);
  let payloadBytes = 0;
  while (pendingRows.length > 0 && rows.length < pageSize) {
    const row = pendingRows[0];
    if (!row) break;
    const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
    if (rows.length > 0 && payloadBytes + rowBytes > availableBytes) break;
    rows.push(row);
    pendingRows.shift();
    payloadBytes += rowBytes;
  }
  return rows;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
