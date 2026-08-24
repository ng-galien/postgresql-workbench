import { describe, expect, it } from "vitest";
import type {
  SqlCommandReportPayload,
  SqlNotebookResultPayload,
} from "../../../rows/src/resultPayload.js";
import {
  statementResultBadge,
  statementResultCapabilities,
  statementResultRegionLabel,
  statementResultSummary,
  statementResultTable,
} from "./statementResult.js";

const binding = {
  connectionId: "test",
  connectionName: "Test PostgreSQL",
  database: "testdb",
};

const rowset: SqlNotebookResultPayload = {
  version: 3,
  kind: "rowset",
  binding,
  command: "SELECT",
  columns: [{ name: "answer", dataTypeId: 23, typeName: "integer" }],
  rows: [[{ kind: "number", value: "42" }]],
  rowCount: 1,
  capturedRowCount: 1,
  durationMs: 4,
  truncated: false,
  truncationReasons: [],
};

const report: SqlCommandReportPayload = {
  version: 3,
  kind: "command-report",
  binding,
  durationMs: 7,
  entries: [
    { operation: "INSERT", affectedRows: 2 },
    { operation: "UPDATE", affectedRows: 3 },
    { operation: "DELETE", affectedRows: 1 },
  ],
};

describe("statement result contract", () => {
  it("assigns every control capability from the closed result kind", () => {
    expect(statementResultCapabilities(rowset)).toEqual({
      selection: true,
      sorting: true,
      inspection: true,
      export: true,
      navigation: true,
      links: true,
    });
    expect(statementResultCapabilities(report)).toEqual({
      selection: true,
      sorting: true,
      inspection: false,
      export: false,
      navigation: false,
      links: false,
    });
  });

  it("projects command entries into the common table without changing their meaning", () => {
    expect(statementResultTable(report)).toMatchObject({
      columns: [{ name: "operation" }, { name: "rows_affected" }],
      rows: [
        [{ value: "INSERT" }, { value: "2" }],
        [{ value: "UPDATE" }, { value: "3" }],
        [{ value: "DELETE" }, { value: "1" }],
      ],
      rowCount: 3,
      capturedRowCount: 3,
    });
    expect(statementResultTable(rowset)).toBe(rowset);
    expect(statementResultBadge(report)).toBe("COMMANDS");
    expect(statementResultRegionLabel(rowset)).toBe("PostgreSQL query result");
    expect(statementResultRegionLabel(report)).toBe("PostgreSQL command report");
    expect(statementResultSummary(report)).toBe("6 rows affected across 3 operations");
  });
});
