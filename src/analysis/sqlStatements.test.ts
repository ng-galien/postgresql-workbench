import { describe, expect, it } from "vitest";
import { classifySqlResultExecution, classifySqlStatementCount } from "./sqlStatements.js";
import type { SyntaxNode, SyntaxParser, SyntaxTree } from "./syntaxTree.js";

function node(kind: string, children: SyntaxNode[] = []): SyntaxNode {
  return {
    kind,
    language: "sql",
    named: true,
    error: false,
    missing: false,
    byteRange: [0, 0],
    start: { line: 1, column: 1 },
    end: { line: 1, column: 1 },
    text: null,
    children,
  };
}

function parserWith(statements: SyntaxNode[], overrides: Partial<SyntaxTree> = {}): SyntaxParser {
  return {
    async parse() {
      return {
        file: "selection.sql",
        language: "sql",
        focus: "",
        focusLineRange: null,
        root: node(
          "root",
          statements.map((statement) => node("toplevel_stmt", [statement])),
        ),
        emittedNodes: 1,
        totalNodes: 1,
        maxDepth: 1,
        truncated: false,
        hasError: false,
        ...overrides,
      };
    },
  };
}

describe("SQL result execution classification", () => {
  it("pages a single read-only SELECT", async () => {
    const parser = parserWith([node("SelectStmt")]);
    await expect(classifySqlResultExecution("SELECT 1", parser)).resolves.toBe("paged-query");
    await expect(classifySqlStatementCount("SELECT 1", parser)).resolves.toBe("single-statement");
  });

  it("keeps data-modifying CTEs on the non-paged path", async () => {
    const parser = parserWith([node("SelectStmt", [node("WithClause", [node("DeleteStmt")])])]);
    await expect(
      classifySqlResultExecution("WITH deleted AS (...) SELECT * FROM deleted", parser),
    ).resolves.toBe("non-paged");
  });

  it("does not mistake a nested SELECT in DDL for the top-level statement", async () => {
    const parser = parserWith([node("CreateTableAsStmt", [node("SelectStmt")])]);
    await expect(
      classifySqlResultExecution("CREATE TABLE copy AS SELECT * FROM source", parser),
    ).resolves.toBe("non-paged");
  });

  it("rejects multiple, empty, erroneous and truncated syntax trees", async () => {
    await expect(
      classifySqlResultExecution(
        "SELECT 1; SELECT 2",
        parserWith([node("SelectStmt"), node("SelectStmt")]),
      ),
    ).resolves.toBe("multiple-statements");
    await expect(classifySqlResultExecution("-- only a comment", parserWith([]))).resolves.toBe(
      "unclassifiable",
    );
    await expect(
      classifySqlResultExecution("SELECT", parserWith([node("SelectStmt")], { hasError: true })),
    ).resolves.toBe("unclassifiable");
    await expect(
      classifySqlResultExecution("SELECT 1", parserWith([node("SelectStmt")], { truncated: true })),
    ).resolves.toBe("unclassifiable");
  });
});
