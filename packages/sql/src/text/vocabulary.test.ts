import { describe, expect, it } from "vitest";
import { POSTGRES_STATEMENT_PHRASES } from "./vocabulary.js";

describe("POSTGRES_STATEMENT_PHRASES", () => {
  it("is written the way it is inserted", () => {
    // A caller inserts a phrase as it stands, so what is written here is what lands in the query.
    for (const phrase of POSTGRES_STATEMENT_PHRASES) {
      expect(phrase).toBe(phrase.toUpperCase());
      expect(phrase.trim()).toBe(phrase);
    }
    expect(new Set(POSTGRES_STATEMENT_PHRASES).size).toBe(POSTGRES_STATEMENT_PHRASES.length);
  });

  it("holds what a reader types, which a set of reserved words cannot say", () => {
    // The reason this list exists beside the reserved keywords instead of being derived from them.
    expect(POSTGRES_STATEMENT_PHRASES).toContain("IS NOT NULL");
    expect(POSTGRES_STATEMENT_PHRASES).toContain("ORDER BY");
    expect(
      POSTGRES_STATEMENT_PHRASES.filter((phrase) => phrase.includes(" ")).length,
    ).toBeGreaterThan(5);
  });
});
