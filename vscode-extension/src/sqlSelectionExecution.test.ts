import type { Client, FieldDef, Query } from "pg";
import { describe, expect, it } from "vitest";
import type { DebugResult, DebugResultStatus } from "../../src/debugger/launch/index.js";
import { executeSqlSelection, prepareSqlSelection } from "./sqlSelectionExecution.js";

const singleStatement = async () => "single-statement" as const;
const multipleStatements = async () => "multiple-statements" as const;
const unclassifiable = async () => "unclassifiable" as const;

const FIELD: FieldDef = {
  name: "answer",
  tableID: 0,
  columnID: 0,
  dataTypeID: 23,
  dataTypeSize: 4,
  dataTypeModifier: -1,
  format: "text",
};

function fakeClient(outcome: "success" | "error"): Client {
  return {
    query(query: Query<never>) {
      queueMicrotask(() => {
        if (outcome === "error") {
          query.emit("error", new Error("relation missing_table does not exist"));
          return;
        }
        const result = {
          command: "SELECT",
          fields: [FIELD],
          oid: 0,
          rowCount: 1,
          rows: [],
        };
        query.emit("row", [42], result);
        query.emit("end", result);
      });
      return query;
    },
  } as unknown as Client;
}

describe("SQL selection execution", () => {
  it("keeps exactly the non-empty selection and rejects unsupported editor states", () => {
    const text = "SELECT 1;\n  SELECT 42 AS answer;  \n";
    const start = text.indexOf("  SELECT 42");
    const end = text.indexOf("\n", start);

    expect(
      prepareSqlSelection({
        languageId: "sql",
        documentText: text,
        selectionStart: start,
        selectionEnd: end,
        source: { name: "scratch.sql", uri: "file:///scratch.sql", line: 2 },
      }),
    ).toEqual({
      status: "ready",
      sql: "  SELECT 42 AS answer;  ",
      source: { name: "scratch.sql", uri: "file:///scratch.sql", line: 2 },
    });
    expect(
      prepareSqlSelection({
        languageId: "sql",
        documentText: text,
        selectionStart: 0,
        selectionEnd: 0,
      }),
    ).toEqual({ status: "empty-selection" });
    expect(
      prepareSqlSelection({
        languageId: "typescript",
        documentText: "SELECT 1",
        selectionStart: 0,
        selectionEnd: 8,
      }),
    ).toEqual({ status: "unsupported-language" });
  });

  it("publishes pending then bounded success or error through the shared result contract", async () => {
    const entries: Array<DebugResult | DebugResultStatus> = [];
    const sink = {
      add: (result: DebugResult) => entries.push(result),
      addStatus: (status: DebugResultStatus) => entries.push(status),
    };
    const selection = {
      status: "ready" as const,
      sql: "SELECT 42 AS answer",
      source: { name: "scratch.sql", uri: "file:///scratch.sql", line: 2 },
    };

    const success = await executeSqlSelection(fakeClient("success"), selection, sink, {
      id: "sql-1",
      maxRows: 20,
      classifyStatementCount: singleStatement,
      now: (() => {
        let value = 100;
        return () => (value += 5);
      })(),
      timestamp: "2026-07-29T15:00:00.000Z",
    });
    expect(entries[0]).toMatchObject({ id: "sql-1", status: "pending" });
    expect(success).toMatchObject({
      id: "sql-1",
      command: "SELECT",
      rowCount: 1,
      rows: [[{ kind: "number", value: "42" }]],
      source: selection.source,
    });

    const failedEntries: Array<DebugResult | DebugResultStatus> = [];
    const failure = await executeSqlSelection(
      fakeClient("error"),
      { ...selection, sql: "SELECT * FROM missing_table" },
      {
        add: (result) => failedEntries.push(result),
        addStatus: (status) => failedEntries.push(status),
      },
      {
        id: "sql-2",
        maxRows: 20,
        classifyStatementCount: singleStatement,
        now: () => 200,
        timestamp: "2026-07-29T15:00:01.000Z",
      },
    );
    expect(failure).toMatchObject({
      id: "sql-2",
      status: "error",
      message: "relation missing_table does not exist",
    });
    expect(failedEntries.map((entry) => ("status" in entry ? entry.status : "success"))).toEqual([
      "pending",
      "error",
    ]);
  });

  it("rejects multiple top-level statements before querying while accepting routine bodies", async () => {
    const entries: Array<DebugResult | DebugResultStatus> = [];
    const client = {
      query() {
        throw new Error("The database must not be queried");
      },
    } as unknown as Client;
    const rejected = await executeSqlSelection(
      client,
      {
        status: "ready",
        sql: "SELECT 1; SELECT 2;",
      },
      {
        add: (result) => entries.push(result),
        addStatus: (status) => entries.push(status),
      },
      {
        id: "sql-multiple",
        maxRows: 20,
        classifyStatementCount: multipleStatements,
      },
    );

    expect(rejected).toEqual({ status: "multiple-statements" });
    expect(entries).toEqual([]);

    await expect(
      executeSqlSelection(
        client,
        { status: "ready", sql: "SELECT deeply_nested_source" },
        { add: () => undefined, addStatus: () => undefined },
        { maxRows: 20, classifyStatementCount: unclassifiable },
      ),
    ).resolves.toEqual({ status: "unclassifiable" });
  });
});
