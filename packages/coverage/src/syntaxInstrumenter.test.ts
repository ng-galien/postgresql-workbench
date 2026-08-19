import { describe, expect, it } from "vitest";
import type { CoverageAnalysis } from "./model.js";
import { instrumentCoverageSyntaxBody } from "./syntaxInstrumenter.js";

describe("instrumentCoverageSyntaxBody", () => {
  it("records a conditional loop exit after the loop without a zero-iteration flag", () => {
    const source = `BEGIN
  FOR i IN 1..2 LOOP
    PERFORM i;
  END LOOP;
END;`;
    const loopOffset = Buffer.byteLength("BEGIN\n  ");
    const bodyOffset = Buffer.byteLength("BEGIN\n  FOR i IN 1..2 LOOP\n    ");
    const exitOffset = Buffer.byteLength(
      "BEGIN\n  FOR i IN 1..2 LOOP\n    PERFORM i;\n  END LOOP;",
    );
    const analysis: CoverageAnalysis = {
      diagnostics: [],
      points: [
        {
          id: "p0",
          line: 2,
          endLine: 2,
          kind: "statement",
          label: "for",
          placement: {
            kind: "before",
            line: 2,
            siteKey: "root.0",
            byteOffset: loopOffset,
          },
        },
        {
          id: "p1",
          line: 2,
          endLine: 2,
          kind: "branch",
          label: "loop enter @2",
          placement: {
            kind: "loop_enter",
            loopLine: 2,
            line: 3,
            searchAfter: 3,
            siteKey: "root.0.loop.0",
            loopByteOffset: loopOffset,
            byteOffset: bodyOffset,
          },
        },
        {
          id: "p2",
          line: 2,
          endLine: 2,
          kind: "branch",
          label: "loop exit @2",
          placement: {
            kind: "loop_exit",
            loopLine: 2,
            searchAfter: 3,
            byteOffset: exitOffset,
          },
        },
      ],
    };

    const instrumented = instrumentCoverageSyntaxBody(source, analysis, "loop-run").body;

    expect(instrumented).not.toContain("__plpgsql_cov");
    expect(instrumented).not.toContain("IF NOT");
    expect(instrumented).toContain(
      "RAISE WARNING 'postgresql-workbench-cov:loop-run:p1';\n    PERFORM i;",
    );
    expect(instrumented).toContain(
      "END LOOP;\n  RAISE WARNING 'postgresql-workbench-cov:loop-run:p2';\nEND;",
    );
  });
});
