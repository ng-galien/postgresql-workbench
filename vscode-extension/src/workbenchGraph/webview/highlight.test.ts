import { describe, expect, it } from "vitest";
import {
  type HighlightedPostgresSource,
  highlightPostgresSource,
  plainPostgresSource,
} from "./highlight.js";

function tokenContaining(source: HighlightedPostgresSource, text: string) {
  return source.lines.flatMap((line) => line.tokens).find((token) => token.text.includes(text));
}

describe("PL/pgSQL source highlighting", () => {
  it("tokenizes source without delegating line layout to Shiki", async () => {
    const source = await highlightPostgresSource([
      { number: 18, text: "CREATE FUNCTION shop.reserve_stock() RETURNS trigger AS $$" },
      { number: 19, text: "BEGIN" },
      { number: 20, text: "  NEW.quantity := COALESCE(NEW.quantity, 0);" },
      { number: 21, text: "  RETURN NEW;" },
      { number: 22, text: "END;" },
      { number: 23, text: "$$ LANGUAGE plpgsql;" },
    ]);

    expect(source.highlighted).toBe(true);
    expect(source.lines.map((line) => line.number)).toEqual([18, 19, 20, 21, 22, 23]);
    expect(source.lines.map((line) => line.tokens.map((token) => token.text).join(""))).toEqual([
      "CREATE FUNCTION shop.reserve_stock() RETURNS trigger AS $$",
      "BEGIN",
      "  NEW.quantity := COALESCE(NEW.quantity, 0);",
      "  RETURN NEW;",
      "END;",
      "$$ LANGUAGE plpgsql;",
    ]);
    expect(tokenContaining(source, "CREATE")).toMatchObject({
      lightColor: "#0000FF",
      darkColor: "#569CD6",
    });
    expect(tokenContaining(source, "trigger")).toMatchObject({
      lightColor: "#0000FF",
      darkColor: "#569CD6",
    });
  });

  it("uses the SQL grammar for table constraints without misclassifying KEY as a function", async () => {
    const source = await highlightPostgresSource([
      { number: 1, text: 'CREATE TABLE "shop"."address" (' },
      { number: 2, text: "  id bigint DEFAULT nextval('shop.address_id_seq'::regclass) NOT NULL," },
      { number: 3, text: '  CONSTRAINT "address_pkey" PRIMARY KEY (id)' },
      { number: 4, text: ");" },
    ]);

    expect(tokenContaining(source, "CREATE")).toMatchObject({ lightColor: "#0000FF" });
    expect(tokenContaining(source, "bigint")).toMatchObject({ lightColor: "#267F99" });
    expect(tokenContaining(source, "shop.address_id_seq")).toMatchObject({
      lightColor: "#A31515",
    });
    expect(tokenContaining(source, "CONSTRAINT")).toMatchObject({ lightColor: "#0000FF" });
    expect(tokenContaining(source, "PRIMARY KEY")).toMatchObject({ lightColor: "#0000FF" });
    expect(tokenContaining(source, "KEY")?.lightColor).not.toBe("#795E26");
  });

  it("keeps explicit line numbers and empty lines in the plain fallback", () => {
    const source = plainPostgresSource([
      { number: 7, text: "SELECT 1;" },
      { number: 11, text: "" },
    ]);

    expect(source).toEqual({
      highlighted: false,
      lines: [
        { number: 7, tokens: [{ text: "SELECT 1;", offset: 0 }] },
        { number: 11, tokens: [] },
      ],
    });
  });
});
