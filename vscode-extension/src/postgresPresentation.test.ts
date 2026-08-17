import { describe, expect, it } from "vitest";
import { postgresSourcePresentation, postgresVisual } from "./postgresPresentation.js";

describe("PostgreSQL presentation", () => {
  it("gives schemas and routines distinct SQL-oriented tree icons", () => {
    expect(postgresVisual("schema").icon).toBe("layers");
    expect(postgresVisual("function").icon).toBe("bracket-dot");
    expect(postgresVisual("procedure").icon).toBe("play-circle");
  });

  it("builds one readable PostgreSQL source path without inspecting a moniker URI", () => {
    expect(
      postgresSourcePresentation({
        database: "shop",
        schema: "public",
        documentKind: "routine",
        name: "find_order",
        signature: "find_order(order_id:int8)",
        symbolKind: "function",
      }),
    ).toEqual({
      displayPath: "shop/public/function/find_order",
      label: "shop / public / function / find_order(order_id:int8)",
      path: "shop/public/function/find_order(order_id:int8)",
      kind: "function",
      object: "find_order(order_id:int8)",
    });
  });
});
