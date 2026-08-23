import { describe, expect, it } from "vitest";
import { conditionFromCell, type NamedRelation, withCondition } from "./cellFilter.js";
import type { DataViewProjection } from "./dataView.js";

const PROJECTION: DataViewProjection = {
  tables: [{ tableOid: 1, schema: "shop", name: "brand", accent: 0 }],
  columnTable: [0, 0, undefined],
};

/** The query says `FROM shop.brand AS b`, so its columns are written `b.…`. */
const RELATIONS: NamedRelation[] = [
  { catalogSchema: "shop", catalogName: "brand", reference: "b" },
];

function condition(
  column: { name: string; typeName?: string; tableIndex: number | undefined },
  value: string | null,
  negate = false,
) {
  return conditionFromCell({ column, projection: PROJECTION, relations: RELATIONS, value, negate });
}

describe("filtering on the value of a cell", () => {
  it("names the relation the way the query names it", () => {
    expect(condition({ name: "country_code", typeName: "text", tableIndex: 0 }, "FR")).toEqual({
      condition: "b.country_code = 'FR'",
    });
  });

  it("writes a number as a number and a string as a literal", () => {
    expect(condition({ name: "id", typeName: "bigint", tableIndex: 0 }, "42")).toEqual({
      condition: "b.id = 42",
    });
    expect(condition({ name: "active", typeName: "boolean", tableIndex: 0 }, "true")).toEqual({
      condition: "b.active = true",
    });
    expect(condition({ name: "price", typeName: "numeric(8,2)", tableIndex: 0 }, "15.00")).toEqual({
      condition: "b.price = 15.00",
    });
    expect(condition({ name: "name", typeName: "text", tableIndex: 0 }, "L'Atelier")).toEqual({
      condition: "b.name = 'L''Atelier'",
    });
  });

  it("asks for the empty cells with IS NULL, which is what a reader means", () => {
    expect(condition({ name: "website", typeName: "text", tableIndex: 0 }, null)).toEqual({
      condition: "b.website IS NULL",
    });
    expect(condition({ name: "website", typeName: "text", tableIndex: 0 }, null, true)).toEqual({
      condition: "b.website IS NOT NULL",
    });
  });

  it("turns the comparison over rather than negating the whole of it", () => {
    expect(
      condition({ name: "country_code", typeName: "text", tableIndex: 0 }, "FR", true),
    ).toEqual({ condition: "b.country_code <> 'FR'" });
  });

  it("refuses, with the reason, what cannot stand for itself", () => {
    expect(condition({ name: "total", typeName: "numeric", tableIndex: undefined }, "1")).toEqual({
      refused: "This value is computed; it does not come from one stored column.",
    });
    expect(condition({ name: "payload", typeName: "json", tableIndex: 0 }, "{}")).toEqual({
      refused: "A json value is not compared here.",
    });
    // `jsonb` has an equality operator, so it is compared like anything else.
    expect(condition({ name: "tags", typeName: "jsonb", tableIndex: 0 }, "[1]")).toEqual({
      condition: "b.tags = '[1]'",
    });
    expect(
      conditionFromCell({
        column: { name: "id", typeName: "bigint", tableIndex: 0 },
        projection: PROJECTION,
        relations: [],
        value: "1",
        negate: false,
      }),
    ).toEqual({ refused: "The query no longer names that table." });
  });

  it("adds to the condition already there", () => {
    expect(withCondition("", "b.id = 1")).toBe("b.id = 1");
    expect(withCondition("b.id = 1", "b.name = 'x'")).toBe("b.id = 1\n  AND b.name = 'x'");
  });
});
