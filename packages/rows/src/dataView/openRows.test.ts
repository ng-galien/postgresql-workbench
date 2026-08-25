import type { Client, FieldDef } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { DataViewEditability } from "./dataView.js";
import {
  dataViewCatalogKeysCoverRows,
  dataViewPageOrder,
  openDataViewResult,
  TableAccents,
} from "./openRows.js";

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

const options = {
  sql: "select 1 as id",
  settings: { pageSize: 20, maxCellBytes: 256 * 1024 },
  binding,
  accents: new TableAccents(),
  checkpoint: () => {},
};

function editability(keys: readonly number[][]): DataViewEditability {
  return {
    tables: keys.map((keyOrdinals, index) => ({
      tableOid: index + 1,
      schema: "shop",
      name: `table_${index + 1}`,
      keyOrdinals: [...keyOrdinals],
      keyColumns: keyOrdinals.map((ordinal) => `column_${ordinal}`),
      keyTypes: keyOrdinals.map(() => "integer"),
      referencedBy: [],
    })),
    columns: [],
    requiredOrdinals: [],
    technicalOrdinals: [],
  };
}

describe("Data View page ordering", () => {
  const fields = [{ name: "id" }, { name: "name" }, { name: "site_id" }];

  it("keeps the requested sort and appends the catalog key as a tie-breaker", () => {
    expect(
      dataViewPageOrder(fields, editability([[0]]), true, 1, [
        { column: "name", direction: "descending", nulls: "first" },
      ]),
    ).toEqual([
      { columnIndex: 1, direction: "descending", nulls: "first" },
      { columnIndex: 0, direction: "ascending" },
    ]);
  });

  it("does not append a key column already present in the requested sort", () => {
    expect(
      dataViewPageOrder(fields, editability([[0]]), true, 1, [
        { column: "id", direction: "descending" },
      ]),
    ).toEqual([{ columnIndex: 0, direction: "descending" }]);
  });

  it("appends every column of a composite key", () => {
    expect(dataViewPageOrder(fields, editability([[0, 2]]), true, 1, [])).toEqual([
      { columnIndex: 0, direction: "ascending" },
      { columnIndex: 2, direction: "ascending" },
    ]);
  });

  it("does not claim stability when a relation or requested sort cannot be resolved", () => {
    expect(dataViewPageOrder(fields, editability([[0]]), true, 2, [])).toEqual([]);
    expect(
      dataViewPageOrder(fields, editability([[0]]), true, 1, [{ direction: "ascending" }]),
    ).toEqual([]);
  });

  it("does not claim stability for a function or VALUES source beside a keyed table", () => {
    expect(dataViewPageOrder(fields, editability([[0]]), false, 1, [])).toEqual([]);
  });

  it("does not claim stability when table inheritance means the parent key does not cover rows", () => {
    const editable = editability([[0]]);
    expect(dataViewCatalogKeysCoverRows(editable, [{ tableOid: 1, hasSubclasses: true }])).toBe(
      false,
    );
    expect(dataViewPageOrder(fields, editable, false, 1, [])).toEqual([]);
  });

  it("covers keyed joins but rejects an ambiguous self-join", () => {
    expect(dataViewPageOrder(fields, editability([[0], [2]]), true, 2, [])).toEqual([
      { columnIndex: 0, direction: "ascending" },
      { columnIndex: 2, direction: "ascending" },
    ]);
    expect(dataViewPageOrder(fields, editability([[0]]), true, 2, [])).toEqual([]);
  });
});

describe("opening a Data View result", () => {
  it("can be cancelled while its probe connection is still opening", async () => {
    let resolveClient!: (client: Client) => void;
    let cancel!: () => Promise<void>;
    const query = vi.fn();
    const end = vi.fn().mockResolvedValue(undefined);
    const opening = openDataViewResult({
      ...options,
      openClient: () => new Promise((resolve) => (resolveClient = resolve)),
      registerCancellation: (registered) => (cancel = registered),
    });

    await cancel();
    resolveClient({ query, end } as unknown as Client);

    await expect(opening).rejects.toThrow("cancelled");
    expect(query).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledOnce();
  });

  it("ends the probe connection when cancelled during its query", async () => {
    let rejectQuery!: (error: Error) => void;
    let cancel!: () => Promise<void>;
    const query = vi.fn(
      () => new Promise((_resolve, reject) => (rejectQuery = reject)) as Promise<never>,
    );
    const end = vi.fn(async () => rejectQuery(new Error("connection terminated")));
    const opening = openDataViewResult({
      ...options,
      openClient: async () => ({ query, end }) as unknown as Client,
      registerCancellation: (registered) => (cancel = registered),
    });
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());

    await cancel();

    await expect(opening).rejects.toThrow("connection terminated");
    expect(end).toHaveBeenCalled();
  });

  it("rejects when the probe and first page have different row descriptions", async () => {
    const probeClient = {
      query: vi.fn().mockResolvedValue({ rows: [], fields: [field], command: "SELECT" }),
      end: vi.fn().mockResolvedValue(undefined),
    } as unknown as Client;
    const pageClient = {
      query: vi.fn().mockResolvedValue({
        rows: [["1"]],
        fields: [{ ...field, name: "renamed_id" }],
        command: "SELECT",
      }),
      end: vi.fn().mockResolvedValue(undefined),
    } as unknown as Client;
    const openClient = vi
      .fn<() => Promise<Client>>()
      .mockResolvedValueOnce(probeClient)
      .mockResolvedValueOnce(pageClient);

    await expect(
      openDataViewResult({
        ...options,
        openClient,
        registerCancellation: () => {},
      }),
    ).rejects.toThrow("result shape changed");
    expect(openClient).toHaveBeenCalledTimes(2);
  });
});
