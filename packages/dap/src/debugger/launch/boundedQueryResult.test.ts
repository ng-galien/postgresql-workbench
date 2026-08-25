import { Buffer } from "node:buffer";
import type { Client, FieldDef, Query } from "pg";
import { describe, expect, it } from "vitest";
import { formatQueryResultRowRetained, runBoundedQuery } from "./boundedQueryResult.js";
import {
  clampDebugResultRows,
  createDebugResultContext,
  DEBUG_RESULT_LIMITS,
} from "./debugResult.js";

const FIELDS: FieldDef[] = [
  {
    name: "id",
    tableID: 0,
    columnID: 0,
    dataTypeID: 23,
    dataTypeSize: 4,
    dataTypeModifier: -1,
    format: "text",
  },
  {
    name: "payload",
    tableID: 0,
    columnID: 0,
    dataTypeID: 3802,
    dataTypeSize: -1,
    dataTypeModifier: -1,
    format: "text",
  },
];

function fakeClient(rows: unknown[][], fields = FIELDS): Client {
  return {
    query(query: Query<never>) {
      expect(query.listenerCount("row")).toBe(1);
      const result = {
        command: "SELECT",
        fields,
        oid: 0,
        rowCount: rows.length,
        rows: [],
      };
      queueMicrotask(() => {
        for (const row of rows) query.emit("row", row, result);
        query.emit("end", result);
      });
      return query;
    },
  } as unknown as Client;
}

describe("bounded query results", () => {
  it("keeps a timestamp returned as a Date in its PostgreSQL text shape", () => {
    const timestamp = new Date("2026-08-21T14:00:08.399Z");
    const field: FieldDef = {
      ...FIELDS[0],
      name: "created_at",
      dataTypeID: 1184,
    };

    expect(
      formatQueryResultRowRetained([timestamp], [field], DEBUG_RESULT_LIMITS.MAX_CELL_BYTES),
    ).toEqual([{ kind: "text", value: "2026-08-21T14:00:08.399Z" }]);
  });

  it("streams every row but only retains the configured preview", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => [
      index + 1,
      JSON.stringify({ index: index + 1 }),
    ]);

    const result = await runBoundedQuery(fakeClient(rows), "SELECT test_many_rows(5)", [], {
      id: "result-1",
      label: "test_many_rows · demo.sql:12",
      source: { name: "demo.sql", uri: "file:///workspace/demo.sql", line: 12 },
      maxRows: 2,
      now: (() => {
        let value = 100;
        return () => (value += 5);
      })(),
    });

    expect(result).toMatchObject({
      id: "result-1",
      label: "test_many_rows · demo.sql:12",
      query: "SELECT test_many_rows(5)",
      source: { name: "demo.sql", uri: "file:///workspace/demo.sql", line: 12 },
      command: "SELECT",
      rowCount: 5,
      capturedRowCount: 2,
      truncated: true,
      truncationReasons: ["rows"],
      durationMs: 5,
    });
    expect(result.rows[0]).toEqual([
      { kind: "number", value: "1" },
      { kind: "json", value: '{"index":1}' },
    ]);
    expect(result.columns).toEqual([
      { name: "id", dataTypeId: 23, typeName: "integer" },
      { name: "payload", dataTypeId: 3802, typeName: "jsonb" },
    ]);
  });

  it("bounds individual values and the final serialized payload", async () => {
    const huge = "🚀".repeat(100);
    const result = await runBoundedQuery(fakeClient([[1, huge]]), "SELECT test_large_value()", [], {
      id: "result-2",
      maxRows: 20,
      maxCellBytes: 32,
      maxPayloadBytes: 350,
    });

    expect(Buffer.byteLength(result.rows[0]?.[1]?.value ?? "", "utf8")).toBeLessThanOrEqual(32);
    expect(result.truncationReasons).toContain("cell");
    expect(result.payloadBytes).toBeLessThanOrEqual(350);
  });

  it("truncates bytea before converting retained bytes to hex", async () => {
    const binaryField: FieldDef[] = [{ ...FIELDS[0], name: "payload", dataTypeID: 17 }];
    const result = await runBoundedQuery(
      fakeClient([[Buffer.alloc(1024 * 1024)]], binaryField),
      "SELECT payload",
      [],
      {
        id: "result-binary",
        maxRows: 1,
        maxCellBytes: 16,
      },
    );

    expect(result.rows[0][0]).toEqual({
      kind: "binary",
      value: "\\x0000000000…",
      truncated: true,
      retainedTruncated: true,
    });
    expect(Buffer.byteLength(result.rows[0][0].value ?? "", "utf8")).toBeLessThanOrEqual(16);
  });

  it("clamps user row limits to the adapter safety range", () => {
    expect(clampDebugResultRows(undefined)).toBe(DEBUG_RESULT_LIMITS.DEFAULT_ROWS);
    expect(clampDebugResultRows(1)).toBe(DEBUG_RESULT_LIMITS.MIN_ROWS);
    expect(clampDebugResultRows(50.9)).toBe(50);
    expect(clampDebugResultRows(50_000)).toBe(DEBUG_RESULT_LIMITS.MAX_ROWS);
  });

  it("bounds display metadata carried by pending, success, and error events", () => {
    const context = createDebugResultContext("x".repeat(1_000), `SELECT ${"x".repeat(100_000)}`, {
      name: "n".repeat(2_000),
      uri: `file:///${"u".repeat(10_000)}`,
      line: -4,
    });

    expect(context.label).toHaveLength(DEBUG_RESULT_LIMITS.MAX_LABEL_CHARS);
    expect(context.query).toHaveLength(DEBUG_RESULT_LIMITS.MAX_QUERY_CHARS);
    expect(context.source?.name).toHaveLength(DEBUG_RESULT_LIMITS.MAX_SOURCE_NAME_CHARS);
    expect(context.source?.uri).toHaveLength(DEBUG_RESULT_LIMITS.MAX_SOURCE_URI_CHARS);
    expect(context.source?.line).toBe(1);
  });
});
