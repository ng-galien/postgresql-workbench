import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureLocalCodeMonikerWorkspace } from "../packages/catalog/src/localCodeMoniker.js";
import { createCodeMonikerSyntaxParser } from "../packages/sql/src/analysis/codeMonikerSyntax.js";
import {
  PLPGSQL_GRAMMAR_KINDS,
  SQL_GRAMMAR_KINDS,
} from "../packages/sql/src/analysis/grammarKinds.js";
import {
  PLPGSQL_STATEMENT_KINDS,
  plpgsqlStatementName,
  plpgsqlStep,
  SQL_LEXICAL_KINDS,
} from "../packages/sql/src/analysis/postgresGrammar.js";
import { findSyntaxNodes } from "../packages/sql/src/analysis/syntaxNodes.js";
import type { SyntaxNode, SyntaxParser } from "../packages/sql/src/analysis/syntaxTree.js";

/**
 * The vocabulary against the parser that produces it.
 *
 * `grammarKinds.ts` is generated from the `node-types.json` of the two grammars Code Moniker runs,
 * and is committed rather than built: this repository cannot reach those grammars, one being a
 * Rust crate and the other a directory of Code Moniker's own checkout. So the copy can go stale —
 * Code Moniker upgrades its grammar, or diverges from it further, and nothing here would know.
 *
 * This is what would know. It parses with the parser that actually runs and refuses any node kind
 * the committed list does not declare. A corpus cannot prove the list complete — the one this file
 * used to hold missed `COMMIT`, `MOVE` and `ROLLBACK` because nobody had written them down — but it
 * can prove the list is still the grammar's.
 */

/** Statements, blocks, literals in every spelling, and a quoted label: what a corpus is for. */
const BODY = `DECLARE
  c CURSOR FOR SELECT 1;
  n integer;
BEGIN
  n := 1;
  PERFORM f();
  CALL p();
  ASSERT n > 0;
  RAISE NOTICE 'x';
  EXECUTE 'SELECT 1';
  SELECT 1 INTO n;
  OPEN c;
  FETCH c INTO n;
  MOVE c;
  CLOSE c;
  COMMIT;
  ROLLBACK;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN n := 2; ELSIF n < 0 THEN n := 3; ELSE n := 4; END IF;
  CASE n WHEN 1 THEN n := 5; ELSE n := 6; END CASE;
  LOOP EXIT; END LOOP;
  WHILE n > 0 LOOP CONTINUE; END LOOP;
  FOR i IN 1..3 LOOP n := i; END LOOP;
  FOREACH n IN ARRAY ARRAY[1,2] LOOP NULL; END LOOP;
  <<"quoted label">>
  BEGIN n := 7; EXCEPTION WHEN others THEN NULL; END;
  RETURN NEXT n;
  RETURN QUERY SELECT 1;
  RETURN n;
END`;

const STATEMENTS = `-- every spelling of a literal
SELECT 'plain', E'\\n', X'1f', B'1010', 10, 1.5, $tag$body$tag$
FROM shop.product AS p
WHERE p.name LIKE 'x%';
INSERT INTO shop.product (name) VALUES ('x');
UPDATE shop.product SET name = 'y' WHERE id = 1;
DELETE FROM shop.product WHERE id = 1;
CREATE TABLE t (id bigint PRIMARY KEY, at timestamptz DEFAULT now());`;

/** Every named kind a parse produced, whatever its depth. */
function namedKindsIn(root: SyntaxNode): Set<string> {
  const kinds = new Set<string>();
  const walk = (node: SyntaxNode) => {
    // An injected region is another grammar's vocabulary; its kinds are that grammar's to declare.
    if (node !== root && node.languageRegion !== undefined) return;
    if (node.named) kinds.add(node.kind);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return kinds;
}

describe("the grammar this Workbench is parsed by", () => {
  let parser: SyntaxParser;
  let dispose: () => Promise<void>;
  let body: SyntaxNode;
  let statements: SyntaxNode;

  beforeAll(async () => {
    const workspace = await mkdtemp(join(tmpdir(), "postgres-grammar-"));
    const session = await ensureLocalCodeMonikerWorkspace({
      workspaceRoots: [workspace],
      clientName: "postgresql-workbench-postgres-grammar",
    });
    parser = createCodeMonikerSyntaxParser(session.client);
    const budget = { maxDepth: 64, maxNodes: 20_000, namedOnly: false } as const;
    const parsedBody = await parser.parse({ language: "plpgsql", source: BODY, ...budget });
    const parsedStatements = await parser.parse({ language: "sql", source: STATEMENTS, ...budget });
    expect(parsedBody.hasError).toBe(false);
    expect(parsedStatements.hasError).toBe(false);
    body = parsedBody.root;
    statements = parsedStatements.root;
    dispose = async () => {
      await session.dispose();
      await rm(workspace, { force: true, recursive: true });
    };
  }, 30_000);

  afterAll(async () => {
    await dispose?.();
  });

  it("produces no PL/pgSQL kind the committed vocabulary does not declare", () => {
    const declared = new Set(PLPGSQL_GRAMMAR_KINDS);
    expect([...namedKindsIn(body)].filter((kind) => !declared.has(kind))).toEqual([]);
  });

  it("produces no SQL kind the committed vocabulary does not declare", () => {
    const declared = new Set(SQL_GRAMMAR_KINDS);
    expect([...namedKindsIn(statements)].filter((kind) => !declared.has(kind))).toEqual([]);
  });

  it("knows the statements every hand-written list had forgotten", () => {
    for (const kind of ["stmt_commit", "stmt_move", "stmt_rollback", "stmt_null"]) {
      expect(PLPGSQL_STATEMENT_KINDS.has(kind)).toBe(true);
    }
  });

  it("names no statement the grammar does not produce", () => {
    const declared = new Set(PLPGSQL_GRAMMAR_KINDS);
    expect([...PLPGSQL_STATEMENT_KINDS].filter((kind) => !declared.has(kind))).toEqual([]);
  });

  it("reads a nested block as a step of the body, not as nothing at all", () => {
    const steps = findSyntaxNodes(body, "proc_stmt").map((wrapper) => plpgsqlStep(wrapper));
    expect(steps.filter((step) => step === undefined)).toEqual([]);
    expect(steps.filter((step) => step?.held === "block")).toHaveLength(1);
  });

  it("tells the forms of a statement apart by the keyword under it", () => {
    const named = findSyntaxNodes(body, "proc_stmt").flatMap((wrapper) => {
      const step = plpgsqlStep(wrapper);
      return step?.held === "statement" ? [plpgsqlStatementName(step.node)] : [];
    });
    expect(named.filter((name) => name?.startsWith("return"))).toEqual([
      "return_next",
      "return_query",
      "return",
    ]);
    expect(named.filter((name) => name === "continue" || name === "exit")).toEqual([
      "exit",
      "continue",
    ]);
    expect(named).toContain("foreach");
  });

  it("knows every spelling of a literal this grammar has, including the two a list had missed", () => {
    const produced = [...namedKindsIn(statements)].filter((kind) => SQL_LEXICAL_KINDS.has(kind));
    expect(produced).toContain("escape_string_literal");
    expect(produced).toContain("hex_string_literal");
    expect(produced).toContain("bit_string_literal");
    expect(produced).toContain("dollar_quoted_string");
    expect(new Set(produced.map((kind) => SQL_LEXICAL_KINDS.get(kind)))).toEqual(
      new Set(["string", "number", "comment"]),
    );
  });
});
