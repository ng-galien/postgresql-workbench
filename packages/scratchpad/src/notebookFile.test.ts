import { describe, expect, it } from "vitest";
import type { DebugResult } from "../../dap/src/debugger/launch/index.js";
import {
  emptySqlNotebook,
  nextSqlNotebookName,
  normalizeSqlNotebookName,
  parseSqlNotebookFile,
  resolveScratchpadAssociation,
  scratchpadCellExecutionIntent,
  scratchpadCreationAssociation,
  scratchpadExecutionMode,
  scratchpadStatementTimeoutMs,
  serializeSqlNotebookFile,
  sqlNotebookCommandReportPayload,
  sqlNotebookResultPayload,
} from "./notebookFile.js";

const TEST_BINDING = {
  connectionId: "connection-a",
  connectionName: "postgres@localhost/app",
  database: "app",
};

const TEST_CONNECTION = {
  id: TEST_BINDING.connectionId,
  name: TEST_BINDING.connectionName,
  host: "localhost",
  port: 5432,
  database: TEST_BINDING.database,
  user: "postgres",
};

describe("SQL notebook model", () => {
  it("follows the Scratchpad creation Association rule for zero, one, or many Connections", () => {
    expect(scratchpadCreationAssociation([])).toEqual({ kind: "unassociated" });
    expect(scratchpadCreationAssociation([TEST_CONNECTION])).toEqual({
      kind: "automatic",
      connection: TEST_CONNECTION,
    });
    expect(
      scratchpadCreationAssociation([TEST_CONNECTION, { ...TEST_CONNECTION, id: "connection-b" }]),
    ).toEqual({ kind: "choose" });
  });

  it("persists MANUAL while treating an absent Mode as AUTO", () => {
    expect(scratchpadExecutionMode({})).toBe("auto");
    expect(
      parseSqlNotebookFile(
        serializeSqlNotebookFile({
          version: 1,
          metadata: { executionMode: "manual" },
          cells: [],
        }),
      ).metadata,
    ).toEqual({ executionMode: "manual" });
  });

  it("persists a per-cell Debug intent while Run remains the default", () => {
    expect(scratchpadCellExecutionIntent(undefined)).toBe("run");
    const file = parseSqlNotebookFile(
      serializeSqlNotebookFile({
        version: 1,
        metadata: {},
        cells: [
          {
            kind: "code",
            language: "plpgsql",
            source: "SELECT * FROM shop.restock_report(5);",
            metadata: { executionIntent: "debug" },
          },
        ],
      }),
    );
    expect(file.cells[0]?.metadata).toEqual({ executionIntent: "debug" });
    expect(scratchpadCellExecutionIntent(file.cells[0]?.metadata)).toBe("debug");
  });

  it("persists one Scratchpad timeout override and otherwise uses the global timeout", () => {
    expect(scratchpadStatementTimeoutMs({}, 60_000)).toBe(60_000);
    expect(scratchpadStatementTimeoutMs({ statementTimeoutMs: 300_000 }, 60_000)).toBe(300_000);
    expect(
      parseSqlNotebookFile(
        serializeSqlNotebookFile({
          version: 1,
          metadata: { statementTimeoutMs: 300_000 },
          cells: [],
        }),
      ).metadata,
    ).toEqual({ statementTimeoutMs: 300_000 });
    expect(
      parseSqlNotebookFile('{"version":1,"metadata":{"statementTimeoutMs":0},"cells":[]}').metadata,
    ).toEqual({});
  });

  it("uses the domain Association states without inferring a Connection", () => {
    expect(resolveScratchpadAssociation({}, [TEST_CONNECTION])).toEqual({ status: "unassociated" });
    expect(resolveScratchpadAssociation(TEST_BINDING, [TEST_CONNECTION])).toEqual({
      status: "associated",
      snapshot: TEST_BINDING,
      connection: TEST_CONNECTION,
    });
    expect(resolveScratchpadAssociation(TEST_BINDING, [])).toEqual({
      status: "unavailable",
      snapshot: TEST_BINDING,
    });
  });

  it("creates a persistent notebook with one PostgreSQL cell", () => {
    expect(emptySqlNotebook({ connectionId: "connection-a", database: "app" })).toEqual({
      version: 1,
      metadata: { connectionId: "connection-a", database: "app" },
      cells: [{ kind: "code", language: "plpgsql", source: "" }],
    });
  });

  it("allocates a short human-readable scratch name", () => {
    expect(
      nextSqlNotebookName([
        "scratch-20260807T113828-810be8a8.pgsql-notebook",
        "Scratch 001.pgsql-notebook",
        "Scratch 003.pgsql-notebook",
      ]),
    ).toBe("Scratch 004.pgsql-notebook");
  });

  it("normalizes user-facing scratchpad names without accepting paths", () => {
    expect(normalizeSqlNotebookName("  Investigation  ")).toBe("Investigation.pgsql-notebook");
    expect(normalizeSqlNotebookName("Report.pgsql-notebook")).toBe("Report.pgsql-notebook");
    expect(() => normalizeSqlNotebookName("../Report")).toThrow("not valid");
    expect(() => normalizeSqlNotebookName("CON")).toThrow("portable");
    expect(() => normalizeSqlNotebookName("Report.")).toThrow("end with a period");
    expect(() => normalizeSqlNotebookName(" ")).toThrow("non-empty");
  });

  it("normalizes serialized cells and ignores transient outputs", () => {
    const serialized = serializeSqlNotebookFile({
      version: 1,
      metadata: { connectionId: "connection-a", database: "app" },
      cells: [
        { kind: "code", language: "plpgsql", source: "select 1;" },
        { kind: "markup", language: "markdown", source: "# Notes" },
      ],
    });

    expect(parseSqlNotebookFile(serialized)).toEqual({
      version: 1,
      metadata: { connectionId: "connection-a", database: "app" },
      cells: [
        { kind: "code", language: "plpgsql", source: "select 1;" },
        { kind: "markup", language: "markdown", source: "# Notes" },
      ],
    });
  });

  it("rejects unknown notebook versions", () => {
    expect(() => parseSqlNotebookFile('{"version":2,"cells":[]}')).toThrow(
      "Unsupported Scratchpad file version",
    );
  });

  it("resolves legacy metadata without rewriting or inferring a context", () => {
    const persisted = { serverId: "connection-a", serverName: "Legacy", database: "app" };
    const metadata = parseSqlNotebookFile(
      JSON.stringify({ version: 1, metadata: persisted, cells: [] }),
    ).metadata;
    expect(resolveScratchpadAssociation(metadata, [TEST_CONNECTION])).toEqual({
      status: "associated",
      snapshot: TEST_BINDING,
      connection: TEST_CONNECTION,
    });
    expect(resolveScratchpadAssociation(metadata, [])).toEqual({
      status: "unavailable",
      snapshot: { ...metadata },
    });
    expect(resolveScratchpadAssociation({}, [TEST_CONNECTION])).toEqual({
      status: "unassociated",
    });
    expect(
      JSON.parse(serializeSqlNotebookFile({ version: 1, metadata, cells: [] })).metadata,
    ).toEqual({
      serverId: "connection-a",
      serverName: "Legacy",
      database: "app",
    });
    expect(persisted).toEqual({
      serverId: "connection-a",
      serverName: "Legacy",
      database: "app",
    });
    expect(metadata).toEqual({
      connectionId: "connection-a",
      connectionName: "Legacy",
      database: "app",
    });
  });

  it("projects bounded query results into the renderer contract", () => {
    const result: DebugResult = {
      id: "query-1",
      command: "SELECT",
      columns: [{ name: "answer", dataTypeId: 23, typeName: "integer" }],
      rows: [[{ kind: "number", value: "42" }]],
      rowCount: 1,
      capturedRowCount: 1,
      truncated: false,
      truncationReasons: [],
      durationMs: 4,
      timestamp: "2026-08-07T00:00:00.000Z",
      payloadBytes: 100,
    };

    expect(sqlNotebookResultPayload(result, TEST_BINDING)).toEqual({
      version: 3,
      kind: "rowset",
      binding: TEST_BINDING,
      command: "SELECT",
      columns: result.columns,
      rows: result.rows,
      rowCount: 1,
      capturedRowCount: 1,
      durationMs: 4,
      truncated: false,
      truncationReasons: [],
    });
  });

  it("projects INSERT, UPDATE and DELETE command tags into closed command reports", () => {
    const result = (command: "INSERT" | "UPDATE" | "DELETE", rowCount: number): DebugResult => ({
      id: command,
      command,
      columns: [],
      rows: [],
      rowCount,
      capturedRowCount: 0,
      truncated: false,
      truncationReasons: [],
      durationMs: 7,
      timestamp: "2026-08-24T00:00:00.000Z",
      payloadBytes: 100,
    });

    expect(
      [result("INSERT", 2), result("UPDATE", 3), result("DELETE", 1)].map((entry) =>
        sqlNotebookCommandReportPayload(entry, TEST_BINDING),
      ),
    ).toEqual([
      {
        version: 3,
        kind: "command-report",
        binding: TEST_BINDING,
        durationMs: 7,
        entries: [{ operation: "INSERT", affectedRows: 2 }],
      },
      {
        version: 3,
        kind: "command-report",
        binding: TEST_BINDING,
        durationMs: 7,
        entries: [{ operation: "UPDATE", affectedRows: 3 }],
      },
      {
        version: 3,
        kind: "command-report",
        binding: TEST_BINDING,
        durationMs: 7,
        entries: [{ operation: "DELETE", affectedRows: 1 }],
      },
    ]);
    expect(
      sqlNotebookCommandReportPayload({ ...result("UPDATE", 3), command: "CREATE" }, TEST_BINDING),
    ).toBeUndefined();
  });
});
