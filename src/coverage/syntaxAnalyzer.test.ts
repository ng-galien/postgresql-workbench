import { describe, expect, it } from "vitest";
import type { SyntaxNode, SyntaxParser, SyntaxTree } from "../analysis/syntaxTree.js";
import { analyzeCoverageSyntax, analyzeCoverageWithSyntaxParser } from "./syntaxAnalyzer.js";

describe("analyzeCoverageSyntax", () => {
  it("parses the authoritative PL/pgSQL body through the Workbench syntax boundary", async () => {
    const requests: Parameters<SyntaxParser["parse"]>[0][] = [];
    const syntax = tree(
      block(
        section(
          node(
            "proc_stmt",
            3,
            node(
              "stmt_loop",
              3,
              node("loop_label", 3, leaf("quoted_identifier", 3)),
              node("loop_body", 4, section(statement("stmt_exit", 5))),
            ),
          ),
        ),
      ),
    );
    const parser: SyntaxParser = {
      parse: async (request) => {
        requests.push(request);
        return syntax;
      },
    };
    const body = `
BEGIN
  <<"outer ""loop">>
  LOOP
    EXIT "outer ""loop";
  END LOOP "outer ""loop";
END;
`;
    const analysis = await analyzeCoverageWithSyntaxParser(body, parser);

    expect(requests).toEqual([
      {
        language: "plpgsql",
        source: body,
        uri: "coverage.plpgsql",
      },
    ]);
    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.points.map((point) => point.label)).toEqual(["loop", "loop enter @3", "exit"]);
  });

  it("classifies every supported statement from Code Moniker node kinds", () => {
    const syntax = tree(
      block(
        section(
          statement("stmt_assign", 2),
          statement("stmt_perform", 3),
          statement("stmt_execsql", 4),
          statement("stmt_dynexecute", 5),
          statement("stmt_return", 6, leaf("kw_next", 6)),
          statement("stmt_return", 7, leaf("kw_query", 7)),
          statement("stmt_call", 8),
          statement("stmt_getdiag", 9),
          statement("stmt_open", 10),
          statement("stmt_fetch", 11),
          statement("stmt_close", 12),
          statement("stmt_assert", 13),
          statement("stmt_exit", 14),
          statement("stmt_raise", 15),
          statement("stmt_return", 16),
        ),
      ),
    );

    const analysis = analyzeCoverageSyntax("", syntax);

    expect(
      analysis.points.filter((point) => point.kind === "statement").map((point) => point.label),
    ).toEqual([
      "assign",
      "perform",
      "execsql",
      "dynexecute",
      "return_next",
      "return_query",
      "call",
      "getdiag",
      "open",
      "fetch",
      "close",
      "assert",
      "exit",
      "raise",
      "return",
    ]);
    expect(analysis.diagnostics).toEqual([]);
  });

  it("models branches, loops, nested statements, and exception handlers", () => {
    const source = "division_by_zero";
    const condition = leaf("proc_condition", 16);
    condition.byteRange = [0, Buffer.byteLength(source)];
    const ifStatement = statement(
      "stmt_if",
      3,
      section(statement("stmt_return", 4)),
      node("elsif_clause", 5, section(statement("stmt_return", 6))),
    );
    const caseStatement = statement(
      "stmt_case",
      8,
      node("case_when", 9, section(statement("stmt_return", 10))),
    );
    const loopStatement = statement(
      "stmt_while",
      12,
      node("loop_body", 12, section(statement("stmt_assign", 13))),
    );
    const exception = node(
      "proc_exception",
      16,
      node("proc_conditions", 16, condition),
      section(statement("stmt_raise", 17)),
    );
    const syntax = tree(block(section(ifStatement, caseStatement, loopStatement), exception));

    const analysis = analyzeCoverageSyntax(source, syntax);

    expect(
      analysis.points.filter((point) => point.kind === "branch").map((point) => point.label),
    ).toEqual([
      "IF true @3",
      "ELSIF true @5",
      "IF false @3",
      "WHEN @9",
      "loop enter @12",
      "loop exit @12",
      "EXCEPTION division_by_zero",
    ]);
    expect(analysis.points.slice(0, 5).map((point) => point.label)).toEqual([
      "IF true @3",
      "ELSIF true @5",
      "return",
      "return",
      "IF false @3",
    ]);
    expect(analysis.points).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "statement", label: "return", line: 4 }),
        expect.objectContaining({ kind: "statement", label: "return", line: 6 }),
        expect.objectContaining({ kind: "statement", label: "return", line: 10 }),
        expect.objectContaining({ kind: "statement", label: "while", line: 12 }),
        expect.objectContaining({ kind: "statement", label: "assign", line: 13 }),
        expect.objectContaining({ kind: "statement", label: "raise", line: 17 }),
      ]),
    );
    expect(analysis.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "coverage.case-without-else",
        line: 8,
      }),
    );
  });

  it("counts every PL/pgSQL loop header as a statement independently from its branches", () => {
    const loopKinds = [
      ["stmt_for", "for", 2],
      ["stmt_foreach_a", "foreach", 5],
      ["stmt_while", "while", 8],
      ["stmt_loop", "loop", 11],
    ] as const;
    const syntax = tree(
      block(
        section(
          ...loopKinds.map(([kind, _label, line]) =>
            statement(
              kind,
              line,
              node("loop_body", line + 1, section(statement("stmt_perform", line + 1))),
            ),
          ),
        ),
      ),
    );

    const analysis = analyzeCoverageSyntax("", syntax);

    expect(
      analysis.points
        .filter((point) => point.kind === "statement")
        .map(({ line, label }) => ({ line, label })),
    ).toEqual([
      { line: 2, label: "for" },
      { line: 3, label: "perform" },
      { line: 5, label: "foreach" },
      { line: 6, label: "perform" },
      { line: 8, label: "while" },
      { line: 9, label: "perform" },
      { line: 11, label: "loop" },
      { line: 12, label: "perform" },
    ]);
    expect(
      analysis.points.filter((point) => point.kind === "branch").map((point) => point.label),
    ).toEqual([
      "loop enter @2",
      "loop exit @2",
      "loop enter @5",
      "loop exit @5",
      "loop enter @8",
      "loop exit @8",
      "loop enter @11",
    ]);
  });

  it("walks the direct nested block shape returned by Code Moniker", () => {
    const source = "no_data_found";
    const condition = leaf("proc_condition", 5);
    condition.byteRange = [0, Buffer.byteLength(source)];
    const nestedBlock = node(
      "proc_stmt",
      2,
      node(
        "pl_block",
        2,
        section(statement("stmt_perform", 3)),
        node(
          "proc_exception",
          5,
          node("proc_conditions", 5, condition),
          section(statement("stmt_return", 6)),
        ),
      ),
    );
    const syntax = tree(block(section(nestedBlock)));

    const analysis = analyzeCoverageSyntax(source, syntax);

    expect(analysis.points.map((point) => point.label)).toEqual([
      "perform",
      "EXCEPTION no_data_found",
      "return",
    ]);
  });

  it("fails closed on incomplete syntax trees", () => {
    const syntax = tree(block(section(statement("stmt_return", 2))));
    syntax.truncated = true;

    expect(analyzeCoverageSyntax("", syntax)).toEqual({
      points: [],
      diagnostics: [
        expect.objectContaining({
          severity: "error",
          code: "coverage.parse-truncated",
        }),
      ],
    });
  });
});

function tree(...children: SyntaxNode[]): SyntaxTree {
  return {
    file: "coverage.plpgsql",
    language: "plpgsql",
    focus: "coverage.plpgsql",
    focusLineRange: null,
    root: node("source_file", 1, ...children),
    emittedNodes: countNodes(children) + 1,
    totalNodes: countNodes(children) + 1,
    maxDepth: 32,
    truncated: false,
    hasError: false,
  };
}

function block(...children: SyntaxNode[]): SyntaxNode {
  return node("pl_block", 1, ...children);
}

function section(...children: SyntaxNode[]): SyntaxNode {
  return node("proc_sect", children[0]?.start.line ?? 1, ...children);
}

function statement(kind: string, line: number, ...children: SyntaxNode[]): SyntaxNode {
  return node("proc_stmt", line, node(kind, line, ...children));
}

function leaf(kind: string, line: number, text: string | null = null): SyntaxNode {
  return node(kind, line, text);
}

function node(
  kind: string,
  line: number,
  ...values: Array<SyntaxNode | string | null>
): SyntaxNode {
  const text = values.find((value): value is string | null => !isSyntaxNode(value)) ?? null;
  const children = values.filter(isSyntaxNode);
  const endLine = children.at(-1)?.end.line ?? line;
  return {
    kind,
    language: null,
    named: true,
    error: false,
    missing: false,
    byteRange: [line * 10, endLine * 10 + 1],
    start: { line, column: 2 },
    end: { line: endLine, column: 3 },
    text,
    children,
  };
}

function isSyntaxNode(value: SyntaxNode | string | null): value is SyntaxNode {
  return typeof value === "object" && value !== null;
}

function countNodes(nodes: readonly SyntaxNode[]): number {
  return nodes.reduce((total, current) => total + 1 + countNodes(current.children), 0);
}
