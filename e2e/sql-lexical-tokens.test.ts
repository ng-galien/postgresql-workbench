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

  it("descends into the parse the grammar injects in a dollar-quoted body", async () => {
    const source = [
      "CREATE FUNCTION f(n integer) RETURNS integer LANGUAGE plpgsql AS $fn$",
      "DECLARE",
      "  r integer := 0;",
      "BEGIN",
      "  RETURN r; -- done",
      "END;",
      "$fn$;",
    ].join("\n");
    const pieces = await piecesOf(source);
    const kinds = new Map(pieces.map((piece) => [piece.text, piece.type]));
    expect(kinds.get("DECLARE")).toBe("keyword");
    expect(kinds.get("BEGIN")).toBe("keyword");
    expect(kinds.get("RETURN")).toBe("keyword");
    expect(kinds.get("END")).toBe("keyword");
    expect(kinds.get("-- done")).toBe("comment");
    // The delimiters stay the literal's; the body between them belongs to its own grammar.
    expect(kinds.get("$fn$")).toBe("string");
    expect(pieces.filter((piece) => piece.type === "string")).toHaveLength(2);
  });

  it("reads SQL regions nested in PL/pgSQL through the syntax port", async () => {
    const source = [
      "CREATE FUNCTION shop.reprice(p_order_id bigint) RETURNS void LANGUAGE plpgsql AS $fn$",
      "BEGIN",
      "  UPDATE shop.sales_order_line",
      "  SET line_total = round(unit_price * quantity * (1 - discount_rate), 2)",
      "  WHERE sales_order_id = p_order_id;",
      "END;",
      "$fn$;",
    ].join("\n");
    const pieces = await piecesOf(source);
    const kinds = new Map(pieces.map((piece) => [piece.text, piece.type]));
    expect(kinds.get("UPDATE")).toBe("keyword");
    expect(kinds.get("SET")).toBe("keyword");
    expect(kinds.get("WHERE")).toBe("keyword");
    expect(kinds.get("2")).toBe("number");
    expect(kinds.get("*")).toBe("operator");
    expect(kinds.get("=")).toBe("operator");
  });

  it("covers every piece across every nested language region", async () => {
    /*
     * The completeness proof. Every non-blank byte of the corpus must be covered by a lexical
     * piece or stand where a name stands — an identifier, or a keyword in a name position, both
     * the names layer's to colour. A construct the reader does not know shows up here as its own
     * uncovered text, so a missing kind is a red test naming the text it missed, not a plain
     * piece nobody looks at.
     */
    const source = [
      "CREATE OR REPLACE FUNCTION shop.reprice_order(p_order_id bigint)",
      "RETURNS shop.sales_order",
      "LANGUAGE plpgsql",
      "AS $function$",
      "DECLARE",
      "  result shop.sales_order;",
      "BEGIN",
      "  UPDATE shop.sales_order_line",
      "  SET line_total = round(unit_price * quantity * (1 - discount_rate), 2)",
      "  WHERE sales_order_id = p_order_id;",
      "",
      "  UPDATE shop.sales_order",
      "  SET subtotal = totals.subtotal,",
      "      tax_total = round((totals.subtotal - totals.discount_total) * 0.20, 2),",
      "      updated_at = now()",
      "  FROM (",
      "    SELECT",
      "      coalesce(sum(unit_price * quantity), 0) AS subtotal,",
      "      coalesce(sum(unit_price * quantity - line_total), 0) AS discount_total",
      "    FROM shop.sales_order_line",
      "    WHERE sales_order_id = p_order_id",
      "  ) AS totals",
      "  WHERE sales_order.id = p_order_id",
      "  RETURNING sales_order.* INTO result;",
      "",
      "  RETURN result; -- and E'\\n' or X'1f'",
      "END;",
      "$function$;",
    ].join("\n");
    const tree = await parser.parse({ language: "sql", source, namedOnly: false });
    const tokens = sqlLexicalTokens(tree, source);

    const lines = source.split("\n");
    const covered = lines.map((line) => Array.from(line, () => false));
    for (const token of tokens) {
      for (let at = token.character; at < token.character + token.length; at += 1) {
        const line = covered[token.line];
        if (line) line[at] = true;
      }
    }
    const identifier = /[\w$"%.]/u;
    const gaps: string[] = [];
    for (const [index, line] of lines.entries()) {
      let gap = "";
      for (let at = 0; at < line.length; at += 1) {
        const character = line[at] ?? " ";
        const fine = covered[index]?.[at] || /\s/u.test(character) || identifier.test(character);
        if (!fine) gap += character;
        else if (gap) {
          gaps.push(`line ${index + 1}: "${gap}"`);
          gap = "";
        }
      }
      if (gap) gaps.push(`line ${index + 1}: "${gap}"`);
    }
    expect(gaps).toEqual([]);
  });

  it("says nothing about a name: what a name means is the other answer", async () => {
    const pieces = await piecesOf("SELECT alpha FROM beta;");
    expect(pieces.some((piece) => piece.text === "alpha" || piece.text === "beta")).toBe(false);
  });
});
