import { describe, expect, it } from "vitest";
import {
  classifySqlResultExecution,
  classifySqlStatementCount,
  planSqlResultExecution,
} from "./sqlStatements.js";
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
          statements.map((statement) => ({
            ...node("toplevel_stmt", [statement]),
            byteRange: statement.byteRange,
            start: statement.start,
            end: statement.end,
          })),
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

  it("marks transaction-control Statements structurally", async () => {
    const parser = parserWith([
      { ...node("TransactionStmt"), byteRange: [0, 6], end: { line: 1, column: 7 } },
    ]);
    await expect(planSqlResultExecution("COMMIT", parser)).resolves.toEqual({
      status: "ready",
      statements: [{ sql: "COMMIT", resultKind: "non-paged", line: 1, transactionControl: true }],
    });
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

  it("reports an exhausted client budget separately from invalid SQL", async () => {
    await expect(
      planSqlResultExecution(
        "SELECT 1",
        parserWith([node("SelectStmt")], {
          truncated: true,
          emittedNodes: 100_000,
          totalNodes: 120_000,
          maxDepth: 1_024,
        }),
        { maxDepth: 1_024, maxNodes: 100_000 },
      ),
    ).resolves.toEqual({
      status: "analysis-error",
      reason: "budget-exhausted",
      message: "The SQL syntax tree exceeded the configured analysis budget.",
      budget: { maxDepth: 1_024, maxNodes: 100_000 },
      emittedNodes: 100_000,
      totalNodes: 120_000,
      observedDepth: 1_024,
    });
  });

  it("builds an ordered execution plan from exact top-level statement ranges", async () => {
    const source = "SELECT 1;\nCREATE TEMP TABLE silent(id int);\nSELECT 2;";
    const secondStart = source.indexOf("CREATE");
    const thirdStart = source.lastIndexOf("SELECT");
    const wrapper = (
      statement: SyntaxNode,
      start: number,
      end: number,
      line: number,
    ): SyntaxNode => ({
      ...node("toplevel_stmt", [statement]),
      byteRange: [start, end],
      start: { line, column: 1 },
      end: { line, column: end - start + 1 },
    });
    const parser: SyntaxParser = {
      async parse() {
        return {
          ...(await parserWith([]).parse({ language: "sql", source })),
          root: node("root", [
            wrapper(node("SelectStmt"), 0, secondStart - 1, 1),
            wrapper(node("CreateStmt"), secondStart, thirdStart - 1, 2),
            wrapper(node("SelectStmt"), thirdStart, source.length, 3),
          ]),
        };
      },
    };

    await expect(planSqlResultExecution(source, parser)).resolves.toEqual({
      status: "ready",
      statements: [
        { sql: "SELECT 1;", resultKind: "paged-query", line: 1 },
        {
          sql: "CREATE TEMP TABLE silent(id int);",
          resultKind: "non-paged",
          line: 2,
          schemaMutation: true,
        },
        { sql: "SELECT 2;", resultKind: "paged-query", line: 3 },
      ],
    });
  });

  it("returns structured syntax and analysis failures", async () => {
    const errorNode = {
      ...node("ERROR"),
      error: true,
      start: { line: 2, column: 11 },
    };
    await expect(
      planSqlResultExecution("SELECT 1;\nSELECT +;", parserWith([errorNode], { hasError: true })),
    ).resolves.toEqual({ status: "syntax-error", line: 2, column: 11 });
    await expect(
      planSqlResultExecution("SELECT 1", {
        async parse() {
          throw new Error("syntax runtime unavailable");
        },
      }),
    ).resolves.toEqual({ status: "analysis-error", message: "syntax runtime unavailable" });
  });

  it("forwards a client-selected syntax budget to Code Moniker", async () => {
    let received: Parameters<SyntaxParser["parse"]>[0] | undefined;
    const delegate = parserWith([node("SelectStmt")]);
    const parser: SyntaxParser = {
      async parse(request) {
        received = request;
        return delegate.parse(request);
      },
    };

    await expect(
      planSqlResultExecution("SELECT 1", parser, { maxDepth: 1_024, maxNodes: 100_000 }),
    ).resolves.toMatchObject({ status: "ready" });
    expect(received).toMatchObject({ maxDepth: 1_024, maxNodes: 100_000 });
  });
});
