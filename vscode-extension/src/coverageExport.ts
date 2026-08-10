export interface ExportedCoverageBranch {
  line: number;
  executed: number;
  label?: string;
}

export interface ExportedCoverageStatement {
  line: number;
  executed: number;
  branches: ExportedCoverageBranch[];
}

export interface ExportedCoverageFile {
  uri: string;
  statements: ExportedCoverageStatement[];
}

export function coverageAsJson(files: readonly ExportedCoverageFile[]): string {
  return `${JSON.stringify({ version: 1, files }, null, 2)}\n`;
}

export function coverageAsLcov(files: readonly ExportedCoverageFile[]): string {
  const records = files.map((file) => {
    const lines = aggregateLines(file.statements);
    const branches = file.statements.flatMap(({ branches }) => branches);
    return [
      "TN:PL/pgSQL",
      `SF:${file.uri}`,
      ...[...lines].map(([line, executed]) => `DA:${line + 1},${executed}`),
      `LF:${lines.size}`,
      `LH:${[...lines.values()].filter((executed) => executed > 0).length}`,
      ...branches.map((branch, index) => `BRDA:${branch.line + 1},0,${index},${branch.executed}`),
      `BRF:${branches.length}`,
      `BRH:${branches.filter(({ executed }) => executed > 0).length}`,
      "end_of_record",
    ].join("\n");
  });
  return `${records.join("\n")}\n`;
}

function aggregateLines(statements: readonly ExportedCoverageStatement[]): Map<number, number> {
  const lines = new Map<number, number>();
  for (const statement of statements) {
    lines.set(statement.line, (lines.get(statement.line) ?? 0) + statement.executed);
  }
  return new Map([...lines].sort(([left], [right]) => left - right));
}
