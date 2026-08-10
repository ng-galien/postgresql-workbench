export type CoveragePointKind = "statement" | "branch";

export type CoverageStatementLabel =
  | "assert"
  | "assign"
  | "call"
  | "close"
  | "dynexecute"
  | "execsql"
  | "exit"
  | "fetch"
  | "for"
  | "foreach"
  | "getdiag"
  | "loop"
  | "open"
  | "perform"
  | "raise"
  | "return"
  | "return_next"
  | "return_query"
  | "while";

export interface DirectProbePlacement {
  kind: "before";
  line: number;
  siteKey: string;
  byteOffset?: number;
}

export interface ElseProbePlacement {
  kind: "inject_else";
  decisionLine: number;
  searchAfter: number;
  byteOffset?: number;
}

export interface LoopEnterProbePlacement {
  kind: "loop_enter";
  loopKey: string;
  loopLine: number;
  line: number;
  searchAfter: number;
  siteKey: string;
  loopByteOffset?: number;
  byteOffset?: number;
}

export interface LoopSkipProbePlacement {
  kind: "loop_skip";
  loopKey: string;
  loopLine: number;
  searchAfter: number;
  byteOffset?: number;
}

export type CoverageProbePlacement =
  | DirectProbePlacement
  | ElseProbePlacement
  | LoopEnterProbePlacement
  | LoopSkipProbePlacement;

export interface CoveragePoint {
  id: string;
  line: number;
  kind: CoveragePointKind;
  label: string;
  placement: CoverageProbePlacement;
}

export type CoverageDiagnosticSeverity = "warning" | "error";

export interface CoverageDiagnostic {
  severity: CoverageDiagnosticSeverity;
  code: string;
  message: string;
  line?: number;
}

export interface CoverageAnalysis {
  points: CoveragePoint[];
  diagnostics: CoverageDiagnostic[];
  instrumentation?: {
    declaration: {
      kind: "append" | "insert";
      byteOffset: number;
    };
  };
}

export interface InstrumentedCoverageSource {
  body: string;
  markerPrefix: string;
  pointIds: readonly string[];
}

export interface InstrumentedCoverageDdl extends InstrumentedCoverageSource {
  ddl: string;
  bodyStartLine: number;
}

export interface CoveragePointResult {
  point: CoveragePoint;
  executed: number;
}

export interface CoverageResult {
  points: CoveragePointResult[];
  statement: {
    covered: number;
    total: number;
  };
  branch: {
    covered: number;
    total: number;
  };
}
