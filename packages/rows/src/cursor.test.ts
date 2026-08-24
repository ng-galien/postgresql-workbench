import type { FieldDef } from "pg";
import { describe, expect, it } from "vitest";
import { type SqlCursorBatch, type SqlCursorReader, SqlResultSession } from "./cursor.js";

const FIELD: FieldDef = {
  name: "value",
  tableID: 0,
  columnID: 0,
  dataTypeID: 23,
  dataTypeSize: 4,
  dataTypeModifier: -1,
  format: "text",
};

const TEST_BINDING = {
  connectionId: "test-connection",
  connectionName: "Test PostgreSQL",
  database: "testdb",
};

class FakeCursorReader implements SqlCursorReader {
  readonly reads: number[] = [];
  closed = false;
  private offset = 0;

  constructor(
    private readonly rows: unknown[][],
    private readonly onRead?: () => void,
  ) {}

  async read(maxRows: number): Promise<SqlCursorBatch> {
    this.onRead?.();
    this.reads.push(maxRows);
    const rows = this.rows.slice(this.offset, this.offset + maxRows);
    this.offset += rows.length;
    return { rows, fields: [FIELD], command: "SELECT" };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function series(size: number): unknown[][] {
  return Array.from({ length: size }, (_, index) => [index + 1]);
}

describe("SQL cursor result sessions", () => {
  it("reaches an exact 1000-row result with four Next actions after the initial page", async () => {
    const reader = new FakeCursorReader(series(1_000));
    const session = await SqlResultSession.open(reader, {
      id: "session-1",
      binding: TEST_BINDING,
      pageSize: 200,
      maxCachedRows: 1_000,
    });

    expect(session.snapshot().navigation).toMatchObject({
      pageStart: 1,
      pageEnd: 200,
      hasNext: true,
    });
    expect(reader.reads).toEqual([201]);

    for (let index = 0; index < 4; index += 1) await session.next();
    const last = session.snapshot();
    expect(last.navigation).toMatchObject({
      pageStart: 801,
      pageEnd: 1_000,
      hasNext: false,
      hasPrevious: true,
    });
    expect(last.rowCount).toBe(1_000);
    expect(last.rows.at(-1)?.[0]?.value).toBe("1000");
    expect(reader.reads).toEqual([201, 200, 200, 200, 200]);
    expect(reader.closed).toBe(true);
  });

  it("navigates cached pages without re-reading PostgreSQL", async () => {
    const reader = new FakeCursorReader(series(450));
    const session = await SqlResultSession.open(reader, {
      binding: TEST_BINDING,
      pageSize: 200,
      maxCachedRows: 1_000,
    });
    await session.next();
    const reads = [...reader.reads];
    const previous = session.previous();
    expect(previous.navigation?.pageStart).toBe(1);
    expect(reader.reads).toEqual(reads);
  });

  it("loads every remaining row explicitly and reports progress", async () => {
    const reader = new FakeCursorReader(series(2_000));
    const session = await SqlResultSession.open(reader, {
      binding: TEST_BINDING,
      pageSize: 200,
      maxCachedRows: 1_000,
    });
    const progress: number[] = [];
    const result = await session.loadAll((loaded) => progress.push(loaded));

    expect(result.navigation).toMatchObject({
      mode: "all",
      pageStart: 1,
      pageEnd: 2_000,
      hasNext: false,
      canLoadAll: false,
    });
    expect(result.rowCount).toBe(2_000);
    expect(result.rows).toHaveLength(2_000);
    expect(progress.at(-1)).toBe(2_000);
    expect(reader.closed).toBe(true);
  });

  it("splits oversized pages without dropping cursor rows", async () => {
    const reader = new FakeCursorReader([["x".repeat(120)], ["y".repeat(120)], ["z"]]);
    const session = await SqlResultSession.open(reader, {
      binding: TEST_BINDING,
      pageSize: 20,
      maxCachedRows: 100,
      maxPayloadBytes: 65_650,
    });

    expect(session.snapshot().rows).toHaveLength(1);
    expect(session.snapshot().navigation?.hasNext).toBe(true);
    await session.next();
    expect(session.snapshot().rows[0]?.[0]?.value).toBe("y".repeat(120));
    await session.next();
    expect(session.snapshot().rows[0]?.[0]?.value).toBe("z");
  });

  it("stops advertising Load all after the cache has evicted earlier rows", async () => {
    const reader = new FakeCursorReader(series(100));
    const session = await SqlResultSession.open(reader, {
      binding: TEST_BINDING,
      pageSize: 20,
      maxCachedRows: 20,
    });

    expect(session.snapshot().navigation?.canLoadAll).toBe(true);
    await session.next();
    expect(session.snapshot().navigation).toMatchObject({
      cacheStart: 21,
      canLoadAll: false,
    });
  });

  it("marks an exhausted final page as partial after earlier rows were evicted", async () => {
    const reader = new FakeCursorReader(series(60));
    const session = await SqlResultSession.open(reader, {
      binding: TEST_BINDING,
      pageSize: 20,
      maxCachedRows: 20,
    });

    while (session.snapshot().navigation?.hasNext) await session.next();
    const result = session.snapshot();
    expect(result).toMatchObject({
      rowCount: 60,
      capturedRowCount: 20,
      truncated: true,
      truncationReasons: ["rows"],
    });
    expect(result.navigation).toMatchObject({
      pageStart: 41,
      pageEnd: 60,
      hasPrevious: false,
      hasNext: false,
      canLoadAll: false,
    });
  });

  it("reports cursor execution time without counting idle time between pages", async () => {
    let now = 10;
    const reader = new FakeCursorReader(series(40), () => {
      now += 5;
    });
    const session = await SqlResultSession.open(reader, {
      binding: TEST_BINDING,
      pageSize: 20,
      maxCachedRows: 40,
      now: () => now,
    });
    expect(session.snapshot().durationMs).toBe(5);

    now += 240_000;
    expect(session.snapshot().durationMs).toBe(5);
    await session.next();
    expect(session.snapshot().durationMs).toBe(10);
  });
});
