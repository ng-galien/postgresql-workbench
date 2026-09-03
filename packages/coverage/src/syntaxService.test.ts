import { describe, expect, it } from "vitest";
import type { SyntaxNode, SyntaxParser, SyntaxTree } from "../../sql/src/analysis/syntaxTree.js";
import { createCoverageSyntaxService } from "./syntaxService.js";

describe("coverage syntax service", () => {
  it("owns analysis, AST-offset instrumentation, and generated DDL validation", async () => {
    const body = "BEGIN\n  RETURN 1;\nEND;";
    const ddl = `-- misleading AS $fake$ text
CREATE FUNCTION public.subject() RETURNS integer
LANGUAGE plpgsql AS $body$${body}$body$;`;
    const bodyStart = Buffer.byteLength(ddl.slice(0, ddl.indexOf(body)), "utf8");
    const requests: Parameters<SyntaxParser["parse"]>[0][] = [];
    const parser: SyntaxParser = {
      parse: async (request) => {
        requests.push(request);
        if (requests.length === 1) return plpgsqlTree(body, true);
        if (requests.length === 2) {
          return sqlTree(
            request.source,
            node("source_file", 0, request.source.length, [
              node("dollar_quoted_string", bodyStart - 6, bodyStart + body.length + 6, [
                node("source_file", bodyStart, bodyStart + Buffer.byteLength(body), [], "plpgsql"),
              ]),
            ]),
          );
        }
        return sqlTree(request.source);
      },
    };
    const service = createCoverageSyntaxService(async () => parser);

    const sourceAnalysis = await service.analyze(body);
    const instrumented = await service.instrument({
      ddl,
      source: body,
      analysis: sourceAnalysis.analysis,
      runId: "ast",
    });

    expect(sourceAnalysis.procedureTransactionControl).toBe(true);
    expect(requests.map(({ language }) => language)).toEqual(["plpgsql", "sql", "sql"]);
    expect(requests[1].source).toBe(ddl);
    expect(requests[2].source).toBe(instrumented.ddl);
    expect(instrumented.body).toContain("RAISE WARNING 'postgresql-workbench-cov:ast:p0';");
    expect(instrumented.ddl).toContain(`$body$${instrumented.body}$body$`);
    expect(instrumented.ddl).toContain("-- misleading AS $fake$ text");
    expect(instrumented.bodyStartLine).toBe(2);
  });

  it("rejects a DDL whose embedded PL/pgSQL node is not the authoritative source", async () => {
    const body = "BEGIN\n  RETURN 1;\nEND;";
    const ddl = `CREATE FUNCTION subject() RETURNS integer
LANGUAGE plpgsql AS $body$BEGIN RETURN 2; END;$body$;`;
    const parser: SyntaxParser = {
      parse: async (request) =>
        request.language === "plpgsql"
          ? plpgsqlTree(body, false)
          : sqlTree(
              request.source,
              node("source_file", 0, request.source.length, [
                node("dollar_quoted_string", 0, request.source.length, [
                  node(
                    "source_file",
                    request.source.indexOf("BEGIN RETURN 2"),
                    request.source.indexOf("BEGIN RETURN 2") + "BEGIN RETURN 2; END;".length,
                    [],
                    "plpgsql",
                  ),
                ]),
              ]),
            ),
    };
    const service = createCoverageSyntaxService(async () => parser);
    const sourceAnalysis = await service.analyze(body);

    await expect(
      service.instrument({
        ddl,
        source: body,
        analysis: sourceAnalysis.analysis,
        runId: "mismatch",
      }),
    ).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "coverage.body-mismatch" })],
    });
  });

  it("recognizes SQL transaction statements structurally", async () => {
    const requests: Parameters<SyntaxParser["parse"]>[0][] = [];
    const parser: SyntaxParser = {
      parse: async (request) => {
        requests.push(request);
        return boundedTree(
          sqlTree(
            request.source,
            node("source_file", 0, request.source.length, [
              node("toplevel_stmt", 0, request.source.length, [
                node("stmt", 0, request.source.length, [
                  node("TransactionStmt", 0, request.source.length),
                ]),
              ]),
            ]),
          ),
          35,
          13,
        );
      },
    };
    const service = createCoverageSyntaxService(async () => parser);

    await expect(service.containsSqlTransactionControl("COMMIT")).resolves.toBe(true);
    expect(requests).toEqual([
      {
        language: "sql",
        source: "COMMIT",
        uri: "coverage-test.sql",
        maxDepth: 4,
        maxNodes: 2_000,
        namedOnly: true,
      },
    ]);
  });

  it("accepts depth-bounded SQL when the shallow node budget is not exhausted", async () => {
    const parser: SyntaxParser = {
      parse: async (request) =>
        boundedTree(
          sqlTree(
            request.source,
            node("source_file", 0, request.source.length, [
              node("toplevel_stmt", 0, request.source.length, [
                node("stmt", 0, request.source.length, [
                  node("SelectStmt", 0, request.source.length),
                ]),
              ]),
            ]),
          ),
          251,
          248,
        ),
    };
    const service = createCoverageSyntaxService(async () => parser);

    await expect(service.containsSqlTransactionControl("SELECT CASE ...")).resolves.toBe(false);
  });

  it("rejects a transaction scan that exhausts its shallow node budget", async () => {
    const parser: SyntaxParser = {
      parse: async (request) => boundedTree(sqlTree(request.source), 2_001, 2_000),
    };
    const service = createCoverageSyntaxService(async () => parser);

    await expect(service.containsSqlTransactionControl("SELECT 1")).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "coverage.test-sql-invalid" })],
    });
  });
});

function boundedTree(tree: SyntaxTree, totalNodes: number, emittedNodes: number): SyntaxTree {
  return {
    ...tree,
    totalNodes,
    emittedNodes,
    maxDepth: 4,
    truncated: true,
  };
}

function plpgsqlTree(source: string, withCommit: boolean): SyntaxTree {
  const returnStart = Buffer.byteLength("BEGIN\n  ", "utf8");
  const returnEnd = returnStart + Buffer.byteLength("RETURN 1;", "utf8");
  const statements = [
    node("proc_stmt", returnStart, returnEnd, [
      node("stmt_return", returnStart, returnEnd, [
        node("kw_return", returnStart, returnStart + "RETURN".length),
      ]),
    ]),
  ];
  if (withCommit) {
    // On a line of its own, as PostgreSQL would have it: two statements never share one.
    statements.push(
      node(
        "proc_stmt",
        returnEnd,
        returnEnd,
        [node("stmt_commit", returnEnd, returnEnd, [], null, 2)],
        null,
        2,
      ),
    );
  }
  return tree(
    "plpgsql",
    source,
    node("source_file", 0, Buffer.byteLength(source), [
      node("pl_block", 0, Buffer.byteLength(source), [
        node("kw_begin", 0, "BEGIN".length),
        node("proc_sect", returnStart, returnEnd, statements),
        node("kw_end", Buffer.byteLength(source) - "END;".length, Buffer.byteLength(source) - 1),
      ]),
    ]),
  );
}

function sqlTree(source: string, root?: SyntaxNode): SyntaxTree {
  return tree("sql", source, root ?? node("source_file", 0, Buffer.byteLength(source)));
}

function tree(language: string, _source: string, root: SyntaxNode): SyntaxTree {
  return {
    file: `${language}.sql`,
    language,
    target:
      language === "plpgsql"
        ? { language: "plpgsql", entryPoint: "block" }
        : { language: "sql", entryPoint: "script" },
    focus: `${language}.sql`,
    focusLineRange: null,
    root,
    emittedNodes: countNodes(root),
    totalNodes: countNodes(root),
    maxDepth: 8,
    truncated: false,
    hasError: false,
  };
}

function node(
  kind: string,
  start: number,
  end: number,
  children: SyntaxNode[] = [],
  language: string | null = null,
  line = 1,
): SyntaxNode {
  return {
    kind,
    language,
    ...(language === "sql" || language === "plpgsql"
      ? { languageRegion: { language, projection: { kind: "identity" as const } } }
      : {}),
    named: true,
    error: false,
    missing: false,
    byteRange: [start, end],
    start: { line, column: start },
    end: { line, column: end },
    text: null,
    children,
  };
}

function countNodes(root: SyntaxNode): number {
  return 1 + root.children.reduce((total, child) => total + countNodes(child), 0);
}
