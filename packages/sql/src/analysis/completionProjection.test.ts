import { describe, expect, it } from "vitest";
import { postgresCompletionSyntaxFacts } from "./completionProjection.js";
import type { PostgresDocumentSyntaxFacts } from "./documentFacts.js";
import { postgresAnalysisIdentity } from "./postgresSyntax.js";
import type {
  AvailablePostgresSqlSyntaxExpectation,
  PostgresSyntaxAuthority,
} from "./syntaxExpectations.js";

const AUTHORITY: PostgresSyntaxAuthority = {
  postgresRef: "REL_18_4",
  generator: { name: "gnu-bison", version: "3.8.2" },
  grammarDigest: "grammar",
  scannerDigest: "scanner",
  keywordDigest: "keywords",
  predictorDigest: "predictor",
  projectionDigest: "projection",
};

describe("postgresCompletionSyntaxFacts", () => {
  it("repairs only the provider-proven qualified separator with an identity mapping", async () => {
    const source = "SELECT p. FROM shop.product AS p";
    const original = facts(source, []);
    const expectation = qualifiedColumnExpectation(source, 9);
    let parsedSource = "";
    const projected = facts(source.replace("p.", " x"), [
      relationFact("shop", "product", "p", source.length),
    ]);

    const result = await postgresCompletionSyntaxFacts(
      source,
      original,
      original.shape.root,
      expectation,
      async (candidate) => {
        parsedSource = candidate;
        return { hasError: false, truncated: false, facts: projected };
      },
    );

    expect(parsedSource).toBe("SELECT  x FROM shop.product AS p");
    expect(result?.provenance).toMatchObject({
      kind: "grammar-proven-qualified-reference-projection",
      repairedDocumentRange: { start: 7, end: 9 },
      offsetMapping: "identity",
    });
    expect(result?.document.names).toContainEqual(expect.objectContaining({ role: "relation" }));
    expect(result?.document.shape).toBe(original.shape);
  });

  it.each([
    { source: "SELECT p FROM shop.product AS p", caret: 8 },
    { source: "SELECT p. FROM shop.product AS p", caret: 9, fragment: "x" },
  ])("fails closed without the exact separator and empty fragment proof", async (sample) => {
    const original = facts(sample.source, []);
    const expectation = qualifiedColumnExpectation(sample.source, sample.caret, sample.fragment);
    let reparsed = false;
    const result = await postgresCompletionSyntaxFacts(
      sample.source,
      original,
      original.shape.root,
      expectation,
      async () => {
        reparsed = true;
        return { hasError: false, truncated: false, facts: original };
      },
    );
    expect(reparsed).toBe(false);
    expect(result?.provenance.kind).toBe("original-document");
  });

  it("fails closed when the repaired parse still reports an error", async () => {
    const source = "SELECT p. FROM shop.product AS p";
    const original = facts(source, []);
    const result = await postgresCompletionSyntaxFacts(
      source,
      original,
      original.shape.root,
      qualifiedColumnExpectation(source, 9),
      async (projectedSource) => ({
        hasError: true,
        truncated: false,
        facts: facts(projectedSource, [relationFact("shop", "product", "p", source.length)]),
      }),
    );
    expect(result?.provenance.kind).toBe("original-document");
    expect(result?.document.names).toEqual([]);
  });

  it("uses the parser status of the active SQL region nested in PL/pgSQL", async () => {
    const source = "DO $$ BEGIN RETURN QUERY SELECT p. FROM shop.product AS p; END $$;";
    const sqlStart = source.indexOf("SELECT");
    const sqlEnd = source.indexOf("; END");
    const sqlSource = source.slice(sqlStart, sqlEnd);
    const caret = sqlSource.indexOf("p.") + 2;
    const original = embeddedSqlFacts(source, { start: sqlStart, end: sqlEnd }, true);
    const region = original.shape.root.children[0].children[0];
    const expectation = qualifiedColumnExpectation(sqlSource, caret, "", region.id);
    const repairedSource = `${source.slice(0, sqlStart + caret - 2)} x${source.slice(sqlStart + caret)}`;

    const accepted = await postgresCompletionSyntaxFacts(
      source,
      original,
      region,
      expectation,
      async () => ({
        hasError: false,
        truncated: false,
        facts: embeddedSqlFacts(repairedSource, { start: sqlStart, end: sqlEnd }, false),
      }),
    );
    expect(accepted?.provenance.kind).toBe("grammar-proven-qualified-reference-projection");

    const rejected = await postgresCompletionSyntaxFacts(
      source,
      original,
      region,
      expectation,
      async () => ({
        hasError: false,
        truncated: false,
        facts: embeddedSqlFacts(repairedSource, { start: sqlStart, end: sqlEnd }, true),
      }),
    );
    expect(rejected?.provenance.kind).toBe("original-document");
  });

  it("fails closed when source and parser-proven region facts are stale", async () => {
    const parsedSource = "SELECT p. FROM shop.product AS p";
    const currentSource = "SELECT q. FROM shop.product AS p";
    const original = facts(parsedSource, []);
    let reparsed = false;
    const result = await postgresCompletionSyntaxFacts(
      currentSource,
      original,
      original.shape.root,
      qualifiedColumnExpectation(parsedSource, 9),
      async () => {
        reparsed = true;
        return { hasError: false, truncated: false, facts: original };
      },
    );
    expect(reparsed).toBe(false);
    expect(result?.provenance.kind).toBe("original-document");
  });

  it("does not expose recovered facts from an erroneous active region without a prediction", async () => {
    const source = "SELECT broken FROM";
    const original = facts(source, []);
    original.shape.root.hasError = true;
    let reparsed = false;

    const result = await postgresCompletionSyntaxFacts(
      source,
      original,
      original.shape.root,
      {
        status: "unavailable",
        regionId: original.shape.root.id,
        reason: "provider-capability-missing",
        target: { language: "sql", entryPoint: "script" },
      },
      async () => {
        reparsed = true;
        return { hasError: false, truncated: false, facts: original };
      },
    );

    expect(reparsed).toBe(false);
    expect(result).toBeUndefined();
  });

  it("stands recovered names on an attested prefix without a local reparse", async () => {
    const source = "SELECT shop.find";
    const original = facts(source, [relationFact("shop", "find", "f", source.length)]);
    original.shape.root.hasError = true;
    original.scopes = [
      ...original.scopes,
      {
        id: "recovered-scope",
        regionId: original.shape.root.id,
        language: "sql",
        kind: "sql-query-scope",
        range: { start: 0, end: source.length },
        parentId: original.shape.root.id,
      },
    ];
    original.lexical = [
      {
        regionId: original.shape.root.id,
        language: "sql",
        scopeId: "recovered-scope",
        range: { start: 0, end: 6 },
        kind: "keyword",
      },
    ];

    const expectation = qualifiedColumnExpectation(source, source.length, "find");
    expectation.slots = [
      { language: "sql", slot: "routine", invocation: "function", qualifier: [] },
    ];
    const result = await postgresCompletionSyntaxFacts(
      source,
      original,
      original.shape.root,
      expectation,
      async () => {
        throw new Error("a non-separator prefix must not be reparsed locally");
      },
    );

    expect(result?.provenance.kind).toBe("original-document");
  });
});

function qualifiedColumnExpectation(
  source: string,
  caret: number,
  fragment = "",
  regionId = `sql:root:0-${source.length}`,
): AvailablePostgresSqlSyntaxExpectation {
  return {
    status: "available",
    regionId,
    target: {
      language: "sql",
      entryPoint: regionId.startsWith("sql:root:") ? "script" : "statement",
    },
    authority: AUTHORITY,
    analysisIdentity: postgresAnalysisIdentity(source),
    analysisOffset: caret,
    replacementRange: { start: caret - fragment.length, end: caret },
    fragment: fragment
      ? { written: fragment, canonical: fragment, form: "unquoted-identifier" }
      : { written: "", canonical: "", form: "none" },
    keywords: [],
    slots: [
      {
        language: "sql",
        slot: "column",
        qualifier: [{ written: "p", canonical: "p", quoted: false }],
      },
    ],
  };
}

function embeddedSqlFacts(
  source: string,
  sqlRange: { start: number; end: number },
  sqlHasError: boolean,
): PostgresDocumentSyntaxFacts {
  const rootRange = { start: 0, end: source.length };
  const plpgsqlRange = { start: 6, end: source.length - 4 };
  const rootId = `sql:root:0-${source.length}`;
  const plpgsqlId = `plpgsql:body:${plpgsqlRange.start}-${plpgsqlRange.end}`;
  const sqlId = `sql:statement:${sqlRange.start}-${sqlRange.end}`;
  const sqlSource = source.slice(sqlRange.start, sqlRange.end);
  const plpgsqlSource = source.slice(plpgsqlRange.start, plpgsqlRange.end);
  return {
    shape: {
      root: {
        id: rootId,
        language: "sql",
        kind: "document",
        target: { status: "available", target: { language: "sql", entryPoint: "script" } },
        hasError: false,
        sourceRange: rootRange,
        analysisSource: source,
        analysisIdentity: postgresAnalysisIdentity(source),
        projection: { kind: "identity", documentRange: rootRange, analysisRange: rootRange },
        children: [
          {
            id: plpgsqlId,
            language: "plpgsql",
            kind: "parser-injection",
            target: {
              status: "available",
              target: { language: "plpgsql", entryPoint: "block" },
            },
            hasError: false,
            sourceRange: plpgsqlRange,
            analysisSource: plpgsqlSource,
            analysisIdentity: postgresAnalysisIdentity(plpgsqlSource),
            projection: {
              kind: "identity",
              documentRange: plpgsqlRange,
              analysisRange: { start: 0, end: plpgsqlSource.length },
            },
            children: [
              {
                id: sqlId,
                language: "sql",
                kind: "embedded-sql",
                target: {
                  status: "available",
                  target: { language: "sql", entryPoint: "statement" },
                },
                hasError: sqlHasError,
                sourceRange: sqlRange,
                analysisSource: sqlSource,
                analysisIdentity: postgresAnalysisIdentity(sqlSource),
                projection: {
                  kind: "identity",
                  documentRange: sqlRange,
                  analysisRange: { start: 0, end: sqlSource.length },
                },
                children: [],
              },
            ],
          },
        ],
      },
      truncated: false,
    },
    scopes: [
      { id: rootId, regionId: rootId, language: "sql", kind: "language-region", range: rootRange },
      {
        id: plpgsqlId,
        regionId: plpgsqlId,
        language: "plpgsql",
        kind: "language-region",
        range: plpgsqlRange,
      },
      {
        id: sqlId,
        regionId: sqlId,
        language: "sql",
        kind: "language-region",
        range: sqlRange,
      },
    ],
    lexical: [],
    names: [],
  };
}

function facts(
  source: string,
  names: PostgresDocumentSyntaxFacts["names"],
): PostgresDocumentSyntaxFacts {
  const id = `sql:root:0-${source.length}`;
  const range = { start: 0, end: source.length };
  return {
    shape: {
      root: {
        id,
        language: "sql",
        kind: "document",
        target: { status: "available", target: { language: "sql", entryPoint: "script" } },
        hasError: false,
        sourceRange: range,
        analysisSource: source,
        analysisIdentity: postgresAnalysisIdentity(source),
        projection: { kind: "identity", documentRange: range, analysisRange: range },
        children: [],
      },
      truncated: false,
    },
    scopes: [{ id, regionId: id, language: "sql", kind: "language-region", range }],
    lexical: [],
    names,
  };
}

function relationFact(
  schema: string,
  name: string,
  alias: string,
  sourceLength: number,
): PostgresDocumentSyntaxFacts["names"][number] {
  const regionId = `sql:root:0-${sourceLength}`;
  return {
    role: "relation",
    regionId,
    language: "sql",
    scopeId: regionId,
    parts: [
      { written: schema, canonical: schema, range: { start: 15, end: 19 } },
      { written: name, canonical: name, range: { start: 20, end: 27 } },
    ],
    alias: { written: alias, canonical: alias, range: { start: 31, end: 32 } },
    range: { start: 15, end: 32 },
    visibility: [{ scopeId: regionId, range: { start: 0, end: sourceLength } }],
  };
}
