import type { Client, FieldDef } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  type OffsetQueryBatch,
  type OffsetQuerySource,
  OffsetResultSession,
  offsetPageSql,
  PostgresOffsetQuerySource,
} from "./offsetQuery.js";

const binding = {
  connectionId: "connection-1",
  connectionName: "PostgreSQL",
  database: "demo",
};

const field: FieldDef = {
  name: "id",
  tableID: 0,
  columnID: 0,
  dataTypeID: 23,
  dataTypeSize: 4,
  dataTypeModifier: -1,
  format: "text",
};

class MemoryOffsetSource implements OffsetQuerySource {
  readonly reads: { offset: number; limit: number }[] = [];
  cancelled = false;

  constructor(private readonly rows: unknown[][]) {}

  async read(offset: number, limit: number): Promise<OffsetQueryBatch> {
    this.reads.push({ offset, limit });
    return { rows: this.rows.slice(offset, offset + limit), fields: [field], command: "SELECT" };
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }
}

describe("LIMIT/OFFSET result contract", () => {
  it("wraps the source query once and strips only trailing semicolons", () => {
    expect(offsetPageSql(" select * from inventory; ", 201, 400)).toBe(
      'SELECT * FROM (\nselect * from inventory\n) AS "postgresql_workbench_page" LIMIT 201 OFFSET 400',
    );
  });

  it("executes independent offset pages and keeps prior pages in memory", async () => {
    const source = new MemoryOffsetSource(
      Array.from({ length: 45 }, (_, index) => [String(index + 1)]),
    );
    const result = await OffsetResultSession.open(source, { binding, pageSize: 20 });

    expect(source.reads).toEqual([{ offset: 0, limit: 21 }]);
    await result.next();
    expect(source.reads).toEqual([
      { offset: 0, limit: 21 },
      { offset: 20, limit: 21 },
    ]);
    expect(result.snapshot().navigation).toMatchObject({ pageStart: 21, pageEnd: 40 });
    expect(result.previous().navigation).toMatchObject({ pageStart: 1, pageEnd: 20 });
    expect(source.reads).toHaveLength(2);
  });

  it("opens and releases one PostgreSQL connection for one page", async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockResolvedValue({ rows: [["21"]], fields: [field], command: "SELECT" });
    const openClient = vi.fn().mockResolvedValue({ query, end });
    const source = new PostgresOffsetQuerySource(openClient, "select id from inventory");

    await expect(source.read(20, 21)).resolves.toMatchObject({ rows: [["21"]] });
    expect(openClient).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith({
      text: 'SELECT * FROM (\nselect id from inventory\n) AS "postgresql_workbench_page" LIMIT 21 OFFSET 20',
      rowMode: "array",
    });
    expect(end).toHaveBeenCalledOnce();
  });

  it("cancels a connection that finishes opening after cancellation", async () => {
    let resolveClient!: (client: Client) => void;
    const query = vi.fn();
    const end = vi.fn().mockResolvedValue(undefined);
    const source = new PostgresOffsetQuerySource(
      () => new Promise((resolve) => (resolveClient = resolve)),
      "select id from inventory",
    );
    const reading = source.read(20, 21);
    await source.cancel();
    resolveClient({ query, end } as unknown as Client);

    await expect(reading).rejects.toThrow("Result loading cancelled");
    expect(query).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledOnce();
  });

  it("rejects a changed row description without mutating retained pages", async () => {
    let read = 0;
    const source: OffsetQuerySource = {
      read: async (_offset, limit) => {
        read += 1;
        return {
          rows: Array.from({ length: limit }, (_, index) => [String(index + 1)]),
          fields: [{ ...field, name: read === 1 ? "id" : "renamed_id" }],
          command: "SELECT",
        };
      },
      cancel: async () => {},
    };
    const result = await OffsetResultSession.open(source, { binding, pageSize: 20 });

    await expect(result.next()).rejects.toThrow("result shape changed");
    expect(result.snapshot().columns[0]?.name).toBe("id");
    expect(result.loadedResult().rows).toHaveLength(20);
  });

  it("loads the remaining rows with offset queries and retains the full result", async () => {
    const source = new MemoryOffsetSource(
      Array.from({ length: 6_010 }, (_, index) => [String(index + 1)]),
    );
    const result = await OffsetResultSession.open(source, { binding, pageSize: 20 });
    const loaded = await result.loadAll();

    expect(source.reads).toEqual([
      { offset: 0, limit: 21 },
      { offset: 20, limit: 5_001 },
      { offset: 5_020, limit: 5_001 },
    ]);
    expect(loaded).toMatchObject({ rowCount: 6_010, capturedRowCount: 6_010 });
    expect(result.loadedResult().rows).toHaveLength(6_010);
  });

  it("cancels only the currently executing page source", async () => {
    const source = new MemoryOffsetSource([["1"]]);
    const result = await OffsetResultSession.open(source, { binding, pageSize: 20 });
    await result.close();
    expect(source.cancelled).toBe(true);
  });
});
