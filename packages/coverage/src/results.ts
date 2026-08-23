import type { CoverageAnalysis, CoverageResult } from "./model.js";

export function buildCoverageResult(
  analysis: CoverageAnalysis,
  executions: ReadonlyMap<string, number>,
): CoverageResult {
  const points = analysis.points.map((point) => ({
    point,
    executed: executions.get(point.id) ?? 0,
  }));
  const statementPoints = points.filter(({ point }) => point.kind === "statement");
  const branchPoints = points.filter(({ point }) => point.kind === "branch");
  return {
    points,
    statement: {
      covered: statementPoints.filter(({ executed }) => executed > 0).length,
      total: statementPoints.length,
    },
    branch: {
      covered: branchPoints.filter(({ executed }) => executed > 0).length,
      total: branchPoints.length,
    },
  };
}
