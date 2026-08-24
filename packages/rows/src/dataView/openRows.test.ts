import type { Client, FieldDef } from "pg";
import { describe, expect, it, vi } from "vitest";
import { openDataViewResult, TableAccents } from "./openRows.js";

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
