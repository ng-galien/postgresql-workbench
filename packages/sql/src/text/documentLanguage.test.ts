import { describe, expect, it } from "vitest";
import { isPostgresSqlLanguage, postgresSourceLanguageId } from "./documentLanguage.js";

describe("PostgreSQL source document languages", () => {
  it.each([
    ["table", "postgresql-table"],
    ["view", "postgresql-view"],
    ["function", "postgresql-function"],
    ["procedure", "postgresql-procedure"],
    ["trigger", "postgresql-trigger"],
  ])("gives %s sources their own visual language", (kind, expected) => {
    expect(postgresSourceLanguageId(kind)).toBe(expected);
    expect(isPostgresSqlLanguage(expected)).toBe(true);
  });

  it("falls back safely for other SQL sources", () => {
    expect(postgresSourceLanguageId("routine", "function")).toBe("postgresql-function");
    expect(postgresSourceLanguageId("routine", "procedure")).toBe("postgresql-procedure");
    expect(postgresSourceLanguageId("routine")).toBe("sql");
    expect(postgresSourceLanguageId("schema")).toBe("sql");
    expect(isPostgresSqlLanguage("typescript")).toBe(false);
  });
});
