import { describe, expect, it } from "vitest";
import type { DebugResult, DebugResultStatus } from "../../dap/src/debugger/launch/index.js";
import { DEBUG_RESULT_NULL_EXPORT, DebugResultStore } from "./capturedResults.js";

function result(id: string, payloadBytes = 100): DebugResult {
  return {
    id,
    label: "public.test_simple · demo.sql:42",
    query: "SELECT public.test_simple(1)",
    source: { name: "demo.sql", uri: "file:///workspace/demo.sql", line: 42 },
    command: "SELECT",
    columns: [
      { name: "id", dataTypeId: 23, typeName: "integer" },
      { name: "value", dataTypeId: 25, typeName: "text" },
    ],
    rows: [
      [
        { kind: "number", value: "1" },
        { kind: "text", value: 'hello, "world"' },
      ],
    ],
    rowCount: 1,
    capturedRowCount: 1,
    truncated: false,
    truncationReasons: [],
    durationMs: 12,
    timestamp: "2026-07-25T12:00:00.000Z",
    payloadBytes,
  };
}

describe("DebugResultStore", () => {
  it("attributes each result to the Connection that produced it", () => {
    const store = new DebugResultStore(2, 1_000);
    const binding = (host: string) => ({
      connectionId: `${host}-id`,
      connectionName: `postgres@${host}:5432/demo`,
      database: "demo",
    });
    store.add(result("one"), binding("first"));
    store.add(result("two"), binding("second"));
    store.add(result("three"));

    expect(store.viewState().results.map(({ id, connection }) => ({ id, connection }))).toEqual([
      { id: "three", connection: undefined },
      { id: "two", connection: "postgres@second:5432/demo" },
    ]);
    expect(store.viewState().selectedBinding).toBeUndefined();
    store.select("two");
    expect(store.viewState().selectedBinding).toEqual(binding("second"));
    expect(store.bindingOf("one")).toBeUndefined();
    store.clear();
    expect(store.bindingOf("two")).toBeUndefined();
  });

  it("keeps bounded history and selects the newest result", () => {
    const store = new DebugResultStore(2, 1_000);
    store.add(result("one"));
    store.add(result("two"));
    store.add(result("three"));

    expect(store.size).toBe(2);
    expect(store.selected?.id).toBe("three");
    expect(store.viewState().results.map((item) => item.id)).toEqual(["three", "two"]);
  });

  it("replaces pending and failed states by id without leaving stale successes selected", () => {
    const store = new DebugResultStore();
    const pending: DebugResultStatus = {
      id: "run",
      status: "pending",
      label: "public.test_simple",
      query: "SELECT public.test_simple(1)",
      timestamp: "2026-07-25T12:00:00.000Z",
    };
    store.addStatus(pending);

    expect(store.selected).toBeUndefined();
    expect(store.selectedEntry).toEqual(pending);
    expect(store.viewState().results[0]).toMatchObject({
      id: "run",
      status: "pending",
      label: "public.test_simple",
    });

    const failed: DebugResultStatus = {
      ...pending,
      status: "error",
      message: "division by zero",
      durationMs: 31,
    };
    store.addStatus(failed);
    expect(store.size).toBe(1);
    expect(store.selectedEntry).toEqual(failed);

    store.add(result("run"));
    expect(store.size).toBe(1);
    expect(store.selected?.id).toBe("run");
    expect(store.viewState().results[0].status).toBe("success");
  });

  it("trims history by retained payload bytes", () => {
    const store = new DebugResultStore(10, 250);
    store.add(result("one", 150));
    store.add(result("two", 150));

    expect(store.size).toBe(1);
    expect(store.selected?.id).toBe("two");
  });

  it("exports the captured preview without losing duplicate-safe row shape", () => {
    const store = new DebugResultStore();
    store.add(result("one"));

    expect(store.selectedAsTsv()).toBe('id\tvalue\n1\t"hello, ""world"""');
    expect(store.selectedAsCsv()).toBe('id,value\n1,"hello, ""world"""');
    expect(JSON.parse(store.selectedAsJson() ?? "")).toMatchObject({
      columns: [
        { name: "id", dataTypeId: 23, typeName: "integer" },
        { name: "value", dataTypeId: 25, typeName: "text" },
      ],
      rows: [["1", 'hello, "world"']],
      truncated: false,
      truncationReasons: [],
    });
  });

  it("keeps PostgreSQL NULL distinct from an empty string and exports truncation metadata", () => {
    const captured = result("nulls");
    captured.rows[0] = [
      { kind: "null", value: null },
      { kind: "text", value: "", truncated: true },
    ];
    captured.truncated = true;
    captured.truncationReasons = ["cell"];
    const store = new DebugResultStore();
    store.add(captured);

    expect(store.selectedAsTsv()).toBe(`id\tvalue\n${DEBUG_RESULT_NULL_EXPORT}\t`);
    expect(store.selectedAsCsv()).toBe(`id,value\n${DEBUG_RESULT_NULL_EXPORT},`);
    expect(JSON.parse(store.selectedAsJson() ?? "")).toMatchObject({
      rows: [[null, ""]],
      truncated: true,
      truncationReasons: ["cell"],
      cellTruncations: [{ row: 0, column: 1 }],
    });
  });

  it("neutralizes spreadsheet formulas in CSV and TSV exports", () => {
    const unsafe = result("formula");
    unsafe.columns[0].name = "=header";
    unsafe.rows[0][0].value = '=HYPERLINK("https://example.invalid")';
    unsafe.rows[0][1].value = "+1+1";
    const store = new DebugResultStore();
    store.add(unsafe);

    expect(store.selectedAsTsv()).toContain("'=header");
    expect(store.selectedAsTsv()).toContain(`"'=HYPERLINK(""https://example.invalid"")"`);
    expect(store.selectedAsTsv()).toContain("'+1+1");
    expect(store.selectedAsCsv()).toContain("'=header");
    expect(store.selectedAsJson()).toContain('=HYPERLINK(\\"https://example.invalid\\")');
  });
});
