import type { CoverageDiagnostic } from "./model.js";

export class CoverageInstrumentationError extends Error {
  constructor(readonly diagnostics: readonly CoverageDiagnostic[]) {
    super(diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
    this.name = "CoverageInstrumentationError";
  }
}
