import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureLocalCodeMonikerWorkspace } from "../packages/catalog/src/localCodeMoniker.js";
import { createCodeMonikerSyntaxParser } from "../packages/sql/src/analysis/codeMonikerSyntax.js";
import { sqlLexicalTokens } from "../packages/sql/src/analysis/lexicalTokens.js";
import type { SyntaxParser } from "../packages/sql/src/analysis/syntaxTree.js";

/**
 * What a statement is made of, read from a real parse. The mapping is from node kinds a grammar
 * chooses, so nothing but the grammar itself can say whether it is right.
 */
describe("what a statement is made of", () => {
  let parser: SyntaxParser;
  let dispose: () => Promise<void>;

  beforeAll(async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lexical-tokens-"));
    const session = await ensureLocalCodeMonikerWorkspace({
      workspaceRoots: [workspace],
      clientName: "postgresql-workbench-lexical-tokens",
    });
    parser = createCodeMonikerSyntaxParser(session.client);
    dispose = async () => {
      await session.dispose();
      await rm(workspace, { force: true, recursive: true });
    };
  }, 30_000);

  afterAll(async () => {
    await dispose?.();
  });

  /** The pieces of a statement, each with the text it actually covers. */
  async function piecesOf(source: string) {
    const tree = await parser.parse({ language: "sql", source, namedOnly: false });
    const lines = source.split("\n");
    return sqlLexicalTokens(tree, source).map((token) => ({
      text: lines[token.line]?.slice(token.character, token.character + token.length),
      type: token.type,
    }));
  }

  it("names the words the grammar reserves", async () => {
    const pieces = await piecesOf("SELECT a FROM t AS x WHERE a < 1;");
    expect(pieces.filter((piece) => piece.type === "keyword").map((piece) => piece.text)).toEqual([
      "SELECT",
      "FROM",
      "AS",
      "WHERE",
    ]);
  });

  it("leaves a reserved word standing where a column name stands", async () => {
    const pieces = await piecesOf("SELECT p.name FROM t AS p;");
    expect(pieces.some((piece) => piece.text === "name")).toBe(false);
  });

  it("tells a literal, a number and a comment apart", async () => {
    const pieces = await piecesOf("-- why\nSELECT 'x', 10, 1.5;");
    expect(pieces.filter((piece) => piece.type !== "punctuation")).toEqual([
      { text: "-- why", type: "comment" },
      { text: "SELECT", type: "keyword" },
      { text: "'x'", type: "string" },
      { text: "10", type: "number" },
      { text: "1.5", type: "number" },
    ]);
  });

  it("places a piece where a reader sees it, not where its bytes are", async () => {
    const source = "SELECT 'Poivre fumé', x FROM t;";
    const pieces = await piecesOf(source);
    expect(pieces).toContainEqual({ text: "'Poivre fumé'", type: "string" });
    expect(pieces).toContainEqual({ text: ",", type: "punctuation" });
  });

  it("tells what separates from what computes", async () => {
    const pieces = await piecesOf("SELECT a + b, c FROM t WHERE a < 1;");
    const kinds = new Map(pieces.map((piece) => [piece.text, piece.type]));
    expect(kinds.get("+")).toBe("operator");
    expect(kinds.get("<")).toBe("operator");
    expect(kinds.get(",")).toBe("punctuation");
    expect(kinds.get(";")).toBe("punctuation");
  });

  it("reads a comment as one piece, keywords inside it and all", async () => {
    const pieces = await piecesOf("-- SELECT FROM WHERE\nSELECT 1;");
    expect(pieces[0]).toEqual({ text: "-- SELECT FROM WHERE", type: "comment" });
    expect(pieces.filter((piece) => piece.type === "keyword")).toHaveLength(1);
  });

  it("gives a piece that runs over several lines one token per line", async () => {
    const pieces = await piecesOf("/* one\n   two */\nSELECT 1;");
    expect(pieces.filter((piece) => piece.type === "comment")).toEqual([
      { text: "/* one", type: "comment" },
      { text: "   two */", type: "comment" },
    ]);
  });

  it("says nothing about a name: what a name means is the other answer", async () => {
    const pieces = await piecesOf("SELECT alpha FROM beta;");
    expect(pieces.some((piece) => piece.text === "alpha" || piece.text === "beta")).toBe(false);
  });
});
