import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureLocalCodeMonikerWorkspace } from "../packages/catalog/src/localCodeMoniker.js";
import { createCodeMonikerSyntaxParser } from "../packages/sql/src/analysis/codeMonikerSyntax.js";
import { postgresDocumentSyntaxFacts } from "../packages/sql/src/analysis/documentFacts.js";
import type { SyntaxParser } from "../packages/sql/src/analysis/syntaxTree.js";

describe("PostgreSQL document syntax facts", () => {
  let parser: SyntaxParser;
  let dispose: () => Promise<void>;

  beforeAll(async () => {
    const workspace = await mkdtemp(join(tmpdir(), "document-facts-"));
    const session = await ensureLocalCodeMonikerWorkspace({
      workspaceRoots: [workspace],
      clientName: "postgresql-workbench-document-facts",
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

  it("extracts plain-SQL names and syntax scopes without scanning text", async () => {
    const source = [
      "WITH nested AS (",
      "  SELECT same.id FROM shop.address AS same WHERE same.city = 'SELECT'",
      ")",
      'SELECT same."SELECT", shop.customer_revenue(same.id)',
      "FROM shop.address AS same;",
    ].join("\n");
    const facts = await postgresDocumentSyntaxFacts(parser, {
      language: "sql",
      source,
      uri: "facts.sql",
      maxDepth: 64,
      maxNodes: 5_000,
    });

    const relations = facts.names.filter((fact) => fact.role === "relation");
    const columns = facts.names.filter((fact) => fact.role === "column");
    const routines = facts.names.filter((fact) => fact.role === "routine");
    expect(facts.scopes.filter((scope) => scope.kind === "language-region")).toHaveLength(1);
    expect(facts.scopes.filter((scope) => scope.kind === "sql-query-scope")).toHaveLength(2);
    const scopeIds = new Set(facts.scopes.map((scope) => scope.id));
    expect(
      facts.scopes.every((scope) => scope.parentId === undefined || scopeIds.has(scope.parentId)),
    ).toBe(true);
    expect(relations.map((fact) => fact.parts.map((part) => part.canonical).join("."))).toEqual([
      "shop.address",
      "shop.address",
    ]);
    expect(relations.map((fact) => fact.alias?.canonical)).toEqual(["same", "same"]);
    expect(new Set(relations.map((fact) => fact.scopeId))).toHaveLength(2);
    for (const relation of relations) {
      const scope = facts.scopes.find((candidate) => candidate.id === relation.scopeId);
      expect(relation.visibility).toEqual([{ scopeId: relation.scopeId, range: scope?.range }]);
    }
    expect(columns.map((fact) => fact.parts.at(-1)?.canonical)).toEqual(
      expect.arrayContaining(["id", "city", "SELECT"]),
    );
    expect(routines).toEqual([
      expect.objectContaining({
        invocation: "function",
        parts: expect.arrayContaining([expect.objectContaining({ canonical: "customer_revenue" })]),
      }),
    ]);
    for (const fact of facts.names) {
      for (const part of fact.parts) {
        expect(source.slice(part.range.start, part.range.end)).toBe(part.written);
      }
    }
    expect(
      facts.lexical
        .filter((fact) => fact.kind === "keyword")
        .map((fact) => source.slice(fact.range.start, fact.range.end)),
    ).not.toContain("'SELECT'");
  });

  it("assigns facts in a SQL routine body to its parser-proven child region", async () => {
    const source =
      "CREATE FUNCTION f() RETURNS bigint LANGUAGE sql AS $sql$SELECT a.id FROM shop.address AS a;$sql$;";
    const facts = await postgresDocumentSyntaxFacts(parser, {
      language: "sql",
      source,
      uri: "routine.sql",
      maxDepth: 64,
      maxNodes: 5_000,
    });
    const body = facts.shape.root.children[0];

    expect(body).toMatchObject({
      language: "sql",
      analysisSource: "SELECT a.id FROM shop.address AS a;",
    });
    expect(
      facts.names
        .filter((fact) => fact.range.start >= body.sourceRange.start)
        .every((fact) => fact.regionId === body.id),
    ).toBe(true);
    expect(
      facts.lexical
        .filter(
          (fact) =>
            fact.range.start >= body.sourceRange.start && fact.range.end <= body.sourceRange.end,
        )
        .every((fact) => fact.regionId === body.id),
    ).toBe(true);
  });

  it("extracts a bare PL/pgSQL declaration without SQL recovery", async () => {
    const source = "DECLARE total CONSTANT bigint := 0; BEGIN total := total + 1; END";
    const facts = await postgresDocumentSyntaxFacts(parser, {
      language: "plpgsql",
      source,
      uri: "bare.pgsql",
      maxDepth: 64,
      maxNodes: 5_000,
    });

    expect(facts.shape.root.language).toBe("plpgsql");
    expect(facts.names).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "binding",
          bindingKind: "variable",
          use: "declaration",
          readonly: true,
          language: "plpgsql",
          parts: [expect.objectContaining({ canonical: "total" })],
        }),
        expect.objectContaining({
          role: "type",
          language: "plpgsql",
          parts: [expect.objectContaining({ canonical: "bigint" })],
        }),
      ]),
    );
    expect(facts.names.some((fact) => fact.role === "column")).toBe(false);
  });

  it("keeps a CREATE FUNCTION as SQL and exposes its parameter to the PL/pgSQL region", async () => {
    const source =
      "CREATE FUNCTION f(account_id bigint) RETURNS bigint LANGUAGE plpgsql AS $$BEGIN RETURN account_id; END$$;";
    const facts = await postgresDocumentSyntaxFacts(parser, {
      language: "sql",
      source,
      uri: "routine.sql",
      maxDepth: 64,
      maxNodes: 5_000,
    });
    const body = facts.shape.root.children.find((region) => region.language === "plpgsql");
    const parameter = facts.names.find(
      (fact) => fact.role === "binding" && fact.bindingKind === "parameter",
    );

    expect(facts.shape.root.language).toBe("sql");
    expect(body).toBeDefined();
    expect(parameter).toMatchObject({
      language: "sql",
      use: "declaration",
      readonly: false,
      parts: [expect.objectContaining({ canonical: "account_id" })],
      visibility: [{ scopeId: body?.id, range: body?.sourceRange }],
    });
    expect(parameter?.regionId).not.toBe(body?.id);
  });

  it("exposes a routine parameter to a parser-proven LANGUAGE sql body", async () => {
    const source =
      "CREATE FUNCTION f(account_id bigint) RETURNS bigint LANGUAGE sql AS $$SELECT account_id$$;";
    const facts = await postgresDocumentSyntaxFacts(parser, {
      language: "sql",
      source,
      uri: "sql-routine.sql",
      maxDepth: 64,
      maxNodes: 5_000,
    });
    const body = facts.shape.root.children.find((region) => region.language === "sql");
    const parameterFacts = facts.names.filter(
      (fact) => fact.role === "binding" && fact.bindingKind === "parameter",
    );

    expect(body).toBeDefined();
    expect(parameterFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          use: "declaration",
          language: "sql",
          visibility: [{ scopeId: body?.id, range: body?.sourceRange }],
        }),
        expect.objectContaining({
          use: "reference",
          language: "sql",
          regionId: body?.id,
          parts: [expect.objectContaining({ canonical: "account_id" })],
        }),
      ]),
    );
  });

  it("produces CTE and window declarations and references from syntax nodes", async () => {
    const source =
      "WITH recent AS (SELECT id FROM shop.address) SELECT sum(id) OVER w FROM recent WINDOW w AS (PARTITION BY id)";
    const facts = await postgresDocumentSyntaxFacts(parser, {
      language: "sql",
      source,
      uri: "named-scopes.sql",
      maxDepth: 64,
      maxNodes: 5_000,
    });

    const ctes = facts.names.filter((fact) => fact.role === "cte");
    expect(ctes.map((fact) => [fact.use, fact.parts.at(-1)?.canonical])).toEqual([
      ["declaration", "recent"],
      ["reference", "recent"],
    ]);
    const windows = facts.names.filter((fact) => fact.role === "window");
    expect(windows.map((fact) => [fact.use, fact.parts.at(-1)?.canonical])).toEqual([
      ["reference", "w"],
      ["declaration", "w"],
    ]);
    const cteDeclaration = ctes.find((fact) => fact.use === "declaration");
    const cteReference = ctes.find((fact) => fact.use === "reference");
    expect(cteDeclaration?.visibility[0]?.range.start).toBeLessThanOrEqual(
      cteReference?.range.start ?? -1,
    );
    const windowReference = windows.find((fact) => fact.use === "reference");
    const windowDeclaration = windows.find((fact) => fact.use === "declaration");
    expect(windowDeclaration?.visibility[0]?.range.start).toBeLessThanOrEqual(
      windowReference?.range.start ?? -1,
    );
  });

  it("makes a recursive CTE visible in its own grammar-defined body", async () => {
    const source =
      "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq) SELECT * FROM seq";
    const facts = await postgresDocumentSyntaxFacts(parser, {
      language: "sql",
      source,
      uri: "recursive-cte.sql",
      maxDepth: 64,
      maxNodes: 5_000,
    });
    const declaration = facts.names.find(
      (fact) => fact.role === "cte" && fact.use === "declaration",
    );
    const references = facts.names.filter(
      (fact) => fact.role === "cte" && fact.use === "reference",
    );

    expect(declaration).toMatchObject({ recursive: true });
    expect(references).toHaveLength(2);
    expect(declaration?.visibility[0]?.range.start).toBeLessThan(references[0]?.range.start ?? -1);
  });

  it("does not make a non-recursive CTE visible in its own body", async () => {
    const facts = await postgresDocumentSyntaxFacts(parser, {
      language: "sql",
      source: "WITH seq AS (SELECT * FROM seq) SELECT * FROM seq",
      uri: "non-recursive-cte.sql",
      maxDepth: 64,
      maxNodes: 5_000,
    });
    const declaration = facts.names.find(
      (fact) => fact.role === "cte" && fact.use === "declaration",
    );
    const references = facts.names.filter(
      (fact) => fact.role === "cte" && fact.use === "reference",
    );

    expect(declaration).toMatchObject({ recursive: false });
    expect(references).toHaveLength(1);
    expect(references[0]?.range.start).toBeGreaterThan(
      declaration?.visibility[0]?.range.start ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("does not inherit RECURSIVE from a nested WITH clause", async () => {
    const source =
      "WITH outer_cte AS (WITH RECURSIVE inner_cte(n) AS (SELECT 1) SELECT * FROM inner_cte) SELECT * FROM outer_cte";
    const facts = await postgresDocumentSyntaxFacts(parser, {
      language: "sql",
      source,
      uri: "nested-recursive-cte.sql",
      maxDepth: 64,
      maxNodes: 5_000,
    });
    const declarations = facts.names.filter(
      (fact) => fact.role === "cte" && fact.use === "declaration",
    );

    expect(declarations.map((fact) => [fact.parts.at(-1)?.canonical, fact.recursive])).toEqual([
      ["outer_cte", false],
      ["inner_cte", true],
    ]);
  });

  it("classifies only the outer CALL target as a procedure", async () => {
    const facts = await postgresDocumentSyntaxFacts(parser, {
      language: "sql",
      source: "CALL shop.archive_address(shop.lookup_address(1))",
      uri: "call.sql",
      maxDepth: 64,
      maxNodes: 5_000,
    });

    expect(
      facts.names
        .filter((fact) => fact.role === "routine")
        .map((fact) => [fact.parts.at(-1)?.canonical, fact.invocation]),
    ).toEqual([
      ["archive_address", "procedure"],
      ["lookup_address", "function"],
    ]);
  });

  it("returns no partial facts when the syntax budget truncates the tree", async () => {
    const facts = await postgresDocumentSyntaxFacts(parser, {
      language: "sql",
      source: "SELECT a.id FROM shop.address AS a",
      maxDepth: 2,
      maxNodes: 2,
    });

    expect(facts.shape.truncated).toBe(true);
    expect(facts.scopes).toEqual([]);
    expect(facts.lexical).toEqual([]);
    expect(facts.names).toEqual([]);
  });
});
