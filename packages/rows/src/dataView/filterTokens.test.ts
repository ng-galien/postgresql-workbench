import { describe, expect, it } from "vitest";
import type { SqlQueryAnalysis } from "../../../sql/src/query/analysis.js";
import { filterDocumentProjection } from "./filterTokens.js";

const QUERY = "SELECT brand.name\nFROM shop.brand AS brand";
const ANALYSIS = { fromEnd: QUERY.length, where: undefined } as unknown as SqlQueryAnalysis;

describe("the filter document projection", () => {
  it("places every visible condition between stable host-owned query boundaries", () => {
    const projection = filterDocumentProjection(QUERY, ANALYSIS);
    expect(projection).toBeDefined();
    expect(`${projection?.prefix}brand.id > 3${projection?.suffix}`).toContain(
      "WHERE brand.id > 3",
    );
    expect(`${projection?.prefix}brand.name IS NULL${projection?.suffix}`).toContain(
      "WHERE brand.name IS NULL",
    );
  });
});
