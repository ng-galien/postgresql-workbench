import { describe, expect, it } from "vitest";
import {
  originalPostgresCompletionSyntaxFacts,
  type PostgresCompletionSyntaxFacts,
} from "../analysis/completionProjection.js";
import type {
  PostgresBindingFact,
  PostgresCteFact,
  PostgresDocumentSyntaxFacts,
  PostgresRelationFact,
  PostgresSyntaxScope,
} from "../analysis/documentFacts.js";
import { postgresAnalysisIdentity } from "../analysis/postgresSyntax.js";
import type {
  AvailablePlpgsqlSyntaxExpectation,
  AvailablePostgresSqlSyntaxExpectation,
  PostgresSyntaxAuthority,
  PostgresSyntaxExpectationResult,
} from "../analysis/syntaxExpectations.js";
import type { SqlAuthoringSnapshot } from "../snapshot.js";
import { planPostgresCompletion } from "./completion.js";

const SNAPSHOT: SqlAuthoringSnapshot = {
  connectionId: "test",
  database: "demo",
  status: "available",
  revision: "1",
  generation: 1,
  foreignKeys: [],
  objects: [
    {
      connectionId: "test",
      database: "demo",
      schema: "shop",
      oid: 1,
      name: "address",
      kind: "table",
      signature: "address",
      parameters: [],
      columns: [{ name: "id", type: "bigint" }],
    },
    {
      connectionId: "test",
      database: "demo",
      schema: "shop",
      oid: 2,
      name: "archive_address",
      kind: "function",
      signature: "archive_address(bigint)",
      parameters: [{ name: "address_id", type: "bigint" }],
      columns: [],
    },
    {
      connectionId: "test",
      database: "demo",
      schema: "shop",
      oid: 3,
      name: "archive_address",
      kind: "procedure",
      signature: "archive_address(bigint)",
      parameters: [{ name: "address_id", type: "bigint" }],
      columns: [],
    },
  ],
};

const AUTHORITY: PostgresSyntaxAuthority = {
  postgresRef: "REL_18_4",
  generator: { name: "gnu-bison", version: "3.8.2" },
  grammarDigest: "grammar-sha256",
  scannerDigest: "scanner-sha256",
  keywordDigest: "keywords-sha256",
  predictorDigest: "predictor-sha256",
  projectionDigest: "projection-sha256",
};

const ROOT_SCOPE: PostgresSyntaxScope = {
  id: "sql:root:0-16",
  regionId: "sql:root:0-16",
  language: "sql",
  kind: "language-region",
  range: { start: 0, end: 16 },
};

const ROOT_SOURCE = " ".repeat(16);
const ROOT_IDENTITY = postgresAnalysisIdentity(ROOT_SOURCE);

function facts(
  scope: PostgresSyntaxScope = ROOT_SCOPE,
  names: PostgresDocumentSyntaxFacts["names"] = [],
): PostgresDocumentSyntaxFacts {
  const analysisSource = " ".repeat(scope.range.end - scope.range.start);
  return {
    shape: {
      root: {
        id: scope.regionId,
        language: scope.language,
        kind: "document",
        target: {
          status: "available",
          target:
            scope.language === "sql"
              ? { language: "sql", entryPoint: "script" }
              : { language: "plpgsql", entryPoint: "block" },
        },
        sourceRange: scope.range,
        analysisSource,
        analysisIdentity: postgresAnalysisIdentity(analysisSource),
        projection: {
          kind: "identity",
          documentRange: scope.range,
          analysisRange: scope.range,
        },
        children: [],
      },
      truncated: false,
    },
    scopes: [scope],
    lexical: [],
    names,
  };
}

function sqlExpectation(
  overrides: Partial<AvailablePostgresSqlSyntaxExpectation> = {},
): AvailablePostgresSqlSyntaxExpectation {
  return {
    status: "available",
    regionId: ROOT_SCOPE.regionId,
    target: { language: "sql", entryPoint: "script" },
    authority: AUTHORITY,
    analysisIdentity: ROOT_IDENTITY,
    analysisOffset: 16,
    replacementRange: { start: 14, end: 16 },
    fragment: { written: "ad", canonical: "ad", form: "unquoted-identifier" },
    keywords: [],
    slots: [],
    ...overrides,
  };
}

function plan(expectation: PostgresSyntaxExpectationResult, syntaxFacts = facts(), limit?: number) {
  return planPostgresCompletion({
    expectation,
    snapshot: SNAPSHOT,
    facts: completionFacts(syntaxFacts, expectation.regionId),
    ...(limit === undefined ? {} : { limit }),
  });
}

function completionFacts(
  syntaxFacts: PostgresDocumentSyntaxFacts,
  regionId: string,
): PostgresCompletionSyntaxFacts {
  const pending = [syntaxFacts.shape.root];
  while (pending.length > 0) {
    const region = pending.pop();
    if (region?.id === regionId) return originalPostgresCompletionSyntaxFacts(syntaxFacts, region);
    if (region) pending.push(...region.children);
  }
  return originalPostgresCompletionSyntaxFacts(syntaxFacts, syntaxFacts.shape.root);
}

describe("planPostgresCompletion", () => {
  it.each(["ambiguous", "unavailable"] as const)("fails closed when syntax is %s", (status) => {
    const expectation: PostgresSyntaxExpectationResult =
      status === "ambiguous"
        ? {
            status,
            regionId: ROOT_SCOPE.regionId,
            target: { language: "sql", entryPoint: "script" },
            reason: "parser-recovery",
          }
        : {
            status,
            regionId: ROOT_SCOPE.regionId,
            target: { language: "sql", entryPoint: "script" },
            reason: "provider-capability-missing",
          };

    expect(plan(expectation)).toMatchObject({ status, proposals: [], isIncomplete: false });
  });

  it("offers only provider-returned keywords with grammar provenance", () => {
    const result = plan(
      sqlExpectation({
        fragment: { written: "an", canonical: "an", form: "keyword" },
        keywords: [
          { language: "sql", kind: "keyword", label: "AND" },
          { language: "sql", kind: "keyword", label: "ANY" },
        ],
      }),
    );

    expect(result.proposals.map(({ label }) => label)).toEqual(["AND", "ANY"]);
    expect(result.proposals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: expect.objectContaining({ kind: "grammar-terminal", authority: AUTHORITY }),
        }),
      ]),
    );
  });

  it("resolves a SQL relation slot and preserves snapshot provenance and provider range", () => {
    const result = plan(
      sqlExpectation({
        slots: [{ language: "sql", slot: "relation", qualifier: [] }],
      }),
    );

    expect(result.proposals).toEqual([
      expect.objectContaining({
        kind: "relation",
        label: "address",
        insertion: { kind: "text", text: "shop.address" },
        documentReplacementRange: { start: 14, end: 16 },
        source: expect.objectContaining({
          kind: "catalog-object",
          slot: "relation",
          snapshot: expect.objectContaining({ revision: "1", generation: 1 }),
          object: expect.objectContaining({ oid: 1, kind: "table" }),
        }),
      }),
    ]);
  });

  it("keeps function and procedure slots distinct and returns a structured call", () => {
    const expectation = sqlExpectation({
      fragment: { written: "", canonical: "", form: "none" },
      slots: [
        {
          language: "sql",
          slot: "routine",
          invocation: "procedure",
          qualifier: [{ written: "shop", canonical: "shop", quoted: false }],
        },
      ],
    });

    expect(plan(expectation).proposals).toEqual([
      expect.objectContaining({
        kind: "routine",
        insertion: {
          kind: "call",
          callee: "archive_address",
          arguments: [{ placeholder: "address_id" }],
        },
        source: expect.objectContaining({
          object: expect.objectContaining({ kind: "procedure", oid: 3 }),
        }),
      }),
    ]);
  });

  it("matches quoted identifiers case-sensitively", () => {
    const quotedSnapshot: SqlAuthoringSnapshot = {
      ...SNAPSHOT,
      objects: [
        { ...SNAPSHOT.objects[0], oid: 10, name: "Address" },
        { ...SNAPSHOT.objects[0], oid: 11, name: "address" },
      ],
    };
    const expectation = sqlExpectation({
      fragment: { written: '"A', canonical: "A", form: "quoted-identifier" },
      slots: [{ language: "sql", slot: "relation", qualifier: [] }],
    });
    const result = planPostgresCompletion({
      expectation,
      snapshot: quotedSnapshot,
      facts: completionFacts(facts(), expectation.regionId),
    });

    expect(result.proposals.map(({ label }) => label)).toEqual(["Address"]);
  });

  it("resolves a PL/pgSQL variable from the derived scope without SQL catalog leakage", () => {
    const scope: PostgresSyntaxScope = {
      ...ROOT_SCOPE,
      id: "plpgsql:root:0-16",
      regionId: "plpgsql:root:0-16",
      language: "plpgsql",
    };
    const variable: PostgresBindingFact = {
      role: "binding",
      bindingKind: "variable",
      use: "declaration",
      readonly: false,
      regionId: scope.regionId,
      language: "plpgsql",
      scopeId: scope.id,
      range: { start: 0, end: 7 },
      parts: [{ written: "Balance", canonical: "Balance", range: { start: 0, end: 7 } }],
      visibility: [{ scopeId: scope.id, range: scope.range }],
    };
    const expectation: AvailablePlpgsqlSyntaxExpectation = {
      status: "available",
      regionId: scope.regionId,
      target: { language: "plpgsql", entryPoint: "block" },
      authority: AUTHORITY,
      analysisIdentity: ROOT_IDENTITY,
      analysisOffset: 11,
      replacementRange: { start: 10, end: 11 },
      fragment: { written: "B", canonical: "B", form: "quoted-identifier" },
      keywords: [{ language: "plpgsql", kind: "keyword", label: "RETURN" }],
      slots: [{ language: "plpgsql", slot: "variable", qualifier: [] }],
    };

    expect(plan(expectation, facts(scope, [variable])).proposals).toEqual([
      expect.objectContaining({
        kind: "variable",
        label: "Balance",
        source: expect.objectContaining({ language: "plpgsql", slot: "variable" }),
      }),
    ]);
  });

  it("declares truncation when an explicit policy limit is reached", () => {
    const result = plan(
      sqlExpectation({
        fragment: { written: "", canonical: "", form: "none" },
        keywords: [
          { language: "sql", kind: "keyword", label: "AND" },
          { language: "sql", kind: "keyword", label: "ANY" },
        ],
      }),
      facts(),
      1,
    );

    expect(result).toMatchObject({ isIncomplete: true });
    expect(result.proposals).toHaveLength(1);
  });

  it("projects an injected region replacement range into document coordinates", () => {
    const childScope: PostgresSyntaxScope = {
      id: "sql:child:100-120",
      regionId: "sql:child:100-120",
      language: "sql",
      kind: "language-region",
      range: { start: 100, end: 120 },
      parentId: ROOT_SCOPE.id,
    };
    const syntaxFacts: PostgresDocumentSyntaxFacts = {
      ...facts(),
      shape: {
        root: {
          ...facts().shape.root,
          sourceRange: { start: 0, end: 120 },
          projection: {
            kind: "identity",
            documentRange: { start: 0, end: 120 },
            analysisRange: { start: 0, end: 120 },
          },
          children: [
            {
              id: childScope.regionId,
              language: "sql",
              kind: "parser-injection",
              target: {
                status: "available",
                target: { language: "sql", entryPoint: "script" },
              },
              sourceRange: childScope.range,
              analysisSource: "AND                 ",
              analysisIdentity: postgresAnalysisIdentity("AND                 "),
              projection: {
                kind: "identity",
                documentRange: childScope.range,
                analysisRange: { start: 0, end: 20 },
              },
              children: [],
            },
          ],
        },
        truncated: false,
      },
      scopes: [{ ...ROOT_SCOPE, range: { start: 0, end: 120 } }, childScope],
    };
    const expectation = sqlExpectation({
      regionId: childScope.regionId,
      analysisIdentity: postgresAnalysisIdentity("AND                 "),
      analysisOffset: 3,
      replacementRange: { start: 0, end: 3 },
      fragment: { written: "AND", canonical: "and", form: "keyword" },
      keywords: [{ language: "sql", kind: "keyword", label: "AND" }],
    });

    const result = planPostgresCompletion({
      expectation,
      snapshot: SNAPSHOT,
      facts: completionFacts(syntaxFacts, expectation.regionId),
    });

    expect(result.proposals[0]?.documentReplacementRange).toEqual({ start: 100, end: 103 });
  });

  it("keeps the nearest shadowing declaration", () => {
    const outer = {
      ...ROOT_SCOPE,
      id: "plpgsql:outer",
      regionId: "plpgsql:root",
      language: "plpgsql" as const,
      range: { start: 0, end: 40 },
    };
    const inner: PostgresSyntaxScope = {
      ...outer,
      id: "plpgsql:inner",
      kind: "plpgsql-block",
      parentId: outer.id,
      range: { start: 10, end: 30 },
    };
    const binding = (scopeId: string, start: number): PostgresBindingFact => ({
      role: "binding",
      bindingKind: "variable",
      use: "declaration",
      readonly: false,
      regionId: outer.regionId,
      language: "plpgsql",
      scopeId,
      range: { start, end: start + 5 },
      parts: [{ written: "value", canonical: "value", range: { start, end: start + 5 } }],
      visibility: [
        {
          scopeId,
          range: scopeId === inner.id ? inner.range : outer.range,
        },
      ],
    });
    const syntaxFacts: PostgresDocumentSyntaxFacts = {
      ...facts(outer, [binding(outer.id, 1), binding(inner.id, 11)]),
      scopes: [outer, inner],
    };
    const expectation: AvailablePlpgsqlSyntaxExpectation = {
      status: "available",
      regionId: outer.regionId,
      target: { language: "plpgsql", entryPoint: "block" },
      authority: AUTHORITY,
      analysisIdentity: postgresAnalysisIdentity(" ".repeat(outer.range.end - outer.range.start)),
      analysisOffset: 20,
      replacementRange: { start: 20, end: 20 },
      fragment: { written: "", canonical: "", form: "none" },
      keywords: [],
      slots: [{ language: "plpgsql", slot: "variable", qualifier: [] }],
    };

    const result = planPostgresCompletion({
      expectation,
      snapshot: SNAPSHOT,
      facts: completionFacts(syntaxFacts, expectation.regionId),
    });

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.source).toMatchObject({
      kind: "local-name",
      fact: { scopeId: inner.id },
    });
  });

  it("derives alias visibility from facts even when FROM is after the caret", () => {
    const relation: PostgresRelationFact = {
      role: "relation",
      regionId: ROOT_SCOPE.regionId,
      language: "sql",
      scopeId: ROOT_SCOPE.id,
      range: { start: 10, end: 14 },
      parts: [{ written: "item", canonical: "item", range: { start: 10, end: 14 } }],
      alias: { written: "i", canonical: "i", range: { start: 15, end: 16 } },
      visibility: [{ scopeId: ROOT_SCOPE.id, range: ROOT_SCOPE.range }],
    };
    const expectation = sqlExpectation({
      analysisOffset: 3,
      replacementRange: { start: 3, end: 3 },
      fragment: { written: "", canonical: "", form: "none" },
      slots: [{ language: "sql", slot: "column", qualifier: [] }],
    });

    expect(plan(expectation, facts(ROOT_SCOPE, [relation])).proposals).toEqual([
      expect.objectContaining({
        kind: "alias",
        label: "i",
        triggerSuggestionsAfterInsert: true,
        source: expect.objectContaining({
          kind: "local-name",
          slot: "column",
          derivation: "relation-alias-stage",
        }),
      }),
    ]);
  });

  it("carries catalog column types into autonomous proposals", () => {
    const relation: PostgresRelationFact = {
      role: "relation",
      regionId: ROOT_SCOPE.regionId,
      language: "sql",
      scopeId: ROOT_SCOPE.id,
      range: { start: 1, end: 13 },
      parts: [
        { written: "shop", canonical: "shop", range: { start: 1, end: 5 } },
        { written: "address", canonical: "address", range: { start: 6, end: 13 } },
      ],
      alias: { written: "address", canonical: "address", range: { start: 6, end: 13 } },
      visibility: [{ scopeId: ROOT_SCOPE.id, range: ROOT_SCOPE.range }],
    };
    const expectation = sqlExpectation({
      analysisOffset: 16,
      replacementRange: { start: 16, end: 16 },
      fragment: { written: "", canonical: "", form: "none" },
      slots: [
        {
          language: "sql",
          slot: "column",
          qualifier: [{ written: "address", canonical: "address", quoted: false }],
        },
      ],
    });

    expect(plan(expectation, facts(ROOT_SCOPE, [relation])).proposals).toEqual([
      expect.objectContaining({ kind: "column", label: "id", detail: "bigint" }),
    ]);
  });

  it("uses grammar-produced window visibility before the WINDOW clause", () => {
    const window: PostgresDocumentSyntaxFacts["names"][number] = {
      role: "window",
      use: "declaration",
      regionId: ROOT_SCOPE.regionId,
      language: "sql",
      scopeId: ROOT_SCOPE.id,
      range: { start: 12, end: 13 },
      parts: [{ written: "w", canonical: "w", range: { start: 12, end: 13 } }],
      visibility: [{ scopeId: ROOT_SCOPE.id, range: ROOT_SCOPE.range }],
    };
    const expectation = sqlExpectation({
      analysisOffset: 3,
      replacementRange: { start: 3, end: 3 },
      fragment: { written: "", canonical: "", form: "none" },
      slots: [{ language: "sql", slot: "window", qualifier: [] }],
    });

    expect(plan(expectation, facts(ROOT_SCOPE, [window])).proposals).toEqual([
      expect.objectContaining({ kind: "window", label: "w" }),
    ]);
  });

  it("distinguishes recursive and non-recursive CTE visibility inside the owner body", () => {
    const cte = (name: string, recursive: boolean, visibilityStart: number): PostgresCteFact => ({
      role: "cte",
      use: "declaration",
      recursive,
      regionId: ROOT_SCOPE.regionId,
      language: "sql",
      scopeId: ROOT_SCOPE.id,
      range: { start: 1, end: 1 + name.length },
      parts: [{ written: name, canonical: name, range: { start: 1, end: 1 + name.length } }],
      visibility: [
        { scopeId: ROOT_SCOPE.id, range: { start: visibilityStart, end: ROOT_SCOPE.range.end } },
      ],
    });
    const expectation = sqlExpectation({
      analysisOffset: 8,
      replacementRange: { start: 8, end: 8 },
      fragment: { written: "", canonical: "", form: "none" },
      slots: [{ language: "sql", slot: "cte", qualifier: [] }],
    });

    const syntaxFacts = facts(ROOT_SCOPE, [cte("plain", false, 12), cte("recursive", true, 0)]);
    expect(plan(expectation, syntaxFacts).proposals.map(({ label }) => label)).toEqual([
      "recursive",
    ]);
  });

  it("rejects expectations produced for a different immutable source", () => {
    const expectation = sqlExpectation({
      analysisIdentity: postgresAnalysisIdentity("different source"),
    });

    expect(plan(expectation)).toMatchObject({
      status: "unavailable",
      reason: "analysis-identity-mismatch",
      proposals: [],
    });
  });

  it("honors CTE declaration order at the caret", () => {
    const cte = (name: string, start: number): PostgresCteFact => ({
      role: "cte",
      use: "declaration",
      recursive: false,
      regionId: ROOT_SCOPE.regionId,
      language: "sql",
      scopeId: ROOT_SCOPE.id,
      range: { start, end: start + name.length },
      parts: [{ written: name, canonical: name, range: { start, end: start + name.length } }],
      visibility: [
        {
          scopeId: ROOT_SCOPE.id,
          range: { start: start + name.length, end: ROOT_SCOPE.range.end },
        },
      ],
    });
    const syntaxFacts = facts(ROOT_SCOPE, [cte("first", 1), cte("later", 14)]);
    const expectation = sqlExpectation({
      analysisOffset: 10,
      replacementRange: { start: 10, end: 10 },
      fragment: { written: "", canonical: "", form: "none" },
      slots: [{ language: "sql", slot: "cte", qualifier: [] }],
    });

    expect(plan(expectation, syntaxFacts).proposals.map(({ label }) => label)).toEqual(["first"]);
  });

  it("ranks local names before applying the explicit limit", () => {
    const relation: PostgresRelationFact = {
      role: "relation",
      regionId: ROOT_SCOPE.regionId,
      language: "sql",
      scopeId: ROOT_SCOPE.id,
      range: { start: 1, end: 13 },
      parts: [
        { written: "shop", canonical: "shop", range: { start: 1, end: 5 } },
        { written: "address", canonical: "address", range: { start: 6, end: 13 } },
      ],
      alias: { written: "a", canonical: "a", range: { start: 14, end: 15 } },
      visibility: [{ scopeId: ROOT_SCOPE.id, range: ROOT_SCOPE.range }],
    };
    const expectation = sqlExpectation({
      analysisOffset: 16,
      fragment: { written: "", canonical: "", form: "none" },
      slots: [
        { language: "sql", slot: "relation", qualifier: [] },
        { language: "sql", slot: "alias", qualifier: [] },
      ],
    });

    const result = plan(expectation, facts(ROOT_SCOPE, [relation]), 1);
    expect(result).toMatchObject({ status: "available", isIncomplete: true });
    expect(result.proposals[0]).toMatchObject({ kind: "alias", label: "a", rankGroup: 0 });
  });
});
