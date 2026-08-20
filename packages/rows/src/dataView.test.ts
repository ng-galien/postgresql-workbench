import { describe, expect, it } from "vitest";
import { type DataViewEdit, type DataViewEditability, describeDataViewEdits } from "./dataView.js";

const editability: DataViewEditability = {
  tables: [
    {
      tableOid: 42,
      schema: "shop",
      name: "address",
      keyOrdinals: [0],
      keyColumns: ["id"],
      keyTypes: ["bigint"],
    },
    {
      tableOid: 43,
      schema: "shop",
      name: "stock",
      keyOrdinals: [0, 1],
      keyColumns: ["warehouse_id", "product_id"],
      keyTypes: ["bigint", "bigint"],
    },
  ],
  columns: [],
};

const edit = (over: Partial<DataViewEdit> = {}): DataViewEdit => ({
  tableOid: 42,
  key: ["12"],
  ordinal: 3,
  column: "city",
  original: "Nantes",
  value: "Saint-Nazaire",
  ...over,
});

describe("provisioned changes", () => {
  it("names the table and the row each change lands on", () => {
    expect(describeDataViewEdits([edit()], editability)).toEqual([
      {
        table: "shop.address",
        row: "id = 12",
        column: "city",
        original: "Nantes",
        value: "Saint-Nazaire",
      },
    ]);
  });

  it("spells out every column of a composite key", () => {
    const summaries = describeDataViewEdits(
      [edit({ tableOid: 43, key: ["7", "31"], column: "quantity", original: "4", value: "9" })],
      editability,
    );

    expect(summaries[0]?.row).toBe("warehouse_id = 7, product_id = 31");
  });

  it("says NULL where a key or a value has none, rather than showing nothing", () => {
    const summaries = describeDataViewEdits(
      [edit({ key: [null], original: null, value: null })],
      editability,
    );

    expect(summaries[0]?.row).toBe("id = NULL");
    expect(summaries[0]).toMatchObject({ original: null, value: null });
  });

  it("still describes a change whose table the projection has since dropped", () => {
    // The query was rewritten under the reader's feet; the change is still theirs to read.
    const summaries = describeDataViewEdits([edit({ tableOid: 99 })], editability);

    expect(summaries[0]).toMatchObject({ table: "", row: "key 1 = 12", column: "city" });
  });
});
