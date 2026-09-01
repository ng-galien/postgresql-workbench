import { describe, expect, it } from "vitest";
import { coverageAsJson, coverageAsLcov, type ExportedCoverageFile } from "./coverageReport.js";

const files: ExportedCoverageFile[] = [
  {
    uri: "code+moniker://./srcset:test/lang:sql/schema:public/function:subject%28integer%29",
    statements: [
      {
        line: 5,
        executed: 2,
        branches: [
          { line: 4, executed: 1, label: "true" },
          { line: 4, executed: 0, label: "false" },
        ],
      },
      { line: 7, executed: 0, branches: [] },
    ],
  },
];

describe("coverage export", () => {
  it("writes a versioned JSON document", () => {
    expect(JSON.parse(coverageAsJson(files))).toMatchObject({
      version: 1,
      files: [
        {
          uri: "code+moniker://./srcset:test/lang:sql/schema:public/function:subject%28integer%29",
        },
      ],
    });
  });

  it("writes one-based LCOV statement and branch records", () => {
    expect(coverageAsLcov(files)).toContain(
      "SF:code+moniker://./srcset:test/lang:sql/schema:public/function:subject%28integer%29\nDA:6,2\nDA:8,0\nLF:2\nLH:1\nBRDA:5,0,0,1\nBRDA:5,0,1,0\nBRF:2\nBRH:1\nend_of_record",
    );
  });
});
