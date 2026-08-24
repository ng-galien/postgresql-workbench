import { describe, expect, it } from "vitest";
import {
  type DataViewEdit,
  type DataViewEditability,
  type DataViewSource,
  dataViewTitle,
  describeDataViewChanges,
  describeDeleteConsequences,
} from "./dataView.js";
import type { DataViewDeleteRule } from "./editability.js";

const editability: DataViewEditability = {
  tables: [
    {
      tableOid: 42,
      schema: "shop",
      name: "address",
      keyOrdinals: [0],
      keyColumns: ["id"],
      keyTypes: ["bigint"],
      referencedBy: [],
    },
    {
      tableOid: 43,
      schema: "shop",
      name: "stock",
      keyOrdinals: [0, 1],
      keyColumns: ["warehouse_id", "product_id"],
      keyTypes: ["bigint", "bigint"],
      referencedBy: [],
    },
  ],
  columns: [],
  requiredOrdinals: [],
  technicalOrdinals: [],
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
    expect(describeDataViewChanges([edit()], [], [], editability)).toEqual([
      {
        kind: "update",
        table: "shop.address",
        row: "id = 12",
        column: "city",
        original: "Nantes",
        value: "Saint-Nazaire",
      },
    ]);
  });

  it("spells out every column of a composite key", () => {
    const summaries = describeDataViewChanges(
      [edit({ tableOid: 43, key: ["7", "31"], column: "quantity", original: "4", value: "9" })],
      [],
      [],
      editability,
    );

    expect(summaries[0]?.row).toBe("warehouse_id = 7, product_id = 31");
  });

  it("says NULL where a key or a value has none, rather than showing nothing", () => {
    const summaries = describeDataViewChanges(
      [edit({ key: [null], original: null, value: null })],
      [],
      [],
      editability,
    );

    expect(summaries[0]?.row).toBe("id = NULL");
    expect(summaries[0]).toMatchObject({ original: null, value: null });
  });

  it("still describes a change whose table the projection has since dropped", () => {
    // The query was rewritten under the reader's feet; the change is still theirs to read.
    const summaries = describeDataViewChanges([edit({ tableOid: 99 })], [], [], editability);

    expect(summaries[0]).toMatchObject({ table: "", row: "key 1 = 12", column: "city" });
  });
});

describe("provisioned row removals", () => {
  it("tells a whole row apart from a change to one of its cells", () => {
    const summaries = describeDataViewChanges([], [{ tableOid: 42, key: ["12"] }], [], editability);

    expect(summaries).toEqual([{ kind: "delete", table: "shop.address", row: "id = 12" }]);
  });

  it("lists rows before cells, the order they are written in", () => {
    const summaries = describeDataViewChanges(
      [edit()],
      [{ tableOid: 43, key: ["7", "31"] }],
      [],
      editability,
    );

    expect(summaries.map((summary: { kind: string }) => summary.kind)).toEqual([
      "delete",
      "update",
    ]);
    expect(summaries[0]?.row).toBe("warehouse_id = 7, product_id = 31");
  });
});

describe("provisioned row insertions", () => {
  it("lists what a new row will hold, column by column", () => {
    const summaries = describeDataViewChanges(
      [],
      [],
      [{ tableOid: 42, localId: "new-1", values: { city: "Brest", label: "Dépôt" }, above: 0 }],
      editability,
    );

    expect(summaries).toEqual([
      { kind: "insert", table: "shop.address", row: "city = Brest, label = Dépôt" },
    ]);
  });

  it("says outright when a new row leaves every column to PostgreSQL", () => {
    const summaries = describeDataViewChanges(
      [],
      [],
      [{ tableOid: 42, localId: "new-1", values: {}, above: 0 }],
      editability,
    );

    expect(summaries[0]?.row).toBe("every column left to PostgreSQL");
  });

  it("writes rows away, then cells, then rows added", () => {
    const summaries = describeDataViewChanges(
      [edit()],
      [{ tableOid: 42, key: ["9"] }],
      [{ tableOid: 42, localId: "new-1", values: {}, above: 0 }],
      editability,
    );

    expect(summaries.map((summary: { kind: string }) => summary.kind)).toEqual([
      "delete",
      "update",
      "insert",
    ]);
  });
});

describe("what a deletion drags along", () => {
  const consequences = (referencedBy: { table: string; onDelete: DataViewDeleteRule }[]) =>
    describeDeleteConsequences({ referencedBy });

  it("says nothing when nothing points at the table", () => {
    expect(consequences([])).toEqual([]);
  });

  it("names the rows that go with it under a cascade", () => {
    expect(consequences([{ table: "shop.order_line", onDelete: "cascade" }])).toEqual([
      "Rows of shop.order_line that point at it are deleted too.",
    ]);
  });

  it("says a reference is cleared rather than followed", () => {
    expect(consequences([{ table: "shop.user_profile", onDelete: "set-null" }])).toEqual([
      "Rows of shop.user_profile keep their place, pointing nowhere.",
    ]);
  });

  it("warns that PostgreSQL may refuse the deletion outright", () => {
    expect(consequences([{ table: "shop.warehouse", onDelete: "restrict" }])).toEqual([
      "shop.warehouse may point at it, and PostgreSQL then refuses the deletion.",
    ]);
  });

  it("groups tables that share a rule, and names each rule once", () => {
    const said = consequences([
      { table: "shop.b", onDelete: "cascade" },
      { table: "shop.a", onDelete: "cascade" },
      { table: "shop.c", onDelete: "no-action" },
    ]);

    expect(said).toEqual([
      "Rows of shop.a, shop.b that point at it are deleted too.",
      "shop.c may point at it, and PostgreSQL then refuses the deletion.",
    ]);
  });
});

describe("what a Data View is called", () => {
  const sql: DataViewSource = {
    kind: "sql",
    connectionId: "s",
    database: "demo",
    sql: "SELECT inventory_movement.id, inventory_movement.inventory_id FROM shop.inventory_movement",
    label: "SELECT inventory_movement.id, inventory_movement.inventory_id…",
  };
  const table = (name: string, accent: number) => ({
    tableOid: accent + 1,
    schema: "shop",
    name,
    accent,
  });

  it("names a view opened on a relation by that relation", () => {
    expect(
      dataViewTitle(
        {
          kind: "relation",
          connectionId: "s",
          database: "demo",
          schema: "shop",
          name: "brand",
          relationKind: "table",
        },
        { tables: [table("brand", 0)], columnTable: [0] },
      ),
    ).toBe("shop.brand");
  });

  it("names a view opened on a statement by what the statement draws from", () => {
    expect(dataViewTitle(sql, { tables: [table("inventory_movement", 0)], columnTable: [0] })).toBe(
      "inventory_movement",
    );
    expect(
      dataViewTitle(sql, {
        tables: [table("inventory_movement", 0), table("organization", 1)],
        columnTable: [0, 1],
      }),
    ).toBe("inventory_movement +1");
  });

  it("keeps the statement's own label until the query has been read", () => {
    expect(dataViewTitle(sql, { tables: [], columnTable: [] })).toBe(sql.label);
  });
});
