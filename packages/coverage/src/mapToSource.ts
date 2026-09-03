import type { CoverageResult } from "./model.js";

export interface MappedBranchCoverage {
  line: number;
  executed: number;
  label: string;
}

export interface MappedStatementCoverage {
  line: number;
  endLine: number;
  executed: number;
  syntheticDecision: boolean;
  branches: MappedBranchCoverage[];
}

export interface MappedRoutineCoverage {
  statement: { covered: number; total: number };
  branch: { covered: number; total: number };
  statements: MappedStatementCoverage[];
}

export function mapPlpgsqlBodyLineToSource(bodyStartLine: number, bodyLine: number): number {
  return bodyStartLine + bodyLine - 1;
}

export function mapCoverageToSource(
  bodyStartLine: number,
  coverage: CoverageResult,
): MappedRoutineCoverage {
  const statements: MappedStatementCoverage[] = coverage.points
    .filter(({ point }) => point.kind === "statement")
    .map(({ point, executed }) => ({
      line: bodyStartLine + point.line - 1,
      endLine: bodyStartLine + point.endLine - 1,
      executed,
      syntheticDecision: false,
      branches: [],
    }));
  const statementsByLine = new Map<number, MappedStatementCoverage>();
  for (const statement of statements) {
    if (!statementsByLine.has(statement.line)) {
      statementsByLine.set(statement.line, statement);
    }
  }
  const branchesByLine = new Map<number, MappedBranchCoverage[]>();
  for (const { point, executed } of coverage.points) {
    if (point.kind !== "branch") continue;
    const line = bodyStartLine + point.line - 1;
    const branches = branchesByLine.get(line) ?? [];
    branches.push({ line, executed, label: point.label });
    branchesByLine.set(line, branches);
  }
  for (const [line, branches] of branchesByLine) {
    const statement = statementsByLine.get(line);
    if (statement) {
      statement.branches = branches;
    } else {
      statements.push({
        line,
        endLine: line,
        executed: branches.reduce((sum, branch) => sum + branch.executed, 0),
        syntheticDecision: true,
        branches,
      });
    }
  }
  const sortedStatements = statements.sort(
    (left, right) =>
      left.line - right.line || Number(left.syntheticDecision) - Number(right.syntheticDecision),
  );
  return {
    statement: {
      covered: sortedStatements.filter(({ executed }) => executed > 0).length,
      total: sortedStatements.length,
    },
    branch: {
      covered: [...branchesByLine.values()].flat().filter(({ executed }) => executed > 0).length,
      total: [...branchesByLine.values()].reduce((sum, branches) => sum + branches.length, 0),
    },
    statements: sortedStatements,
  };
}
