import { describe, expect, it } from "vitest";
import { postgresCaretShape, postgresDocumentShape } from "./documentShape.js";
import type { SyntaxLanguage, SyntaxNode, SyntaxTree } from "./syntaxTree.js";

function node(
  kind: string,
  byteRange: [number, number],
  children: SyntaxNode[] = [],
  languageRegion?: SyntaxLanguage,
): SyntaxNode {
  return {
    kind,
    language: languageRegion ?? null,
    ...(languageRegion === undefined
      ? {}
      : { languageRegion: { language: languageRegion, projection: { kind: "identity" } } }),
    named: true,
    error: false,
    missing: false,
    byteRange,
    start: { line: 1, column: byteRange[0] },
    end: { line: 1, column: byteRange[1] },
    text: null,
    children,
  };
}

function tree(root: SyntaxNode, language: SyntaxLanguage = "sql"): SyntaxTree {
  return {
    file: "shape.sql",
    language,
    target:
      language === "sql"
        ? { language: "sql", entryPoint: "script" }
        : { language: "plpgsql", entryPoint: "block" },
    focus: "shape.sql",
    focusLineRange: null,
    root,
    emittedNodes: 1,
    totalNodes: 1,
    maxDepth: 32,
    truncated: false,
    hasError: false,
  };
}

describe("postgresDocumentShape", () => {
  it("keeps SQL, PL/pgSQL and embedded SQL as nested, never merged regions", () => {
    const source = "HEADER PLPGSQL SELECT TAIL";
    const embeddedSql = node("source_file", [15, 21], [], "sql");
    const plpgsql = node("source_file", [7, 22], [embeddedSql], "plpgsql");
    const shape = postgresDocumentShape(
      source,
      tree(node("source_file", [0, source.length], [plpgsql])),
    );

    expect(shape.root.language).toBe("sql");
    expect(shape.root.children).toHaveLength(1);
    expect(shape.root.children[0]).toMatchObject({
      language: "plpgsql",
      sourceRange: { start: 7, end: 22 },
      target: {
        status: "unavailable",
        reason: "syntax-provider-did-not-report-entry-point",
      },
    });
    expect(shape.root.children[0].children[0]).toMatchObject({
      language: "sql",
      kind: "embedded-sql",
      sourceRange: { start: 15, end: 21 },
      target: {
        status: "unavailable",
        reason: "syntax-provider-did-not-report-entry-point",
      },
    });
    expect(postgresCaretShape(shape, 17)?.language).toBe("sql");
    expect(postgresCaretShape(shape, 10)?.language).toBe("plpgsql");
    expect(postgresCaretShape(shape, 2)?.language).toBe("sql");
    expect(postgresCaretShape(shape, 17)).toMatchObject({
      status: "projected",
      analysisOffset: 2,
    });
  });

  it("preserves a same-language SQL routine body as its own region", () => {
    const source = "CREATE SQL BODY END";
    const body = node("source_file", [11, 15], [], "sql");
    const routine = node("CreateFunctionStmt", [0, source.length], [body]);
    const shape = postgresDocumentShape(
      source,
      tree(node("source_file", [0, source.length], [routine])),
    );

    expect(shape.root.children[0]).toMatchObject({
      language: "sql",
      kind: "parser-injection",
      analysisSource: "BODY",
    });
  });

  it("keeps a provider-reported injected entry point and never inherits its parent target", () => {
    const source = "BEGIN amount + tax END";
    const expression = node("sql_expression", [6, 18], [], "sql");
    expression.languageRegion = {
      language: "sql",
      entryPoint: "expression",
      hasError: false,
      projection: { kind: "identity" },
    };
    const body = node("source_file", [0, source.length], [expression], "plpgsql");
    const shape = postgresDocumentShape(
      source,
      tree(node("source_file", [0, source.length], [body])),
    );

    expect(shape.root.target).toEqual({
      status: "available",
      target: { language: "sql", entryPoint: "script" },
    });
    expect(shape.root.children[0].target.status).toBe("unavailable");
    expect(shape.root.children[0].children[0].target).toEqual({
      status: "available",
      target: { language: "sql", entryPoint: "expression" },
    });
  });

  it("rejects an inconsistent document language and syntax target", () => {
    const source = "SELECT 1";
    const inconsistent = tree(node("source_file", [0, source.length]));
    inconsistent.target = { language: "plpgsql", entryPoint: "block" };

    expect(() => postgresDocumentShape(source, inconsistent)).toThrow(
      /Mismatched document language and syntax target/u,
    );
  });

  it("projects UTF-8 byte ranges to LSP UTF-16 offsets", () => {
    const source = "é😀BEGIN END";
    // `é` is two UTF-8 bytes; 😀 is four bytes and two UTF-16 units.
    const body = node("source_file", [6, 15], [], "plpgsql");
    const shape = postgresDocumentShape(
      source,
      tree(node("source_file", [0, Buffer.byteLength(source, "utf8")], [body])),
    );

    expect(shape.root.children[0].sourceRange).toEqual({ start: 3, end: 12 });
    expect(shape.root.children[0].analysisSource).toBe("BEGIN END");
  });

  it("does not invent a region when the parser reports none", () => {
    const source = "DO $$$$";
    const shape = postgresDocumentShape(source, tree(node("source_file", [0, source.length], [])));

    expect(shape.root.children).toEqual([]);
    expect(postgresCaretShape(shape, 5)?.language).toBe("sql");
  });

  it("derives the document language from the syntax tree", () => {
    const source = "BEGIN END";
    const shape = postgresDocumentShape(
      source,
      tree(node("source_file", [0, source.length]), "plpgsql"),
    );

    expect(shape.root.language).toBe("plpgsql");
  });

  it("uses half-open child ranges and gives an adjacent boundary to the next region", () => {
    const source = "AAAABBBB";
    const first = node("source_file", [0, 4], [], "plpgsql");
    const second = node("source_file", [4, 8], [], "sql");
    const shape = postgresDocumentShape(
      source,
      tree(node("source_file", [0, source.length], [first, second])),
    );

    expect(postgresCaretShape(shape, 0)?.regionId).toBe(shape.root.children[0].id);
    expect(postgresCaretShape(shape, 4)?.regionId).toBe(shape.root.children[1].id);
    expect(postgresCaretShape(shape, 8)?.regionId).toBe(shape.root.children[1].id);
    expect(postgresCaretShape(shape, 9)).toBeUndefined();
  });

  it("gives an empty routine body its unique caret position", () => {
    const source = "BEFOREAFTER";
    const emptyBody = node("source_file", [6, 6], [], "plpgsql");
    const shape = postgresDocumentShape(
      source,
      tree(node("source_file", [0, source.length], [emptyBody])),
    );

    expect(postgresCaretShape(shape, 6)).toMatchObject({
      regionId: shape.root.children[0].id,
      language: "plpgsql",
      status: "projected",
      analysisOffset: 0,
    });
  });

  it("keeps a proven but unprojectable region distinct from its SQL parent", () => {
    const source = "AS 'BEGIN END'";
    const body = node("source_file", [4, 13], [], "plpgsql");
    body.languageRegion = {
      language: "plpgsql",
      projection: { kind: "unavailable", reason: "decoded SQL string literal" },
    };
    const shape = postgresDocumentShape(
      source,
      tree(node("source_file", [0, source.length], [body])),
    );

    expect(shape.root.children[0].analysisSource).toBeUndefined();
    expect(postgresCaretShape(shape, 8)).toMatchObject({
      language: "plpgsql",
      status: "unprojectable",
      reason: "decoded SQL string literal",
    });
  });

  it("rejects overlapping sibling regions instead of selecting one arbitrarily", () => {
    const source = "0123456789";
    const first = node("source_file", [1, 6], [], "plpgsql");
    const second = node("source_file", [5, 9], [], "sql");

    expect(() =>
      postgresDocumentShape(source, tree(node("source_file", [0, source.length], [first, second]))),
    ).toThrow(/Overlapping language regions/u);
  });

  it("ignores low-level language metadata that is not an explicit region fact", () => {
    const source = "SELECT 1";
    const ordinary = node("SelectStmt", [0, source.length]);
    ordinary.language = "sql";
    const shape = postgresDocumentShape(
      source,
      tree(node("source_file", [0, source.length], [ordinary])),
    );

    expect(shape.root.children).toEqual([]);
  });
});
