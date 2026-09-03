import { describe, expect, it } from "vitest";
import { mapCoverageToSource, mapPlpgsqlBodyLineToSource } from "./mapToSource.js";
import type { CoverageResult } from "./model.js";

describe("native coverage source mapping", () => {
  it("maps body-relative statements and decision branches to DDL lines", () => {
    const mapped = mapCoverageToSource(3, coverageResult());

    expect(mapped).toMatchObject({
      statement: { covered: 2, total: 3 },
      branch: { covered: 1, total: 2 },
    });
    expect(mapped.statements).toEqual([
      {
        line: 5,
        endLine: 5,
        executed: 1,
        syntheticDecision: true,
        branches: [
          { line: 5, executed: 1, label: "IF true @3" },
          { line: 5, executed: 0, label: "IF false @3" },
        ],
      },
      {
        line: 6,
        endLine: 8,
        executed: 1,
        syntheticDecision: false,
        branches: [],
      },
      {
        line: 8,
        endLine: 8,
        executed: 0,
        syntheticDecision: false,
        branches: [],
      },
    ]);
  });

  it("preserves leading body lines when mapping tagged routine diagnostics", () => {
    const ddl = `CREATE FUNCTION public.subject()
RETURNS void
LANGUAGE plpgsql
AS $body$


DECLARE
  value integer;
BEGIN
  value := 1;
END;
$body$`;

    expect(mapPlpgsqlBodyLineToSource(3, 4)).toBe(6);
    expect(ddl.split("\n")[mapPlpgsqlBodyLineToSource(3, 4)]).toBe("DECLARE");
    expect(ddl.split("\n")[mapPlpgsqlBodyLineToSource(3, 7)]).toBe("  value := 1;");
  });
});

function coverageResult(): CoverageResult {
  return {
    points: [
      {
        point: {
          id: "p0",
          line: 4,
          endLine: 6,
          kind: "statement",
          label: "return",
          placement: { kind: "before", line: 4, siteKey: "return:4" },
        },
        executed: 1,
      },
      {
        point: {
          id: "p1",
          line: 6,
          endLine: 6,
          kind: "statement",
          label: "return",
          placement: { kind: "before", line: 6, siteKey: "return:6" },
        },
        executed: 0,
      },
      {
        point: {
          id: "p2",
          line: 3,
          endLine: 3,
          kind: "branch",
          label: "IF true @3",
          placement: { kind: "before", line: 3, siteKey: "if:3:true" },
        },
        executed: 1,
      },
      {
        point: {
          id: "p3",
          line: 3,
          endLine: 3,
          kind: "branch",
          label: "IF false @3",
          placement: { kind: "inject_else", decisionLine: 3, searchAfter: 3 },
        },
        executed: 0,
      },
    ],
    statement: { covered: 1, total: 2 },
    branch: { covered: 1, total: 2 },
  };
}
