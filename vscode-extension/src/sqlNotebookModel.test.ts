import { describe, expect, it } from "vitest";
import type { DebugResult } from "../../src/debugger/launch/index.js";
import {
  emptySqlNotebook,
  nextSqlNotebookName,
  normalizeSqlNotebookName,
  parseSqlNotebookFile,
  resolveNotebookBinding,
  resolveScratchpadAssociation,
  scratchpadCreationAssociation,
  scratchpadExecutionMode,
  serializeSqlNotebookFile,
  sqlNotebookResultPayload,
} from "./sqlNotebookModel.js";

const TEST_BINDING = {
  serverId: "server-a",
  serverName: "postgres@localhost/app",
  database: "app",
};

const TEST_SERVER = {
  id: TEST_BINDING.serverId,
  name: TEST_BINDING.serverName,
  host: "localhost",
  port: 5432,
  database: TEST_BINDING.database,
  user: "postgres",
};

describe("SQL notebook model", () => {
  it("follows the Scratchpad creation Association rule for zero, one, or many Connexions", () => {
    expect(scratchpadCreationAssociation([])).toEqual({ kind: "unassociated" });
    expect(scratchpadCreationAssociation([TEST_SERVER])).toEqual({
      kind: "automatic",
      connection: TEST_SERVER,
    });
    expect(
      scratchpadCreationAssociation([TEST_SERVER, { ...TEST_SERVER, id: "server-b" }]),
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

  it("uses the domain Association states without inferring the active database context", () => {
    expect(resolveScratchpadAssociation({}, [TEST_SERVER])).toEqual({ status: "unassociated" });
    expect(resolveScratchpadAssociation(TEST_BINDING, [TEST_SERVER])).toEqual({
      status: "associated",
      snapshot: TEST_BINDING,
      connection: TEST_SERVER,
    });
    expect(resolveScratchpadAssociation(TEST_BINDING, [])).toEqual({
      status: "unavailable",
      snapshot: TEST_BINDING,
    });
  });

  it("creates a persistent notebook with one PostgreSQL cell", () => {
    expect(emptySqlNotebook({ serverId: "server-a", database: "app" })).toEqual({
      version: 1,
      metadata: { serverId: "server-a", database: "app" },
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
      metadata: { serverId: "server-a", database: "app" },
      cells: [
        { kind: "code", language: "plpgsql", source: "select 1;" },
        { kind: "markup", language: "markdown", source: "# Notes" },
      ],
    });

    expect(parseSqlNotebookFile(serialized)).toEqual({
      version: 1,
      metadata: { serverId: "server-a", database: "app" },
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
    const metadata = { serverId: "server-a", serverName: "Legacy", database: "app" };
    expect(resolveNotebookBinding(metadata, [TEST_SERVER])).toEqual({
      status: "bound",
      snapshot: TEST_BINDING,
      server: TEST_SERVER,
    });
    expect(resolveNotebookBinding(metadata, [])).toEqual({
      status: "unavailable",
      snapshot: { ...metadata },
    });
    expect(resolveNotebookBinding({}, [TEST_SERVER])).toEqual({ status: "unbound" });
    expect(metadata).toEqual({ serverId: "server-a", serverName: "Legacy", database: "app" });
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
      version: 2,
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
});
