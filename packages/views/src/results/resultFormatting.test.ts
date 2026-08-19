import { describe, expect, it } from "vitest";
import type { SqlNotebookResultPayload } from "./payload.js";
import {
  formattedCellValue,
  nextResultSort,
  resultAsTsv,
  resultSortNotice,
  sortedResultRows,
} from "./resultFormatting.js";

const TEST_BINDING = {
  serverId: "test-server",
  serverName: "Test PostgreSQL",
  database: "testdb",
};

describe("SQL notebook result formatting", () => {
  it("formats structured JSON for inspection", () => {
    expect(formattedCellValue({ kind: "json", value: '{"answer":42}' })).toBe(
      '{\n  "answer": 42\n}',
    );
  });

  it("keeps null distinct and neutralizes spreadsheet formulas", () => {
    const payload: SqlNotebookResultPayload = {
      version: 2,
      binding: TEST_BINDING,
      command: "SELECT",
      columns: [
        { name: "formula", dataTypeId: 25 },
        { name: "missing", dataTypeId: 25 },
      ],
      rows: [
        [
          { kind: "text", value: "=1+1" },
          { kind: "null", value: null },
        ],
      ],
      rowCount: 1,
      capturedRowCount: 1,
      durationMs: 1,
      truncated: false,
      truncationReasons: [],
    };

    expect(resultAsTsv(payload)).toBe("formula\tmissing\n'=1+1\t\\N");
  });

  it("sorts captured rows by typed column without mutating their source order", () => {
    const rows = [
      [{ kind: "number" as const, value: "10" }],
      [{ kind: "null" as const, value: null }],
      [{ kind: "number" as const, value: "2" }],
    ];

    expect(sortedResultRows(rows, { columnIndex: 0, direction: "ascending" })).toEqual([
      rows[2],
      rows[0],
      rows[1],
    ]);
    expect(sortedResultRows(rows, { columnIndex: 0, direction: "descending" })).toEqual([
      rows[1],
      rows[0],
      rows[2],
    ]);
    expect(rows[0]?.[0]?.value).toBe("10");
  });

  it("cycles a column sort through ascending, descending and source order", () => {
    const ascending = nextResultSort(undefined, 2);
    const descending = nextResultSort(ascending, 2);

    expect(ascending).toEqual({ columnIndex: 2, direction: "ascending" });
    expect(descending).toEqual({ columnIndex: 2, direction: "descending" });
    expect(nextResultSort(descending, 2)).toBeUndefined();
    expect(nextResultSort(descending, 1)).toEqual({
      columnIndex: 1,
      direction: "ascending",
    });
  });

  it("sorts PostgreSQL bigint and numeric values without IEEE-754 precision loss", () => {
    const rows = [
      [{ kind: "number" as const, value: "9007199254740993" }],
      [{ kind: "number" as const, value: "-1.20" }],
      [{ kind: "number" as const, value: "9007199254740992" }],
      [{ kind: "number" as const, value: "1.1e-3" }],
      [{ kind: "number" as const, value: "0.00101" }],
    ];

    expect(
      sortedResultRows(rows, { columnIndex: 0, direction: "ascending" }).map(
        (row) => row[0]?.value,
      ),
    ).toEqual(["-1.20", "0.00101", "1.1e-3", "9007199254740992", "9007199254740993"]);
  });

  it("sorts PostgreSQL infinity and NaN values using their numeric order", () => {
    const rows = ["NaN", "Infinity", "-100", "-Infinity", "0"].map((value) => [
      { kind: "number" as const, value },
    ]);

    expect(
      sortedResultRows(rows, { columnIndex: 0, direction: "ascending" }).map(
        (row) => row[0]?.value,
      ),
    ).toEqual(["-Infinity", "-100", "0", "Infinity", "NaN"]);
  });

  it("describes whether sorting uses a partial row set or truncated values", () => {
    const base: SqlNotebookResultPayload = {
      version: 2,
      binding: TEST_BINDING,
      command: "SELECT",
      columns: [],
      rows: [],
      rowCount: 5_000,
      capturedRowCount: 200,
      durationMs: 1,
      truncated: true,
      truncationReasons: ["rows"],
    };

    expect(resultSortNotice(base)).toBe("Sorting the 200 captured rows only.");
    expect(resultSortNotice({ ...base, truncationReasons: ["cell"] })).toBe(
      "Sorting uses truncated display values.",
    );
    expect(resultSortNotice({ ...base, truncationReasons: ["rows", "cell"] })).toBe(
      "Sorting the 200 captured rows using truncated display values.",
    );
  });
});
