import { describe, expect, it } from "vitest";
import { coverageRoutineName, matchesCoveragePatterns } from "./selection.js";

const routine = {
  oid: 42,
  schema: "shop",
  name: "place_order",
  identityArguments: "customer_id integer, product_id integer",
};

describe("coverage routine selection", () => {
  it("uses schema, name, and identity arguments as the stable matching name", () => {
    expect(coverageRoutineName(routine)).toBe(
      "shop.place_order(customer_id integer, product_id integer)",
    );
  });

  it("applies include before exclude with glob patterns", () => {
    expect(matchesCoveragePatterns(routine, ["shop.*"], [])).toBe(true);
    expect(matchesCoveragePatterns(routine, ["public.*"], [])).toBe(false);
    expect(matchesCoveragePatterns(routine, ["**"], ["shop.place_*"])).toBe(false);
  });
});
