import { describe, expect, it } from "vitest";
import { stripStatementTerminator } from "../../sql/src/query/analysis.js";
import { dataViewColumnKeys, withRequiredColumnsRevealed } from "./dataView.js";
import {
  type CatalogColumn,
  type CatalogTable,
  columnDemandsValue,
  READ_ONLY_REASONS,
  resolveDataViewEditability,
} from "./editability.js";
import { buildRowDeletes, buildRowInserts, buildRowUpdates } from "./updates.js";

const address: CatalogTable = {
  tableOid: 100,
  schema: "shop",
  name: "address",
  relkind: "r",
  columns: [
    {
      attnum: 1,
      name: "id",
      type: "bigint",
      identity: "",
      generated: "",
      notNull: true,
      hasDefault: false,
    },
    {
      attnum: 2,
      name: "city",
      type: "text",
      identity: "",
      generated: "",
      notNull: true,
      hasDefault: false,
    },
    {
      attnum: 3,
      name: "created_at",
      type: "timestamp with time zone",
      identity: "",
      generated: "",
      notNull: true,
      hasDefault: false,
    },
  ],
  uniqueIndexes: [{ attnums: [1], primary: true }],
  referencedBy: [],
  foreignKeyAttnums: [],
};

const salesOrder: CatalogTable = {
  tableOid: 200,
  schema: "shop",
  name: "sales_order",
  relkind: "r",
  columns: [
    {
      attnum: 1,
      name: "id",
      type: "bigint",
      identity: "",
      generated: "",
      notNull: true,
      hasDefault: false,
    },
    {
      attnum: 2,
      name: "shipping_address_id",
      type: "bigint",
      identity: "",
      generated: "",
      notNull: true,
      hasDefault: false,
    },
    {
      attnum: 3,
      name: "status",
      type: "text",
      identity: "",
      generated: "",
      notNull: true,
      hasDefault: false,
    },
  ],
  uniqueIndexes: [{ attnums: [1], primary: true }],
  referencedBy: [],
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

describe("removed rows", () => {
  const addressEditability = resolveDataViewEditability(
    [
      { name: "id", tableID: 100, columnID: 1, dataTypeID: 20 },
      { name: "city", tableID: 100, columnID: 2, dataTypeID: 25 },
    ],
    [address],
  );

  it("deletes by identity alone, because the reader asked for that row whatever it holds now", () => {
    const statements = buildRowDeletes([{ tableOid: 100, key: ["42"] }], addressEditability);

    expect(statements).toEqual([
      {
        text: "DELETE FROM shop.address\nWHERE id = $1::bigint",
        values: ["42"],
        target: "shop.address (id = 42)",
      },
    ]);
  });

  it("matches a null part of a key with IS NULL rather than binding it", () => {
    const statements = buildRowDeletes([{ tableOid: 100, key: [null] }], addressEditability);

    expect(statements[0]?.text).toBe("DELETE FROM shop.address\nWHERE id IS NULL");
    expect(statements[0]?.values).toEqual([]);
  });

  it("refuses to delete from a table the query no longer holds", () => {
    expect(() => buildRowDeletes([{ tableOid: 99, key: ["1"] }], addressEditability)).toThrow(
      /no longer belongs to an editable table/u,
    );
  });
});

describe("added rows", () => {
  const addressEditability = resolveDataViewEditability(
    [
      { name: "id", tableID: 100, columnID: 1, dataTypeID: 20 },
      { name: "city", tableID: 100, columnID: 2, dataTypeID: 25 },
      { name: "created_at", tableID: 100, columnID: 3, dataTypeID: 1184 },
    ],
    [address],
  );

  it("carries only the columns the reader filled in", () => {
    const statements = buildRowInserts(
      [{ tableOid: 100, localId: "new-1", values: { city: "Brest" } }],
      addressEditability,
    );

    expect(statements).toEqual([
      {
        text: "INSERT INTO shop.address (city)\nVALUES ($1::text)",
        values: ["Brest"],
        target: "shop.address (a new row)",
      },
    ]);
  });

  it("casts each value to its own column type", () => {
    const statements = buildRowInserts(
      [
        {
          tableOid: 100,
          localId: "new-1",
          values: { city: "Brest", created_at: "2026-01-01 00:00:00+00" },
        },
      ],
      addressEditability,
    );

    expect(statements[0]?.text).toBe(
      "INSERT INTO shop.address (city, created_at)\nVALUES ($1::text, $2::timestamp with time zone)",
    );
  });

  it("leaves a row nobody touched entirely to PostgreSQL", () => {
    const statements = buildRowInserts(
      [{ tableOid: 100, localId: "new-1", values: {} }],
      addressEditability,
    );

    expect(statements[0]?.text).toBe("INSERT INTO shop.address DEFAULT VALUES");
    expect(statements[0]?.values).toEqual([]);
  });

  it("refuses to insert into a table the query no longer holds", () => {
    expect(() =>
      buildRowInserts([{ tableOid: 99, localId: "new-1", values: {} }], addressEditability),
    ).toThrow(/no longer belongs to an editable table/u);
  });
});

describe("columns a new row cannot go without", () => {
  const column = (over: Partial<CatalogColumn> = {}): CatalogColumn => ({
    attnum: 1,
    name: "city",
    type: "text",
    identity: "",
    generated: "",
    notNull: true,
    hasDefault: false,
    ...over,
  });

  it("demands a value from a not-null column with nothing to fall back on", () => {
    expect(columnDemandsValue(column())).toBe(true);
  });

  it("asks nothing of a column that may be null", () => {
    expect(columnDemandsValue(column({ notNull: false }))).toBe(false);
  });

  it("asks nothing of a key PostgreSQL generates for itself", () => {
    // A serial primary key has a default; an identity one says so outright. Neither is the
    // reader's to fill in.
    expect(columnDemandsValue(column({ name: "id", hasDefault: true }))).toBe(false);
    expect(columnDemandsValue(column({ name: "id", identity: "a" }))).toBe(false);
  });

  it("asks nothing of a generated column", () => {
    expect(columnDemandsValue(column({ generated: "s" }))).toBe(false);
  });

  it("brings back exactly the hidden columns a row cannot go without", () => {
    const editability = resolveDataViewEditability(
      [
        { name: "id", tableID: 100, columnID: 1, dataTypeID: 20 },
        { name: "city", tableID: 100, columnID: 2, dataTypeID: 25 },
        { name: "created_at", tableID: 100, columnID: 3, dataTypeID: 1184 },
      ],
      [
        {
          ...address,
          columns: [
            { ...address.columns[0], hasDefault: true } as CatalogColumn,
            address.columns[1] as CatalogColumn,
            { ...address.columns[2], hasDefault: true } as CatalogColumn,
          ],
        },
      ],
    );
    const projection = {
      tables: [{ tableOid: 100, schema: "shop", name: "address", accent: 0 }],
      columnTable: [0, 0, 0],
    };
    const names = ["id", "city", "created_at"];
    const hidden = dataViewColumnKeys(projection, names);

    const revealed = withRequiredColumnsRevealed(hidden, editability, projection, names);

    // `id` and `created_at` have a default of their own and stay out of the way.
    expect(revealed).toEqual([hidden[0], hidden[2]]);
  });
});
