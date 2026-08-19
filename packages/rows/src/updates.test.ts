import { describe, expect, it } from "vitest";
import { stripStatementTerminator } from "../../sql/src/authoring/query/analysis.js";
import { buildRowUpdates } from "./updates.js";
import { type CatalogTable, READ_ONLY_REASONS, resolveDataViewEditability } from "./editability.js";

const address: CatalogTable = {
  tableOid: 100,
  schema: "shop",
  name: "address",
  relkind: "r",
  columns: [
    { attnum: 1, name: "id", type: "bigint", identity: "", generated: "", notNull: true },
    { attnum: 2, name: "city", type: "text", identity: "", generated: "", notNull: true },
    {
      attnum: 3,
      name: "created_at",
      type: "timestamp with time zone",
      identity: "",
      generated: "",
      notNull: true,
    },
  ],
  uniqueIndexes: [{ attnums: [1], primary: true }],
  foreignKeyAttnums: [],
};

const salesOrder: CatalogTable = {
  tableOid: 200,
  schema: "shop",
  name: "sales_order",
  relkind: "r",
  columns: [
    { attnum: 1, name: "id", type: "bigint", identity: "", generated: "", notNull: true },
    {
      attnum: 2,
      name: "shipping_address_id",
      type: "bigint",
      identity: "",
      generated: "",
      notNull: true,
    },
    { attnum: 3, name: "status", type: "text", identity: "", generated: "", notNull: true },
  ],
  uniqueIndexes: [{ attnums: [1], primary: true }],
  foreignKeyAttnums: [2],
};

describe("Data View editability", () => {
  it("edits ordinary values of every identified table in a join and keeps identity and relationship values read-only", () => {
    const fields = [
      { name: "id", tableID: 100, columnID: 1, dataTypeID: 20 },
      { name: "city", tableID: 100, columnID: 2, dataTypeID: 25 },
      { name: "id", tableID: 200, columnID: 1, dataTypeID: 20 },
      { name: "shipping_address_id", tableID: 200, columnID: 2, dataTypeID: 20 },
      { name: "status", tableID: 200, columnID: 3, dataTypeID: 25 },
      { name: "count", tableID: 0, columnID: 0, dataTypeID: 20 },
    ];
    const editability = resolveDataViewEditability(fields, [address, salesOrder]);
    expect(editability.tables.map((table) => [table.name, table.keyOrdinals])).toEqual([
      ["address", [0]],
      ["sales_order", [2]],
    ]);
    expect(
      editability.columns.map((policy) => (policy.editable ? "editable" : policy.reason)),
    ).toEqual([
      READ_ONLY_REASONS.identity,
      "editable",
      READ_ONLY_REASONS.identity,
      READ_ONLY_REASONS.relationship,
      "editable",
      READ_ONLY_REASONS.computed,
    ]);
  });

  it("refuses rows whose identity is not projected or whose table appears twice", () => {
    const missingKey = resolveDataViewEditability(
      [{ name: "city", tableID: 100, columnID: 2, dataTypeID: 25 }],
      [address],
    );
    expect(missingKey.columns[0]).toEqual({
      editable: false,
      reason: READ_ONLY_REASONS.noIdentity,
    });
    const selfJoin = resolveDataViewEditability(
      [
        { name: "id", tableID: 100, columnID: 1, dataTypeID: 20 },
        { name: "city", tableID: 100, columnID: 2, dataTypeID: 25 },
        { name: "id", tableID: 100, columnID: 1, dataTypeID: 20 },
      ],
      [address],
    );
    expect(selfJoin.tables).toEqual([]);
    expect(
      selfJoin.columns.every(
        (policy) => !policy.editable && policy.reason === READ_ONLY_REASONS.ambiguous,
      ),
    ).toBe(true);
  });
});

describe("Data View SQL", () => {
  it("strips statement terminators", () => {
    expect(stripStatementTerminator("SELECT 1;\n")).toBe("SELECT 1");
  });

  it("builds one guarded UPDATE per edited row", () => {
    const editability = resolveDataViewEditability(
      [
        { name: "id", tableID: 100, columnID: 1, dataTypeID: 20 },
        { name: "city", tableID: 100, columnID: 2, dataTypeID: 25 },
        { name: "created_at", tableID: 100, columnID: 3, dataTypeID: 1184 },
      ],
      [address],
    );
    const updates = buildRowUpdates(
      [
        { tableOid: 100, key: ["7"], ordinal: 1, column: "city", original: "Lyon", value: "Paris" },
        {
          tableOid: 100,
          key: ["7"],
          ordinal: 2,
          column: "created_at",
          original: "2024-01-01 00:00:00+00",
          value: null,
        },
        { tableOid: 100, key: ["8"], ordinal: 1, column: "city", original: null, value: "Nice" },
      ],
      editability,
    );
    expect(updates).toEqual([
      {
        text: "UPDATE shop.address\nSET city = $1::text, created_at = $2::timestamp with time zone\nWHERE id = $3::bigint\n  AND city IS NOT DISTINCT FROM $4::text\n  AND created_at IS NOT DISTINCT FROM $5::timestamp with time zone",
        values: ["Paris", null, "7", "Lyon", "2024-01-01 00:00:00+00"],
        target: "shop.address (id = 7)",
      },
      {
        text: "UPDATE shop.address\nSET city = $1::text\nWHERE id = $2::bigint\n  AND city IS NOT DISTINCT FROM $3::text",
        values: ["Nice", "8", null],
        target: "shop.address (id = 8)",
      },
    ]);
  });
});
