import { describe, expect, it } from "vitest";
import { matchesCoverageScope } from "./schema.js";

describe("coverage selectors", () => {
  it("selects every name in a literal schema, with no prefix convention", () => {
    for (const name of ["subject", "arbitrary check", "anything_else"]) {
      expect(matchesCoverageScope({ schemas: ["app_*"] }, "app_*", name)).toBe(true);
      expect(matchesCoverageScope({ schemas: ["app_*"] }, "app_other", name)).toBe(false);
    }
  });
  it("matches anchored case-sensitive qualified globs and combines patterns by union", () => {
    const scope = { patterns: ["app.invoice*", "checks.case?"] };
    expect(matchesCoverageScope(scope, "app", "invoice")).toBe(true);
    expect(matchesCoverageScope(scope, "app", "invoice_lines")).toBe(true);
    expect(matchesCoverageScope(scope, "checks", "case1")).toBe(true);
    expect(matchesCoverageScope(scope, "otherapp", "invoice")).toBe(false);
    expect(matchesCoverageScope(scope, "app", "Invoice")).toBe(false);
    expect(matchesCoverageScope(scope, "checks", "case12")).toBe(false);
  });
  it("treats regex punctuation as literal text", () => {
    expect(matchesCoverageScope({ patterns: ["a+b.f[1](x)$"] }, "a+b", "f[1](x)$")).toBe(true);
    expect(matchesCoverageScope({ patterns: ["a+b.f[1](x)$"] }, "aaab", "f1x")).toBe(false);
  });
});
