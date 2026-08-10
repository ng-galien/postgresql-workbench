import { describe, expect, it } from "vitest";
import { formatCoverageMarker, parseCoverageMarker } from "./markers.js";
import type { CoverageAnalysis } from "./model.js";
import { buildCoverageResult } from "./results.js";
import { CoverageCancelledError, isCleanCoverageCancellation } from "./runner.js";

describe("coverage markers", () => {
  it("namespaces markers by run and rejects unrelated messages", () => {
    expect(formatCoverageMarker("run-42", "p7")).toBe("postgresql-workbench-cov:run-42:p7");
    expect(parseCoverageMarker("postgresql-workbench-cov:run-42:p7", "run-42")).toEqual({
      pointId: "p7",
    });
    expect(parseCoverageMarker("postgresql-workbench-cov:other:p7", "run-42")).toBeUndefined();
    expect(
      parseCoverageMarker("postgresql-workbench-cov:run-42:p7:extra", "run-42"),
    ).toBeUndefined();
  });

  it("rejects tokens that cannot be embedded safely", () => {
    expect(() => formatCoverageMarker("bad:id", "p1")).toThrow("Invalid coverage run ID");
    expect(() => formatCoverageMarker("run", "p'1")).toThrow("Invalid coverage point ID");
  });
});

describe("coverage cancellation classification", () => {
  it("does not hide cleanup failures attached to a cancellation", () => {
    expect(isCleanCoverageCancellation(new CoverageCancelledError())).toBe(true);
    expect(
      isCleanCoverageCancellation(
        new AggregateError(
          [new CoverageCancelledError(), new Error("rollback failed")],
          "Coverage cancellation cleanup failed.",
        ),
      ),
    ).toBe(false);
  });
});

describe("coverage result", () => {
  it("preserves execution counts and computes statement and branch summaries", () => {
    const analysis: CoverageAnalysis = {
      diagnostics: [],
      points: [
        point("p0", "statement", 2),
        point("p1", "statement", 3),
        point("p2", "branch", 2),
        point("p3", "branch", 2),
      ],
    };
    const result = buildCoverageResult(
      analysis,
      new Map([
        ["p0", 2],
        ["p1", 2],
        ["p3", 1],
      ]),
    );

    expect(result.points.map(({ executed }) => executed)).toEqual([2, 2, 0, 1]);
    expect(result.statement).toEqual({ covered: 2, total: 2 });
    expect(result.branch).toEqual({ covered: 1, total: 2 });
  });
});

function point(id: string, kind: "statement" | "branch", line: number) {
  return {
    id,
    kind,
    line,
    label: id,
    placement: { kind: "before" as const, line, siteKey: id },
  };
}
