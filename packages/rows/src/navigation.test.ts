import { describe, expect, it } from "vitest";
import { navigationReadsPostgres } from "./navigation.js";
import type { SqlNotebookResultPayload } from "./resultPayload.js";

function payload(
  overrides: Partial<SqlNotebookResultPayload["navigation"]> = {},
  rowCount?: number,
): SqlNotebookResultPayload {
  return {
    version: 3,
    kind: "rowset",
    binding: { connectionId: "test", connectionName: "test", database: "test" },
    command: "SELECT",
    columns: [],
    rows: [],
    ...(rowCount === undefined ? {} : { rowCount }),
    capturedRowCount: 0,
    durationMs: 0,
    truncated: false,
    truncationReasons: [],
    navigation: {
      sessionId: "result-1",
      mode: "paged",
      pageIndex: 0,
      pageSize: 200,
      pageStart: 1,
      pageEnd: 200,
      loadedRowCount: 200,
      hasPrevious: false,
      hasNext: true,
      canLoadAll: true,
      ...overrides,
    },
  };
}

describe("cancellable result navigation", () => {
  it("reads PostgreSQL only when Next has no retained page", () => {
    expect(navigationReadsPostgres("next", payload())).toBe(true);
    expect(navigationReadsPostgres("next", payload({ pageEnd: 200, loadedRowCount: 400 }))).toBe(
      false,
    );
  });

  it("never treats Previous or Cancel as a new PostgreSQL page read", () => {
    expect(navigationReadsPostgres("previous", payload())).toBe(false);
    expect(navigationReadsPostgres("cancel", payload())).toBe(false);
  });

  it("reads PostgreSQL for Load all only while the total is still unknown", () => {
    expect(navigationReadsPostgres("load-all", payload())).toBe(true);
    expect(navigationReadsPostgres("load-all", payload({}, 400))).toBe(false);
  });
});
