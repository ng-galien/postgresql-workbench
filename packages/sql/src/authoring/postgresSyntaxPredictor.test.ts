import { describe, expect, it } from "vitest";
import type {
  PlpgsqlSyntaxTarget,
  PostgresSqlSyntaxTarget,
  PostgresSyntaxTarget,
} from "../analysis/postgresSyntax.js";
import { postgresAnalysisIdentity } from "../analysis/postgresSyntax.js";
import {
  DEFAULT_POSTGRES_SYNTAX_PREDICTION_BUDGET,
  type PostgresSyntaxExpectationRequestFor,
} from "../analysis/syntaxExpectations.js";
import { predictPostgresSyntax } from "./postgresSyntaxPredictor.js";

describe("TypeScript PostgreSQL grammar predictor", () => {
  it("derives top-level SQL keywords from the official grammar", () => {
    const prediction = available(sql(""));

    expect(labels(prediction)).toContain("SELECT");
    expect(labels(prediction)).toContain("INSERT");
    expect(labels(prediction)).not.toContain("ZONE");
  });

  it("does not expose identifier-only SQL keywords", () => {
    const prediction = available(sql("SELECT "));

    expect(labels(prediction)).toContain("CASE");
    expect(labels(prediction)).not.toContain("ABORT");
    expect(prediction.slots).toContainEqual({ language: "sql", slot: "column", qualifier: [] });
  });

  it("projects column, relation, procedure, and type slots from grammar states", () => {
    expect(slots(sql("SELECT "))).toContain("column");
    expect(slots(sql("SELECT * FROM "))).toContain("relation");
    expect(available(sql("CALL ")).slots).toContainEqual({
      language: "sql",
      slot: "routine",
      invocation: "procedure",
      qualifier: [],
    });
    expect(slots(sql("CREATE TABLE item (id "))).toContain("type");
  });

  it("preserves a qualified SQL completion prefix", () => {
    const prediction = available(sql("SELECT * FROM public."));

    expect(prediction.target.language).toBe("sql");
    if (prediction.target.language !== "sql") throw new Error("expected SQL prediction");
    expect(prediction.slots).toContainEqual({
      language: "sql",
      slot: "relation",
      qualifier: [{ written: "public", canonical: "public", quoted: false }],
    });
  });

  it.each([
    ["SELECT item.", "column", ["item"]],
    ["SELECT between.", "column", ["between"]],
    ["SELECT schema.select.", "column", ["schema", "select"]],
    ["WITH q AS (SELECT * FROM public.", "relation", ["public"]],
  ] as const)("projects the qualified grammar role in %s", (source, slot, qualifier) => {
    const prediction = available(sql(source));
    expect(prediction.target.language).toBe("sql");
    if (prediction.target.language !== "sql") throw new Error("expected SQL prediction");
    expect(prediction.slots).toContainEqual({
      language: "sql",
      slot,
      qualifier: qualifier.map((canonical) => ({ written: canonical, canonical, quoted: false })),
    });
  });

  it("rejects a qualified name whose root cannot be a PostgreSQL ColId", () => {
    expect(predictPostgresSyntax(sql("SELECT select.foo."))).toMatchObject({
      status: "ambiguous",
      reason: "parser-recovery",
    });
  });

  it("removes the active fragment before predicting and replaces the complete word", () => {
    const prefix = available(sql("SEL"));
    expect(prefix.fragment).toEqual({
      written: "SEL",
      canonical: "sel",
      form: "unquoted-identifier",
    });
    expect(prefix.replacementRange).toEqual({ start: 0, end: 3 });
    expect(labels(prefix)).toContain("SELECT");

    const middle = available(sql("SELxECT", 3));
    expect(middle.fragment.written).toBe("SELxECT");
    expect(middle.replacementRange).toEqual({ start: 0, end: 7 });
  });

  it("does not consume a lookahead-remapped keyword beyond the caret", () => {
    const source = "SELECT 1 NOT IN (1)";
    const offset = "SELECT 1 NO".length;
    const prediction = available(sql(source, offset));

    expect(prediction.fragment.written).toBe("NO");
    expect(prediction.replacementRange).toEqual({ start: "SELECT 1 ".length, end: offset });
  });

  it("ignores lexical errors strictly after the caret", () => {
    const source = 'SELECT 1 FROM "unterminated';
    const prediction = available(sql(source, "SELECT 1 FROM ".length));
    expect(prediction.target.language).toBe("sql");
    if (prediction.target.language !== "sql") throw new Error("expected SQL prediction");
    expect(prediction.slots).toContainEqual({ language: "sql", slot: "relation", qualifier: [] });
  });

  it.each([
    ['SELECT * FROM "Mixed Case"', "Mixed Case", '"Mixed Case"'],
    ['SELECT * FROM "Mix', "Mix", '"Mix'],
  ])("preserves PostgreSQL quoted identifier spelling in %s", (source, canonical, written) => {
    const prediction = available(sql(source));
    expect(prediction.fragment).toMatchObject({ form: "quoted-identifier", canonical, written });
    expect(prediction.replacementRange.end).toBe(source.length);
  });

  it("rejects an invalid Unicode UESCAPE character", () => {
    expect(predictPostgresSyntax(sql(`SELECT U&"d\\0061t" UESCAPE 'xx'`))).toMatchObject({
      status: "ambiguous",
      reason: "lexical-ambiguity",
    });
  });

  it("stops at the caller-owned token budget", () => {
    const prediction = predictPostgresSyntax({
      ...sql("SELECT one, two FROM three"),
      budget: { ...DEFAULT_POSTGRES_SYNTAX_PREDICTION_BUDGET, maxTokens: 2 },
    });
    expect(prediction).toMatchObject({ status: "unavailable", reason: "truncated" });
  });

  it("keeps a single statement distinct from a script", () => {
    expect(
      predictPostgresSyntax({
        ...sql("SELECT 1; "),
        target: { language: "sql", entryPoint: "statement" },
      }),
    ).toEqual({
      status: "unavailable",
      regionId: "sql:test",
      target: { language: "sql", entryPoint: "statement" },
      reason: "unsupported-entry-point",
    });
  });

  it("uses PostgreSQL lookahead remapping", () => {
    const prediction = available(sql("SELECT 1 IS NOT "));
    expect(labels(prediction)).toContain("NULL");
    expect(labels(prediction)).toContain("DISTINCT");
  });

  it("enters the SQL-expression grammar independently", () => {
    const prediction = available({
      ...sql("price * "),
      target: { language: "sql", entryPoint: "expression" },
    });
    expect(prediction.target).toEqual({ language: "sql", entryPoint: "expression" });
    expect(prediction.slots).toContainEqual({ language: "sql", slot: "column", qualifier: [] });
  });

  it("uses the separate PL/pgSQL grammar and fails closed at SQL-consuming reductions", () => {
    const root = available(plpgsql(""));
    expect(labels(root)).toContain("BEGIN");
    expect(labels(root)).toContain("DECLARE");
    expect(labels(root)).not.toContain("SELECT");

    const body = available(plpgsql("BEGIN "));
    expect(labels(body)).toContain("IF");
    expect(labels(body)).toContain("RETURN");
    expect(labels(body)).toContain("PERFORM");

    const fragment = available(plpgsql("BEG"));
    expect(fragment.fragment).toMatchObject({ written: "BEG", canonical: "beg" });
    expect(labels(fragment)).toContain("BEGIN");

    expect(predictPostgresSyntax(plpgsql("BEGIN worker"))).toMatchObject({
      status: "ambiguous",
      reason: "non-local-state",
    });
    expect(predictPostgresSyntax(plpgsql("BEGIN IF "))).toMatchObject({
      status: "ambiguous",
      reason: "non-local-state",
    });
  });
});

function sql(
  source: string,
  offset = source.length,
): PostgresSyntaxExpectationRequestFor<PostgresSqlSyntaxTarget> {
  return request(source, offset, { language: "sql", entryPoint: "script" });
}

function plpgsql(
  source: string,
  offset = source.length,
): PostgresSyntaxExpectationRequestFor<PlpgsqlSyntaxTarget> {
  return request(source, offset, { language: "plpgsql", entryPoint: "block" });
}

function request<TTarget extends PostgresSyntaxTarget>(
  source: string,
  offset: number,
  target: TTarget,
): PostgresSyntaxExpectationRequestFor<TTarget> {
  return {
    regionId: `${target.language}:test`,
    target,
    dialect: { postgresMajor: 18 },
    budget: DEFAULT_POSTGRES_SYNTAX_PREDICTION_BUDGET,
    analysisSource: source,
    analysisIdentity: postgresAnalysisIdentity(source),
    analysisOffset: offset,
  };
}

function available<TTarget extends PostgresSyntaxTarget>(
  request: PostgresSyntaxExpectationRequestFor<TTarget>,
) {
  const prediction = predictPostgresSyntax(request);
  expect(prediction.status).toBe("available");
  if (prediction.status !== "available") throw new Error(JSON.stringify(prediction));
  return prediction;
}

function labels(prediction: ReturnType<typeof available>): string[] {
  return prediction.keywords.map((keyword) => keyword.label);
}

function slots<TTarget extends PostgresSyntaxTarget>(
  request: PostgresSyntaxExpectationRequestFor<TTarget>,
): string[] {
  const prediction = available(request);
  return prediction.slots.map((slot) => slot.slot);
}
