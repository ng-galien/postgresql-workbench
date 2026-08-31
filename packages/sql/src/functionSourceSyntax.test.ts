import { describe, expect, it } from "vitest";
import type { SyntaxNode, SyntaxParser, SyntaxTree } from "./analysis/syntaxTree.js";
import { analyzeFunction } from "./functionSource.js";

const BODY = `DECLARE
  selected record;
  iterated record;
  x int := 0;
BEGIN
  x := other_func(x);
  SELECT 42::int AS id, 'x'::text AS label INTO selected;
  FOR iterated IN SELECT 7::bigint AS id LOOP
    PERFORM public.log(iterated.id);
  END LOOP;
EXCEPTION
  WHEN check_violation OR no_data_found THEN
    RAISE NOTICE 'bad';
END;`;

describe("analyzeFunction with Code Moniker syntax", () => {
  it("extracts declared variables and assignment targets", async () => {
    const { analysis } = await runAnalysis();
    expect(analysis.variables).toEqual([
      { name: "selected", type: "record", line: 2, isConst: false },
      { name: "iterated", type: "record", line: 3, isConst: false },
      { name: "x", type: "int", line: 4, isConst: false },
    ]);
    expect(analysis.variablesByLine.get(6)).toEqual(["x"]);
  });

  it("extracts function calls from embedded SQL expressions", async () => {
    const { analysis } = await runAnalysis();
    expect(analysis.functionCalls).toEqual([
      { name: "other_func", line: 6 },
      { name: "public.log", line: 9 },
    ]);
  });

  it("infers explicit record field types from SELECT INTO and FOR SELECT", async () => {
    const { analysis } = await runAnalysis();
    expect(analysis.recordFields.get("selected")).toEqual([
      { name: "id", type: "int4" },
      { name: "label", type: "text" },
    ]);
    expect(analysis.recordFields.get("iterated")).toEqual([{ name: "id", type: "int8" }]);
  });

  it("extracts exception conditions and the first handler line", async () => {
    const { analysis } = await runAnalysis();
    expect(analysis.exceptionHandlers).toEqual([
      { startLine: 13, conditions: ["check_violation", "no_data_found"] },
    ]);
  });

  it("keeps statement and nested loop lines steppable", async () => {
    const { analysis } = await runAnalysis();
    expect(analysis.steppableLines).toEqual(new Set([6, 7, 8, 9, 13]));
  });

  it("fails closed on an erroneous PL/pgSQL tree", async () => {
    const parser: SyntaxParser = {
      parse: async () => ({ ...plpgsqlTree(BODY), hasError: true }),
    };
    await expect(analyzeFunction(BODY, parser)).rejects.toThrow("syntax errors");
  });

  it("fails closed on a truncated PL/pgSQL tree", async () => {
    const parser: SyntaxParser = {
      parse: async () => ({ ...plpgsqlTree(BODY), truncated: true }),
    };
    await expect(analyzeFunction(BODY, parser)).rejects.toThrow("truncated");
  });
});

async function runAnalysis(): Promise<{
  analysis: Awaited<ReturnType<typeof analyzeFunction>>;
}> {
  const parser: SyntaxParser = {
    async parse(request) {
      return request.language === "plpgsql" ? plpgsqlTree(request.source) : sqlTree(request.source);
    },
  };
  return { analysis: await analyzeFunction(BODY, parser) };
}

function plpgsqlTree(source: string): SyntaxTree {
  const declarations = [
    declaration(source, "selected record;", "selected", "record"),
    declaration(source, "iterated record;", "iterated", "record"),
    declaration(source, "x int := 0;", "x", "int"),
  ];
  const assignment = syntaxNode(source, "stmt_assign", "x := other_func(x);", [
    syntaxNode(source, "sql_expression", "x"),
    syntaxNode(source, "sql_expression", "other_func(x)"),
  ]);
  const select = syntaxNode(
    source,
    "stmt_execsql",
    "SELECT 42::int AS id, 'x'::text AS label INTO selected;",
    [
      syntaxNode(
        source,
        "sql_expression",
        "SELECT 42::int AS id, 'x'::text AS label INTO selected",
      ),
    ],
  );
  const perform = syntaxNode(source, "stmt_perform", "PERFORM public.log(iterated.id);", [
    syntaxNode(source, "sql_expression", "public.log(iterated.id)"),
  ]);
  const loop = syntaxNode(
    source,
    "stmt_for",
    "FOR iterated IN SELECT 7::bigint AS id LOOP\n    PERFORM public.log(iterated.id);\n  END LOOP;",
    [
      syntaxNode(source, "for_variable", "iterated"),
      syntaxNode(source, "for_query", "SELECT 7::bigint AS id LOOP", [
        syntaxNode(source, "sql_expression", "SELECT 7::bigint AS id"),
      ]),
      syntaxNode(source, "loop_body", "PERFORM public.log(iterated.id);\n  END LOOP;", [
        syntaxNode(source, "proc_sect", "PERFORM public.log(iterated.id);", [
          procStatement(source, perform),
        ]),
      ]),
    ],
  );
  const raise = syntaxNode(source, "stmt_raise", "RAISE NOTICE 'bad';");
  const exception = syntaxNode(
    source,
    "proc_exception",
    "WHEN check_violation OR no_data_found THEN\n    RAISE NOTICE 'bad';",
    [
      syntaxNode(source, "proc_condition", "check_violation"),
      syntaxNode(source, "proc_condition", "no_data_found"),
      syntaxNode(source, "proc_sect", "RAISE NOTICE 'bad';", [procStatement(source, raise)]),
    ],
  );
  const block = syntaxNode(source, "pl_block", source, [
    syntaxNode(
      source,
      "decl_sect",
      "DECLARE\n  selected record;\n  iterated record;\n  x int := 0;",
      declarations,
    ),
    syntaxNode(
      source,
      "proc_sect",
      "x := other_func(x);\n  SELECT 42::int AS id, 'x'::text AS label INTO selected;\n  FOR iterated IN SELECT 7::bigint AS id LOOP\n    PERFORM public.log(iterated.id);\n  END LOOP;",
      [
        procStatement(source, assignment),
        procStatement(source, select),
        procStatement(source, loop),
      ],
    ),
    syntaxNode(
      source,
      "exception_sect",
      "EXCEPTION\n  WHEN check_violation OR no_data_found THEN\n    RAISE NOTICE 'bad';",
      [exception],
    ),
  ]);
  return syntaxTree(block);
}

function declaration(source: string, statement: string, name: string, type: string): SyntaxNode {
  return syntaxNode(source, "decl_stmt", statement, [
    syntaxNode(source, "decl_statement", statement, [
      syntaxNode(source, "decl_varname", name),
      syntaxNode(source, "decl_datatype", type, [], source.indexOf(statement)),
    ]),
  ]);
}

function procStatement(source: string, statement: SyntaxNode): SyntaxNode {
  return syntaxNodeByRange(source, "proc_stmt", statement.byteRange[0], statement.byteRange[1], [
    statement,
  ]);
}

function sqlTree(source: string): SyntaxTree {
  const children: SyntaxNode[] = [];
  for (const name of ["other_func", "public.log"]) {
    if (source.includes(name)) {
      children.push(
        syntaxNode(
          source,
          "func_application",
          `${name}(${name === "other_func" ? "x" : "iterated.id"})`,
          [syntaxNode(source, "func_name", name)],
        ),
      );
    }
  }
  if (source.includes("INTO selected")) {
    children.push(
      syntaxNode(source, "target_el", "42::int AS id", [
        syntaxNode(source, "Typename", "int"),
        syntaxNode(source, "ColLabel", "id"),
      ]),
      syntaxNode(source, "target_el", "'x'::text AS label", [
        syntaxNode(source, "Typename", "text"),
        syntaxNode(source, "ColLabel", "label"),
      ]),
      syntaxNode(source, "into_clause", "INTO selected", [
        syntaxNode(source, "qualified_name", "selected"),
      ]),
    );
  }
  if (source.includes("7::bigint")) {
    children.push(
      syntaxNode(source, "target_el", "7::bigint AS id", [
        syntaxNode(source, "Typename", "bigint"),
        syntaxNode(source, "ColLabel", "id"),
      ]),
    );
  }
  return syntaxTree(syntaxNode(source, "source_file", source, children));
}

function syntaxTree(root: SyntaxNode): SyntaxTree {
  return {
    file: "test.sql",
    language: "test",
    target: { language: "sql", entryPoint: "script" },
    focus: "test.sql",
    focusLineRange: null,
    root,
    emittedNodes: countNodes(root),
    totalNodes: countNodes(root),
    maxDepth: 32,
    truncated: false,
    hasError: false,
  };
}

function syntaxNode(
  source: string,
  kind: string,
  fragment: string,
  children: SyntaxNode[] = [],
  from = 0,
): SyntaxNode {
  const start = source.indexOf(fragment, from);
  if (start < 0) throw new Error(`Missing syntax fixture fragment: ${fragment}`);
  return syntaxNodeByRange(source, kind, start, start + fragment.length, children);
}

function syntaxNodeByRange(
  source: string,
  kind: string,
  start: number,
  end: number,
  children: SyntaxNode[],
): SyntaxNode {
  return {
    kind,
    language: null,
    named: true,
    error: false,
    missing: false,
    byteRange: [start, end],
    start: point(source, start),
    end: point(source, end),
    text: null,
    children,
  };
}

function point(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, column: lines.at(-1)?.length ?? 0 };
}

function countNodes(node: SyntaxNode): number {
  return 1 + node.children.reduce((total, child) => total + countNodes(child), 0);
}
