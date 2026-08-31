import { describe, expect, it, vi } from "vitest";
import { createCodeMonikerSyntaxParser } from "./codeMonikerSyntax.js";

describe("createCodeMonikerSyntaxParser", () => {
  it("parses transient PL/pgSQL through the stateless Code Moniker contract", async () => {
    const queryData = vi.fn().mockResolvedValue({
      file: "routine.plpgsql",
      language: "plpgsql",
      focus: "routine.plpgsql",
      focus_line_range: null,
      root: {
        kind: "source_file",
        language: null,
        named: true,
        error: false,
        missing: false,
        byte_range: [0, 23],
        start: { line: 1, column: 0 },
        end: { line: 1, column: 23 },
        text: null,
        children: [
          {
            kind: "pl_block",
            named: true,
            error: false,
            missing: false,
            byte_range: [0, 23],
            start: { line: 1, column: 0 },
            end: { line: 1, column: 23 },
            text: null,
            children: [],
          },
        ],
      },
      emitted_nodes: 2,
      total_nodes: 2,
      max_depth: 32,
      truncated: false,
      has_error: false,
    });
    const parser = createCodeMonikerSyntaxParser({ queryData });

    const result = await parser.parse({
      language: "plpgsql",
      source: "BEGIN RETURN 1; END;",
      uri: "routine.plpgsql",
    });

    expect(queryData).toHaveBeenCalledWith(
      {
        op: "syntax_parse",
        language: "plpgsql",
        source: "BEGIN RETURN 1; END;",
        uri: "routine.plpgsql",
        max_depth: 32,
        max_nodes: 2000,
        named_only: false,
        include_text: false,
        max_text_chars: 0,
      },
      "syntax_tree",
    );
    expect(result).toEqual({
      file: "routine.plpgsql",
      language: "plpgsql",
      target: { language: "plpgsql", entryPoint: "block" },
      focus: "routine.plpgsql",
      focusLineRange: null,
      root: {
        kind: "source_file",
        language: null,
        named: true,
        error: false,
        missing: false,
        byteRange: [0, 23],
        start: { line: 1, column: 0 },
        end: { line: 1, column: 23 },
        text: null,
        children: [
          {
            kind: "pl_block",
            language: null,
            named: true,
            error: false,
            missing: false,
            byteRange: [0, 23],
            start: { line: 1, column: 0 },
            end: { line: 1, column: 23 },
            text: null,
            children: [],
          },
        ],
      },
      emittedNodes: 2,
      totalNodes: 2,
      maxDepth: 32,
      truncated: false,
      hasError: false,
    });
  });

  it("selects the SQL grammar through the same stateless boundary", async () => {
    const queryData = vi.fn().mockResolvedValue({
      file: "query.sql",
      language: "sql",
      focus: "query.sql",
      focus_line_range: null,
      root: {
        kind: "program",
        language: null,
        named: true,
        error: false,
        missing: false,
        byte_range: [0, 9],
        start: { line: 1, column: 0 },
        end: { line: 1, column: 9 },
        text: null,
        children: [],
      },
      emitted_nodes: 1,
      total_nodes: 1,
      max_depth: 32,
      truncated: false,
      has_error: false,
    });
    const parser = createCodeMonikerSyntaxParser({ queryData });

    const result = await parser.parse({
      language: "sql",
      source: "SELECT 1;",
      uri: "query.sql",
      maxDepth: 4,
      maxNodes: 2_000,
      namedOnly: true,
    });

    expect(queryData).toHaveBeenCalledWith(
      expect.objectContaining({
        op: "syntax_parse",
        language: "sql",
        source: "SELECT 1;",
        max_depth: 4,
        max_nodes: 2_000,
        named_only: true,
      }),
      "syntax_tree",
    );
    expect(result.language).toBe("sql");
    expect(result.hasError).toBe(false);
  });

  it("maps only nested parser language roots to explicit Workbench region facts", async () => {
    const queryData = vi.fn().mockResolvedValue({
      file: "routine.sql",
      language: "sql",
      focus: "routine.sql",
      focus_line_range: null,
      root: {
        kind: "source_file",
        language: "sql",
        named: true,
        error: false,
        missing: false,
        byte_range: [0, 8],
        start: { line: 1, column: 0 },
        end: { line: 1, column: 8 },
        text: null,
        children: [
          {
            kind: "source_file",
            language: "plpgsql",
            entry_point: "block",
            has_error: false,
            named: true,
            error: false,
            missing: false,
            byte_range: [2, 6],
            start: { line: 1, column: 2 },
            end: { line: 1, column: 6 },
            text: null,
            children: [],
          },
        ],
      },
      emitted_nodes: 2,
      total_nodes: 2,
      max_depth: 32,
      truncated: false,
      has_error: false,
    });
    const parser = createCodeMonikerSyntaxParser({ queryData });

    const result = await parser.parse({ language: "sql", source: "01234567" });

    expect(result.root.languageRegion).toBeUndefined();
    expect(result.root.children[0].languageRegion).toEqual({
      language: "plpgsql",
      entryPoint: "block",
      hasError: false,
      projection: { kind: "identity" },
    });
  });
});
